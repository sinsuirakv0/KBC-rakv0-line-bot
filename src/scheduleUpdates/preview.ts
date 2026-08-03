import {
	fetchCsvMap,
	fetchItemNameData,
	fetchText,
	formatDateShort,
	parseDate,
	type TimeBlock,
} from "../commands/shared.js";
import { formatAmount } from "../commands/eventDisplay.js";
import { isMissionEventId, missionLookupId } from "../search/eventIdClassification.js";

const EVENT_REPO_TREE_API =
	"https://api.github.com/repos/sinsuirakv0/KBC-rakv0-event/git/trees/main?recursive=1";
const EVENT_SITE_URL = process.env.EVENT_SITE_URL ?? "https://kbc-rakv0-event.vercel.app/";
const HISTORY_GROUP_SEC = 120;
const EVENT_TYPES = ["gatya", "sale", "item"] as const;
const GATYA_ITEM_GIFT_TYPES = new Set([301, 302]);

export type EventTsvType = typeof EVENT_TYPES[number];
export type ScheduleUpdateSectionType = "gatya" | "sale" | "item" | "mission";

interface GitTreeEntry {
	path: string;
}

interface RawHistoryFile {
	type: EventTsvType;
	unix: number;
}

interface EventHeader {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	minVersion: string;
	maxVersion: string;
}

interface GachaEntry {
	id: number;
	flags: number;
	guaranteed: boolean;
}

interface GachaBlock {
	header: EventHeader & { gachaType: number };
	gachas: GachaEntry[];
	raw: string;
}

interface SaleEntry {
	header: EventHeader;
	timeBlocks: TimeBlock[];
	stageIds: number[];
	raw: string;
}

interface ItemEntry {
	header: EventHeader;
	timeBlocks: TimeBlock[];
	gift: {
		eventId: number;
		giftType: number;
		giftAmount: number;
		title: string;
		message: string;
		url: string;
		repeatFlag: number;
	};
	raw: string;
}

interface NameMaps {
	gatya: {
		rare: Map<number, string>;
		event: Map<number, string>;
		normal: Map<number, string>;
	};
	sale: Map<number, string>;
	mission: Map<number, string>;
	item: Map<number, string>;
}

export interface ScheduleUpdateSection {
	type: ScheduleUpdateSectionType;
	text: string;
	count: number;
}

export interface ScheduleUpdatePreview {
	historyUnix: number;
	historyUrl: string;
	sourceTypes: EventTsvType[];
	sections: ScheduleUpdateSection[];
}

export type EventTsvTextByType = Partial<Record<EventTsvType, string>>;

export interface ScheduleUpdatePreviewInput {
	historyUnix: number;
	current: EventTsvTextByType;
	previous: EventTsvTextByType;
}

function buildHistoryUrl(unix: number): string {
	const url = new URL(EVENT_SITE_URL);
	url.searchParams.set("tab", "history");
	url.searchParams.set("tsv", String(unix));
	url.searchParams.set("type", "all");
	return url.toString();
}

function parseRawHistoryFile(path: string): RawHistoryFile | undefined {
	const match = path.match(/^raw\/(gatya|sale|item)_(\d+)\.tsv$/);
	if (!match) return undefined;
	return { type: match[1] as EventTsvType, unix: Number(match[2]) };
}

async function fetchRawHistoryFiles(): Promise<RawHistoryFile[]> {
	const response = await fetch(EVENT_REPO_TREE_API, {
		signal: AbortSignal.timeout(10_000),
		headers: {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "KBC-rakv0-line-bot",
		},
	});
	if (!response.ok) throw new Error(`GitHub履歴取得失敗: HTTP ${response.status}`);

	const body = await response.json() as { tree?: GitTreeEntry[]; truncated?: boolean };
	if (body.truncated) throw new Error("GitHub履歴一覧が大きすぎるため取得できません");
	return (body.tree ?? [])
		.flatMap((entry) => {
			const parsed = parseRawHistoryFile(entry.path);
			return parsed ? [parsed] : [];
		})
		.filter((entry) => Number.isSafeInteger(entry.unix) && entry.unix > 0);
}

export async function fetchPreviousEventTsv(
	beforeUnix: number,
	types: readonly EventTsvType[] = EVENT_TYPES,
): Promise<EventTsvTextByType> {
	const files = await fetchRawHistoryFiles();
	const selected = types.flatMap((type) => {
		const file = files
			.filter((candidate) => candidate.type === type && candidate.unix < beforeUnix)
			.sort((left, right) => right.unix - left.unix)[0];
		return file ? [file] : [];
	});
	const entries = await Promise.all(selected.map(async (file) => [
		file.type,
		await fetchText(`raw/${file.type}_${file.unix}.tsv`, 0),
	] as const));
	return Object.fromEntries(entries) as EventTsvTextByType;
}

function selectHistoryFiles(
	files: RawHistoryFile[],
	requestedUnix?: number,
): { historyUnix: number; current: RawHistoryFile[]; previous: Map<EventTsvType, RawHistoryFile> } {
	const historyUnix = requestedUnix ?? Math.max(...files.map((file) => file.unix));
	if (!Number.isSafeInteger(historyUnix) || historyUnix <= 0) {
		throw new Error("対象の履歴時刻を決定できません");
	}

	const currentByType = new Map<EventTsvType, RawHistoryFile>();
	for (const file of files) {
		if (file.unix > historyUnix || historyUnix - file.unix > HISTORY_GROUP_SEC) continue;
		const current = currentByType.get(file.type);
		if (!current || current.unix < file.unix) currentByType.set(file.type, file);
	}
	if (currentByType.size === 0) throw new Error(`Unix時刻 ${historyUnix} の履歴が見つかりません`);

	const current = EVENT_TYPES.flatMap((type) => {
		const file = currentByType.get(type);
		return file ? [file] : [];
	});
	const previous = new Map<EventTsvType, RawHistoryFile>();
	for (const file of current) {
		const earlier = files
			.filter((candidate) => candidate.type === file.type && candidate.unix < file.unix)
			.sort((left, right) => right.unix - left.unix)[0];
		if (earlier) previous.set(file.type, earlier);
	}
	return { historyUnix, current, previous };
}

function parseGatyaTsv(tsv: string): GachaBlock[] {
	const results: GachaBlock[] = [];
	for (const line of tsv.trim().split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "[start]" || trimmed === "[end]") continue;
		const cells = trimmed.split("\t");
		if (cells.length < 10) continue;

		const gachaCount = Number(cells[9]);
		if (!Number.isSafeInteger(gachaCount) || gachaCount < 0) continue;
		const header = {
			startDate: cells[0],
			startTime: cells[1],
			endDate: cells[2],
			endTime: cells[3],
			minVersion: cells[4],
			maxVersion: cells[5],
			gachaType: Number(cells[8]),
		};
		let offset = 10;
		const blocks: string[][] = [];
		for (let index = 0; index < gachaCount; index++) {
			while (offset < cells.length && cells[offset] === "") offset++;
			blocks.push(cells.slice(offset, offset + 15));
			offset += 15;
		}
		const gachas = blocks.flatMap((block) => {
			const id = Number(block[0]);
			if (!Number.isFinite(id) || id === -1) return [];
			return [{
				id,
				flags: Number(block[3]) || 0,
				guaranteed: Number(block[11]) === 1,
			}];
		});
		results.push({ header, gachas, raw: trimmed });
	}
	return results;
}

function decodeWeekdays(bitmask: number): string[] {
	if (!bitmask) return [];
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	return days.filter((_, index) => (bitmask >> index) & 1);
}

function parseTimeBlocks(parts: string[], startIndex: number): { timeBlocks: TimeBlock[]; nextIndex: number } {
	let index = startIndex;
	const timeBlockCount = Number.parseInt(parts[index++] ?? "0", 10);
	const timeBlocks: TimeBlock[] = [];
	for (let blockIndex = 0; blockIndex < timeBlockCount; blockIndex++) {
		const block: TimeBlock = { dateRanges: [], monthDays: [], weekdays: [], timeRanges: [] };
		const yearCount = Number.parseInt(parts[index++] ?? "0", 10);
		for (let yearIndex = 0; yearIndex < yearCount; yearIndex++) {
			block.dateRanges.push({
				start: `${parts[index++] ?? ""} ${parts[index++] ?? ""}`.trim(),
				end: `${parts[index++] ?? ""} ${parts[index++] ?? ""}`.trim(),
			});
		}
		const monthCount = Number.parseInt(parts[index++] ?? "0", 10);
		for (let monthIndex = 0; monthIndex < monthCount; monthIndex++) {
			const day = Number.parseInt(parts[index++] ?? "", 10);
			if (Number.isSafeInteger(day)) block.monthDays.push(day);
		}
		block.weekdays = decodeWeekdays(Number.parseInt(parts[index++] ?? "0", 10));
		const timeRangeCount = Number.parseInt(parts[index++] ?? "0", 10);
		for (let timeIndex = 0; timeIndex < timeRangeCount; timeIndex++) {
			block.timeRanges.push([parts[index++] ?? "", parts[index++] ?? ""]);
		}
		timeBlocks.push(block);
	}
	return { timeBlocks, nextIndex: index };
}

function parseSaleTsv(tsv: string): SaleEntry[] {
	return tsv.trim().split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && line !== "[start]" && line !== "[end]")
		.flatMap((raw) => {
			const parts = raw.split("\t").filter((cell) => cell !== "");
			if (parts.length < 8) return [];
			const header: EventHeader = {
				startDate: parts[0],
				startTime: parts[1],
				endDate: parts[2],
				endTime: parts[3],
				minVersion: parts[4],
				maxVersion: parts[5],
			};
			const { timeBlocks, nextIndex } = parseTimeBlocks(parts, 7);
			const stageCount = Number.parseInt(parts[nextIndex] ?? "0", 10);
			const stageIds = parts.slice(nextIndex + 1, nextIndex + 1 + stageCount)
				.map(Number)
				.filter(Number.isSafeInteger);
			return [{ header, timeBlocks, stageIds, raw }];
		});
}

function parseItemTsv(tsv: string): ItemEntry[] {
	return tsv.trim().split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && line !== "[start]" && line !== "[end]")
		.flatMap((raw) => {
			const parts = raw.split("\t");
			if (parts.length < 8) return [];
			const header: EventHeader = {
				startDate: parts[0],
				startTime: parts[1],
				endDate: parts[2],
				endTime: parts[3],
				minVersion: parts[4],
				maxVersion: parts[5],
			};
			const { timeBlocks, nextIndex } = parseTimeBlocks(parts, 7);
			const remaining = parts.slice(nextIndex);
			const gift = {
				eventId: Number.parseInt(remaining[0] ?? "0", 10) || 0,
				giftType: Number.parseInt(remaining[1] ?? "0", 10) || 0,
				giftAmount: Number.parseInt(remaining[2] ?? "0", 10) || 0,
				title: "",
				message: "",
				url: "",
				repeatFlag: Number.parseInt(remaining[7] ?? "0", 10) || 0,
			};
			const rawTitle = remaining[3] ?? "";
			const rawMessageUrl = remaining[4] ?? "";
			if (rawMessageUrl.startsWith("http")) {
				gift.title = rawTitle;
				gift.url = rawMessageUrl;
			} else if (rawTitle.startsWith("http")) {
				gift.url = rawTitle;
			} else {
				gift.title = rawTitle;
				gift.message = rawMessageUrl;
			}
			return [{ header, timeBlocks, gift, raw }];
		});
}

function addedRows<T extends { raw: string }>(current: T[], previous: T[]): T[] {
	const previousRows = new Set(previous.map((entry) => entry.raw));
	return current.filter((entry) => !previousRows.has(entry.raw));
}

function isDisplayable(header: EventHeader, referenceAt: Date): boolean {
	if (header.endDate === "20300101") return true;
	return parseDate(header.endDate, header.endTime) > referenceAt;
}

function formatScheduleDate(date: Date): string {
	const text = formatDateShort(date);
	const separator = text.lastIndexOf(" ");
	if (separator === -1) return text;
	const datePart = text.slice(0, separator);
	const timePart = text.slice(separator + 1);
	return timePart === "11:00" ? datePart : text;
}

function formatPeriod(header: EventHeader): string {
	const start = parseDate(header.startDate, header.startTime);
	const end = parseDate(header.endDate, header.endTime);
	return `${formatScheduleDate(start)} ~ ${formatScheduleDate(end)}`;
}

function gachaName(block: GachaBlock, gacha: GachaEntry, names: NameMaps["gatya"]): string {
	const nameMap = block.header.gachaType === 0
		? names.normal
		: block.header.gachaType === 4
			? names.event
			: names.rare;
	const flags = block.header.gachaType === 0 ? " ＜ノーマル＞"
		: block.header.gachaType === 4 ? " ＜イベント＞"
			: "";
	const guaranteed = gacha.guaranteed
		? block.header.gachaType === 4 ? " ＜確定枠あり＞" : " ＜確定＞"
		: "";
	const bonus = gacha.flags === 4 ? " 【step up】"
		: gacha.flags === 20_600 ? " ＋福引＆かけら"
			: gacha.flags === 16_384 ? " ＋かけら"
				: gacha.flags === 4_216 ? " ＋福引" : "";
	return `${gacha.id} ${nameMap.get(gacha.id) ?? `ID:${gacha.id}`}${flags}${guaranteed}${bonus}`;
}

function splitMissionText(value: string): string {
	const text = value.replace(/<br\s*\/?>/gi, "\n").trim();
	const separator = text.search(/[,，]/);
	return separator === -1 ? text : text.slice(0, separator).trim();
}

function nameForSaleId(id: number, names: NameMaps): string {
	if (!isMissionEventId(id)) return names.sale.get(id) ?? `ID:${id}`;
	return splitMissionText(names.mission.get(missionLookupId(id)) ?? `ID:${id}`);
}

function itemName(entry: ItemEntry, names: NameMaps): string {
	const title = entry.gift.title.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
	return title || names.item.get(entry.gift.giftType) || `giftType:${entry.gift.giftType}`;
}

interface DisplayRow {
	start: Date;
	period: string;
	line: string;
}

function formatSection(type: ScheduleUpdateSectionType, rows: DisplayRow[]): ScheduleUpdateSection | undefined {
	if (rows.length === 0) return undefined;
	const uniqueRows = new Map<string, DisplayRow>();
	for (const row of rows) uniqueRows.set(`${row.period}|${row.line}`, row);
	const ordered = [...uniqueRows.values()].sort((left, right) =>
		left.start.getTime() - right.start.getTime() || left.line.localeCompare(right.line, "ja"),
	);
	const lines: string[] = [type];
	let lastPeriod = "";
	for (const row of ordered) {
		if (row.period !== lastPeriod) {
			lines.push("", row.period);
			lastPeriod = row.period;
		}
		lines.push(`・${row.line}`);
	}
	return { type, text: lines.join("\n"), count: ordered.length };
}

async function loadNames(types: EventTsvType[]): Promise<NameMaps> {
	const needGatya = types.includes("gatya");
	const needSale = types.includes("sale");
	const needItem = types.includes("item");
	const [rare, event, normal, sale, mission, item] = await Promise.all([
		needGatya ? fetchCsvMap("data/gatya_name.csv") : Promise.resolve(new Map<number, string>()),
		needGatya ? fetchCsvMap("data/gatya_e_name.csv") : Promise.resolve(new Map<number, string>()),
		needGatya ? fetchCsvMap("data/gatya_n_name.csv") : Promise.resolve(new Map<number, string>()),
		needSale ? fetchCsvMap("data/sale_name.csv") : Promise.resolve(new Map<number, string>()),
		needSale ? fetchCsvMap("data/Mission_Name.csv") : Promise.resolve(new Map<number, string>()),
		needItem ? fetchItemNameData("data/item_name.csv").then((data) => data.names) : Promise.resolve(new Map<number, string>()),
	]);
	return { gatya: { rare, event, normal }, sale, mission, item };
}

export async function buildScheduleUpdatePreviewFromTsv(
	input: ScheduleUpdatePreviewInput,
): Promise<ScheduleUpdatePreview> {
	const historyUnix = input.historyUnix;
	if (!Number.isSafeInteger(historyUnix) || historyUnix <= 0) {
		throw new Error("履歴Unix時刻が不正です");
	}
	const referenceAt = new Date(historyUnix * 1_000);
	const sourceTypes = EVENT_TYPES.filter((type) =>
		typeof input.current[type] === "string" && input.current[type] !== input.previous[type]
	);
	const texts = sourceTypes.map((type) => ({
		type,
		current: input.current[type] ?? "",
		previous: input.previous[type] ?? "",
	}));
	const names = await loadNames(sourceTypes);
	const rows: Record<ScheduleUpdateSectionType, DisplayRow[]> = {
		gatya: [],
		sale: [],
		item: [],
		mission: [],
	};

	for (const text of texts) {
		if (text.type === "gatya") {
			for (const block of addedRows(parseGatyaTsv(text.current), parseGatyaTsv(text.previous))) {
				if (!isDisplayable(block.header, referenceAt) || block.header.gachaType === 2 || block.header.gachaType === 3) continue;
				const start = parseDate(block.header.startDate, block.header.startTime);
				const period = formatPeriod(block.header);
				for (const gacha of block.gachas) {
					rows.gatya.push({ start, period, line: gachaName(block, gacha, names.gatya) });
				}
			}
			continue;
		}

		if (text.type === "sale") {
			for (const entry of addedRows(parseSaleTsv(text.current), parseSaleTsv(text.previous))) {
				if (!isDisplayable(entry.header, referenceAt)) continue;
				const start = parseDate(entry.header.startDate, entry.header.startTime);
				const period = formatPeriod(entry.header);
				for (const id of entry.stageIds) {
					const type = isMissionEventId(id) ? "mission" : "sale";
					rows[type].push({ start, period, line: `${id} ${nameForSaleId(id, names)}` });
				}
			}
			continue;
		}

		for (const entry of addedRows(parseItemTsv(text.current), parseItemTsv(text.previous))) {
			if (!isDisplayable(entry.header, referenceAt)) continue;
			const start = parseDate(entry.header.startDate, entry.header.startTime);
			const category = GATYA_ITEM_GIFT_TYPES.has(entry.gift.giftType) ? "gatya" : "item";
			const line = category === "gatya"
				? `${entry.gift.giftType} ${itemName(entry, names)}${formatAmount(entry.gift.giftAmount)} ＜gatya_item＞`
				: `${entry.gift.giftType} ${itemName(entry, names)}${formatAmount(entry.gift.giftAmount)} / eventId:${entry.gift.eventId}`;
			rows[category].push({ start, period: formatPeriod(entry.header), line });
		}
	}

	const sections = (["gatya", "sale", "item", "mission"] as const)
		.flatMap((type) => {
			const section = formatSection(type, rows[type]);
			return section ? [section] : [];
		});
	return {
		historyUnix,
		historyUrl: buildHistoryUrl(historyUnix),
		sourceTypes,
		sections,
	};
}

export async function buildScheduleUpdatePreview(requestedUnix?: number): Promise<ScheduleUpdatePreview> {
	const files = await fetchRawHistoryFiles();
	if (files.length === 0) throw new Error("履歴TSVが見つかりません");
	const selected = selectHistoryFiles(files, requestedUnix);
	const pairs = await Promise.all(selected.current.map(async (file) => {
		const previousFile = selected.previous.get(file.type);
		return {
			type: file.type,
			current: await fetchText(`raw/${file.type}_${file.unix}.tsv`, 0),
			previous: previousFile
				? await fetchText(`raw/${file.type}_${previousFile.unix}.tsv`, 0)
				: "",
		};
	}));
	return buildScheduleUpdatePreviewFromTsv({
		historyUnix: selected.historyUnix,
		current: Object.fromEntries(pairs.map((pair) => [pair.type, pair.current])) as EventTsvTextByType,
		previous: Object.fromEntries(pairs.map((pair) => [pair.type, pair.previous])) as EventTsvTextByType,
	});
}
