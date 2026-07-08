import type { LineCommand, TimeBlock } from "./shared.js";
import {
	fetchCsvMap,
	fetchItemNameData,
	fetchJson,
	formatDateShort,
	isExactInteger,
	parseDate,
	sendError,
	sendLong,
	type ItemNameData,
} from "./shared.js";
import {
	cleanDetailLines,
	formatAmount,
	formatEventPeriod,
	formatEventPeriodShort,
	formatEventStatus,
	formatIdBand,
	formatTimeBlockLines,
	formatVersionRange,
	joinBlocks,
	type EventHeader,
} from "./eventDisplay.js";

type Mode = "R" | "E" | "N";

interface GachaRate {
	normal: number;
	rare: number;
	superRare: number;
	uberRare: number;
	legendRare: number;
	featured?: number;
}

interface GachaEntry {
	id: number;
	price: number;
	flags: number;
	rates: GachaRate;
	guaranteed: boolean;
	message?: string;
}

interface GachaHeader extends EventHeader {
	gachaType: number;
	gachaCount: number;
}

interface GachaBlock {
	header: GachaHeader;
	gachas: GachaEntry[];
	raw?: string;
}

interface GachaJson {
	updatedAt: string;
	data: GachaBlock[];
}

interface GatyaItemGift {
	eventId: number;
	giftType: number;
	giftAmount: number;
	title: string;
	message: string;
	url: string;
	repeatFlag: number;
}

interface GatyaItemEntry {
	header: EventHeader;
	timeBlocks: TimeBlock[];
	gift: GatyaItemGift;
	raw?: string;
}

interface ItemJson {
	updatedAt: string;
	data: GatyaItemEntry[];
}

interface CsvSet {
	rare: Map<number, string>;
	event: Map<number, string>;
	normal: Map<number, string>;
}

interface GatyaData {
	json: GachaJson;
	csv: CsvSet;
	itemJson: ItemJson;
	itemNames: ItemNameData;
}

interface ScheduleRow {
	start: Date;
	id: number;
	text: string;
	searchable: string;
}

const FLAGS_MAP: Record<number, string> = {
	4: "【step up】",
	20600: "＋福引＆かけら",
	16384: "＋かけら",
	4216: "＋福引",
};

const RATE_LABELS: Array<[keyof GachaRate, string]> = [
	["normal", "ノーマル"],
	["rare", "レア"],
	["superRare", "激レア"],
	["uberRare", "超激レア"],
	["legendRare", "伝説レア"],
	["featured", "目玉"],
];

const GATYA_ITEM_GIFT_TYPES = new Set([301, 302]);

function getGachaTypeLabel(type: number): string {
	if (type === 0) return "ノーマル";
	if (type === 4) return "イベント";
	return "レア";
}

function getGachaGuaranteedLabel(guaranteed: boolean, gachaType: number): string {
	if (!guaranteed) return "";
	return gachaType === 4 ? "＜確定枠あり＞" : "＜確定＞";
}

function flagLabel(flags: number): string {
	return FLAGS_MAP[flags] ?? "";
}

function isDisplayableGachaType(type: number): boolean {
	return type !== 2 && type !== 3;
}

function modeMatches(mode: Mode | null, gachaType: number): boolean {
	if (!mode) return true;
	if (mode === "R") return gachaType !== 0 && gachaType !== 4;
	if (mode === "E") return gachaType === 4;
	if (mode === "N") return gachaType === 0;
	return true;
}

function gachaItemMatchesMode(mode: Mode | null): boolean {
	return mode === null || mode === "R";
}

function namesFor(type: number, csv: CsvSet): Map<number, string> {
	if (type === 0) return csv.normal;
	if (type === 4) return csv.event;
	return csv.rare;
}

function gachaName(block: GachaBlock, gacha: GachaEntry, csv: CsvSet): string {
	return namesFor(block.header.gachaType, csv).get(gacha.id) ?? `ID:${gacha.id}`;
}

function itemName(giftType: number, itemNames: Pick<ItemNameData, "names">): string {
	return itemNames.names.get(giftType) ?? `giftType:${giftType}`;
}

function formatRate(value: number): string {
	return `${(value / 100).toFixed(2)}%`;
}

function formatRates(rates: GachaRate): string[] {
	return RATE_LABELS
		.filter(([key]) => (rates[key] ?? 0) > 0)
		.map(([key, label]) => `${label}: ${formatRate(rates[key] ?? 0)}`);
}

function shortRateSummary(rates: GachaRate): string {
	const labels = [
		["uberRare", "超激"] as const,
		["legendRare", "伝説"] as const,
		["featured", "目玉"] as const,
	].filter(([key]) => (rates[key] ?? 0) > 0)
		.map(([key, label]) => `${label}${formatRate(rates[key] ?? 0)}`);
	return labels.join(" / ");
}

function getJdbGatyaUrl(gachaType: number, id: number): string | null {
	const rareCode = gachaType === 0 ? "N" : gachaType === 4 ? "E" : gachaType === 1 ? "R" : null;
	if (!rareCode) return null;
	return `https://jarjarblink.github.io/JDB/gatya.html?cc=ja&rare=${rareCode}&no=${id}`;
}

function getGachaInfoUrl(gachaType: number, id: number): string | null {
	const idText = String(id).padStart(3, "0");
	if (gachaType === 1) return `https://ponosgames.com/information/appli/battlecats/gacha/rare/R${idText}.html`;
	if (gachaType === 4) return `https://ponosgames.com/information/appli/battlecats/gacha/event/E${idText}.html`;
	if (gachaType === 0) return `https://ponosgames.com/information/appli/battlecats/gacha/normal/N${idText}.html`;
	return null;
}

async function loadGatya(): Promise<GatyaData> {
	const [json, rare, event, normal, itemJson, itemNames] = await Promise.all([
		fetchJson<GachaJson>("data/gatya.json"),
		fetchCsvMap("data/gatya_name.csv"),
		fetchCsvMap("data/gatya_e_name.csv"),
		fetchCsvMap("data/gatya_n_name.csv"),
		fetchJson<ItemJson>("data/item.json"),
		fetchItemNameData("data/item_name.csv"),
	]);
	return { json, csv: { rare, event, normal }, itemJson, itemNames };
}

function currentBlocks(json: GachaJson): GachaBlock[] {
	const now = new Date();
	return json.data.filter((block) => {
		if (!isDisplayableGachaType(block.header.gachaType)) return false;
		if (block.header.endDate === "20300101") return false;
		return parseDate(block.header.endDate, block.header.endTime) > now;
	});
}

function currentGatyaItemEntries(itemJson: ItemJson): GatyaItemEntry[] {
	const now = new Date();
	return itemJson.data.filter((entry) =>
		GATYA_ITEM_GIFT_TYPES.has(entry.gift.giftType) &&
		entry.header.endDate !== "20300101" &&
		parseDate(entry.header.endDate, entry.header.endTime) > now
	);
}

function gachaRowText(block: GachaBlock, gacha: GachaEntry, csv: CsvSet): string {
	const features = [
		getGachaTypeLabel(block.header.gachaType),
		getGachaGuaranteedLabel(gacha.guaranteed, block.header.gachaType),
		flagLabel(gacha.flags),
		shortRateSummary(gacha.rates),
	].filter(Boolean);
	return `${gacha.id} ${gachaName(block, gacha, csv)}（${features.join(" / ")}）`;
}

function itemRowText(entry: GatyaItemEntry, itemNames: ItemNameData): string {
	const gift = entry.gift;
	return `${gift.giftType} ${itemName(gift.giftType, itemNames)}${formatAmount(gift.giftAmount)}（レア / gatya_item / eventId:${gift.eventId}）`;
}

function collectScheduleRows(data: GatyaData, mode: Mode | null): ScheduleRow[] {
	const rows: ScheduleRow[] = [];
	const seen = new Set<string>();

	for (const block of currentBlocks(data.json)) {
		if (!modeMatches(mode, block.header.gachaType)) continue;
		const start = parseDate(block.header.startDate, block.header.startTime);
		for (const gacha of block.gachas) {
			if (gacha.id < 0) continue;
			const key = `${start.getTime()}:${block.header.gachaType}:${gacha.id}:${gacha.flags}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const text = gachaRowText(block, gacha, data.csv);
			rows.push({
				start,
				id: gacha.id,
				text,
				searchable: `${gacha.id} ${text} ${gacha.message ?? ""}`.toLowerCase(),
			});
		}
	}

	if (gachaItemMatchesMode(mode)) {
		for (const entry of currentGatyaItemEntries(data.itemJson)) {
			const start = parseDate(entry.header.startDate, entry.header.startTime);
			const text = itemRowText(entry, data.itemNames);
			rows.push({
				start,
				id: entry.gift.giftType,
				text,
				searchable: `${entry.gift.giftType} ${entry.gift.eventId} ${text} ${entry.gift.title} ${entry.gift.message}`.toLowerCase(),
			});
		}
	}

	rows.sort((a, b) => a.start.getTime() - b.start.getTime() || a.id - b.id);
	return rows;
}

function rowsText(title: string, rows: ScheduleRow[]): string {
	const now = new Date();
	const lines: string[] = [title];
	let lastDate = "";
	for (const row of rows) {
		const date = formatDateShort(row.start);
		const dateKey = date.slice(0, 8);
		if (dateKey !== lastDate) {
			lines.push("");
			lines.push(row.start <= now ? `開催中 ${date}` : `予定 ${date}`);
			lastDate = dateKey;
		}
		lines.push(`・${row.text}`);
	}
	return lines.join("\n").trim();
}

function scheduleText(data: GatyaData, mode: Mode | null): string {
	return rowsText(`gatyaスケジュール\n更新: ${data.json.updatedAt}`, collectScheduleRows(data, mode));
}

function searchText(data: GatyaData, mode: Mode | null, query: string): string {
	const rows = collectScheduleRows(data, mode)
		.filter((row) => row.searchable.includes(query.toLowerCase()));
	if (rows.length === 0) return `「${query}」は見つかりませんでした`;
	return rowsText(`「${query}」検索結果 (${rows.length}件)`, rows);
}

function gachaDetailText(block: GachaBlock, gacha: GachaEntry, csv: CsvSet): string {
	const features = [
		getGachaTypeLabel(block.header.gachaType),
		flagLabel(gacha.flags),
		getGachaGuaranteedLabel(gacha.guaranteed, block.header.gachaType),
		block.header.endDate === "20300101" ? "常設" : "期間限定",
	].filter(Boolean);
	const messageLines = cleanDetailLines(gacha.message && gacha.message !== "0" ? gacha.message : "");
	const linkLines = [
		getJdbGatyaUrl(block.header.gachaType, gacha.id) ? `JDB: ${getJdbGatyaUrl(block.header.gachaType, gacha.id)}` : "",
		getGachaInfoUrl(block.header.gachaType, gacha.id) ? `公式: ${getGachaInfoUrl(block.header.gachaType, gacha.id)}` : "",
	].filter(Boolean);

	return joinBlocks([
		[
			`【gatya詳細】${formatEventStatus(block.header)}`,
			`名称: ${gachaName(block, gacha, csv)}`,
			`期間: ${formatEventPeriod(block.header)}`,
			`ver: ${formatVersionRange(block.header)}`,
			`id: ${gacha.id}`,
			`タグ: ${features.join(" / ") || "なし"}`,
		],
		[
			"詳細:",
			`バナー位置 ${block.header.gachaCount}`,
			`消費: ${gacha.price}`,
		],
		[
			"レート:",
			...(formatRates(gacha.rates).length > 0 ? formatRates(gacha.rates).map((line) => `・${line}`) : ["（データなし）"]),
		],
		messageLines.length > 0 ? ["【タイトル】", ...messageLines] : [],
		linkLines.length > 0 ? ["リンク:", ...linkLines] : [],
		[`短縮期間: ${formatEventPeriodShort(block.header)}`],
	]);
}

function gatyaItemDetailText(entry: GatyaItemEntry, itemNames: ItemNameData): string {
	const gift = entry.gift;
	const messageLines = cleanDetailLines(gift.message);
	const detailLines = cleanDetailLines(itemNames.details.get(gift.giftType));
	const tags = [
		"レア",
		"gatya_item",
		entry.header.endDate === "20300101" ? "常設" : "期間限定",
		gift.repeatFlag === 0 ? "1回限り" : "繰り返し",
	].filter(Boolean);
	return joinBlocks([
		[
			`【gatya item詳細】${formatEventStatus(entry.header)}`,
			`名称: ${itemName(gift.giftType, itemNames)}`,
			`期間: ${formatEventPeriod(entry.header)}`,
			`ver: ${formatVersionRange(entry.header)}`,
			`id: ${gift.giftType}`,
			`イベントID: ${gift.eventId}（ID帯: ${formatIdBand(gift.eventId)}）`,
			`タグ: ${tags.join(" / ")}`,
		],
		[
			"開催期間:",
			...formatTimeBlockLines(entry.timeBlocks).map((line) => `・${line}`),
		],
		[
			"ギフト:",
			`id:${gift.giftType} ${itemName(gift.giftType, itemNames)}${formatAmount(gift.giftAmount)}`,
		],
		messageLines.length > 0 || gift.url
			? [
				"メッセージ:",
				...(messageLines.length > 0 ? messageLines : ["なし"]),
				...(gift.url ? [`URL: ${gift.url}`] : []),
			]
			: [],
		detailLines.length > 0 ? ["ギフト詳細:", ...detailLines] : [],
		[`短縮期間: ${formatEventPeriodShort(entry.header)}`],
	]);
}

async function detailText(id: number, mode: Mode | null, data: GatyaData): Promise<string[]> {
	const blocks = data.json.data.filter((block) =>
		isDisplayableGachaType(block.header.gachaType) &&
		modeMatches(mode, block.header.gachaType) &&
		block.gachas.some((gacha) => gacha.id === id)
	);
	const details = blocks.map((block) => {
		const gacha = block.gachas.find((entry) => entry.id === id)!;
		return gachaDetailText(block, gacha, data.csv);
	});
	if (gachaItemMatchesMode(mode)) {
		for (const entry of data.itemJson.data.filter((item) =>
			GATYA_ITEM_GIFT_TYPES.has(item.gift.giftType) && item.gift.giftType === id
		)) {
			details.push(gatyaItemDetailText(entry, data.itemNames));
		}
	}
	return details;
}

export const gatyaCommand: LineCommand = {
	name: "gatya",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!gatya",
				"",
				"!gatya",
				"  今後のガチャスケジュールを一覧表示します。",
				"!gatya R / !gatya E / !gatya N",
				"  R=レア、E=イベント、N=ノーマルに絞って表示します。",
				"!gatya <ID>",
				"  指定したガチャIDの期間、レート、確定、リンクを表示します。",
				"!gatya <検索語>",
				"  ガチャ名、ID、eventIdで検索します。",
				"!gatya <ID> json",
				"  元データをKBC独自のJSON形式で表示します。",
				"!gatya <ID> r",
				"  rawデータを表示します。",
			].join("\n"));
			return;
		}

		try {
			const data = await loadGatya();
			let mode: Mode | null = null;
			let rest = args;
			const first = args[0]?.toUpperCase();
			if (first === "R" || first === "E" || first === "N") {
				mode = first;
				rest = args.slice(1);
			}

			if (rest.length === 0) {
				await sendLong(message, scheduleText(data, mode));
				return;
			}

			const last = rest.at(-1)?.toLowerCase();
			const beforeLast = rest.at(-2);
			if ((last === "j" || last === "json") && beforeLast && isExactInteger(beforeLast)) {
				const id = parseInt(beforeLast, 10);
				const blocks = data.json.data.filter((block) => block.gachas.some((gacha) => gacha.id === id));
				const itemEntries = data.itemJson.data.filter((entry) =>
					GATYA_ITEM_GIFT_TYPES.has(entry.gift.giftType) && entry.gift.giftType === id
				);
				await sendLong(
					message,
					JSON.stringify([
						...blocks.map(({ raw: _raw, ...block }) => block),
						...itemEntries.map(({ raw: _raw, ...entry }) => entry),
					], null, 2),
					"json",
				);
				return;
			}
			if (last === "r" && beforeLast && isExactInteger(beforeLast)) {
				const id = parseInt(beforeLast, 10);
				const raws = [
					...data.json.data
						.filter((block) => block.gachas.some((gacha) => gacha.id === id))
						.map((block) => block.raw || `(startDate: ${block.header.startDate}) rawなし`),
					...data.itemJson.data
						.filter((entry) => GATYA_ITEM_GIFT_TYPES.has(entry.gift.giftType) && entry.gift.giftType === id)
						.map((entry) => entry.raw || `(startDate: ${entry.header.startDate}) rawなし`),
				].join("\n\n");
				await sendLong(message, raws.replace(/\t/g, "    "));
				return;
			}

			const query = rest.join(" ").trim();
			if (isExactInteger(query)) {
				const details = await detailText(parseInt(query, 10), mode, data);
				if (details.length === 0) {
					await sendError(message, `ID ${query} は gatya.json/item.json に見つかりませんでした`);
					return;
				}
				await sendLong(message, details.join("\n\n"));
				return;
			}

			await sendLong(message, searchText(data, mode, query));
		} catch (error) {
			console.error("[gatya] failed", error);
			await sendError(message, "ガチャデータの取得または処理に失敗しました");
		}
	},
};
