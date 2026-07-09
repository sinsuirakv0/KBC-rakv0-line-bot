import type { LineCommand, TimeBlock } from "./shared.js";
import {
	fetchCsvMap,
	fetchJson,
	formatDateShort,
	isExactInteger,
	parseDate,
	sendError,
	sendLongToThread,
} from "./shared.js";
import {
	formatEventPeriod,
	formatEventStatus,
	formatTimeBlockLines,
	joinBlocks,
	type EventHeader,
} from "./eventDisplay.js";
import {
	classifyEventId,
	isMissionEventId,
	missionLookupId,
} from "../search/eventIdClassification.js";

type SaleKind = "sale" | "mission";

interface SaleHeader extends EventHeader {}

interface SaleEntry {
	header: SaleHeader;
	timeBlocks: TimeBlock[];
	stageIds: number[];
	raw?: string;
}

interface SaleJson {
	updatedAt: string;
	data: SaleEntry[];
}

interface SaleNameMaps {
	sale: Map<number, string>;
	mission: Map<number, string>;
}

async function loadSale(): Promise<{ json: SaleJson; names: SaleNameMaps }> {
	const [json, saleNames, missionNames] = await Promise.all([
		fetchJson<SaleJson>("data/sale.json"),
		fetchCsvMap("data/sale_name.csv"),
		fetchCsvMap("data/Mission_Name.csv"),
	]);
	return { json, names: { sale: saleNames, mission: missionNames } };
}

function isPermanent(entry: SaleEntry): boolean {
	return entry.header.endDate === "20300101";
}

function isActive(entry: SaleEntry, now: Date): boolean {
	const start = parseDate(entry.header.startDate, entry.header.startTime);
	const end = parseDate(entry.header.endDate, entry.header.endTime);
	return now >= start && now < end;
}

function splitMissionText(rawName: string): { name: string; popupText: string } {
	const text = rawName.replace(/<br\s*\/?>/gi, "\n").trim();
	const comma = text.search(/[,，]/);
	if (comma === -1) return { name: text, popupText: "" };
	return {
		name: text.slice(0, comma).trim(),
		popupText: text.slice(comma + 1).trim(),
	};
}

function nameForId(id: number, names: SaleNameMaps): string {
	if (!isMissionEventId(id)) return names.sale.get(id) ?? `ID:${id}`;
	const raw = names.mission.get(missionLookupId(id)) ?? `ID:${id}`;
	return splitMissionText(raw).name;
}

function kindForId(id: number): SaleKind {
	return isMissionEventId(id) ? "mission" : "sale";
}

function idsByKind(entry: SaleEntry, kind: SaleKind): number[] {
	return entry.stageIds.filter((id) => kindForId(id) === kind);
}

function targetLine(id: number, names: SaleNameMaps): string {
	return `・${id} ${nameForId(id, names)}`;
}

function targetSearchText(id: number, names: SaleNameMaps): string {
	const classification = classifyEventId(id);
	return [
		String(id),
		nameForId(id, names),
		classification.displayCode ?? "",
		classification.jdbUrl ?? "",
		classification.stageProxyUrl ?? "",
	].join(" ").toLowerCase();
}

interface SaleScheduleRow {
	entry: SaleEntry;
	id: number;
	status: "開催中" | "予定";
	period: string;
}

function formatScheduleDate(date: Date): string {
	const text = formatDateShort(date);
	const separator = text.lastIndexOf(" ");
	if (separator === -1) return text;
	const datePart = text.slice(0, separator);
	const timePart = text.slice(separator + 1);
	return timePart === "11:00" ? datePart : text;
}

function formatSchedulePeriod(entry: SaleEntry): string {
	const start = parseDate(entry.header.startDate, entry.header.startTime);
	const end = parseDate(entry.header.endDate, entry.header.endTime);
	return `${formatScheduleDate(start)} ~ ${formatScheduleDate(end)}`;
}

function collectScheduleRows(json: SaleJson, kind: SaleKind): SaleScheduleRow[] {
	const now = new Date();
	return json.data
		.filter((entry) => !isPermanent(entry) && parseDate(entry.header.endDate, entry.header.endTime) > now)
		.sort((a, b) =>
			parseDate(a.header.startDate, a.header.startTime).getTime() -
			parseDate(b.header.startDate, b.header.startTime).getTime()
		)
		.flatMap((entry) => idsByKind(entry, kind).map((id) => ({
			entry,
			id,
			status: isActive(entry, now) ? "開催中" as const : "予定" as const,
			period: formatSchedulePeriod(entry),
		})));
}

function scheduleSection(title: string, rows: SaleScheduleRow[], names: SaleNameMaps): string[] {
	if (rows.length === 0) return [];
	const lines = [title];
	for (const status of ["開催中", "予定"] as const) {
		const statusRows = rows.filter((row) => row.status === status);
		if (statusRows.length === 0) continue;
		lines.push("");
		lines.push(status);
		let lastPeriod = "";
		for (const row of statusRows) {
			if (row.period !== lastPeriod) {
				lines.push(row.period);
				lastPeriod = row.period;
			}
			lines.push(targetLine(row.id, names));
		}
	}
	return lines;
}

function scheduleText(json: SaleJson, names: SaleNameMaps): string {
	const blocks = [
		["saleスケジュール"],
		scheduleSection("イベント", collectScheduleRows(json, "sale"), names),
		scheduleSection("ミッション", collectScheduleRows(json, "mission"), names),
	].filter((block) => block.length > 0);
	return blocks.map((block) => block.join("\n")).join("\n\n").trim();
}

function linkLinesForId(id: number): string[] {
	const classification = classifyEventId(id);
	return [
		classification.jdbUrl ? `JDB: ${classification.jdbUrl}` : "",
		classification.stageProxyUrl ? `KBC: ${classification.stageProxyUrl}` : "",
	].filter(Boolean);
}

function relatedTargetLines(entry: SaleEntry, names: SaleNameMaps, primaryId: number): string[] {
	const kind = kindForId(primaryId);
	return idsByKind(entry, kind)
		.filter((id) => id !== primaryId)
		.map((id) => targetLine(id, names));
}

function targetSectionTitle(kind: SaleKind): string {
	return kind === "mission" ? "対象ミッション:" : "対象ステージ:";
}

function detailTitle(kind: SaleKind): string {
	return kind === "mission" ? "【mission詳細】" : "【sale詳細】";
}

function versionText(header: SaleHeader): string {
	return `${header.minVersion}~${header.maxVersion}`;
}

function detailText(entry: SaleEntry, names: SaleNameMaps, selectedId: number): string {
	const kind = kindForId(selectedId);
	const targets = relatedTargetLines(entry, names, selectedId);
	const links = linkLinesForId(selectedId);

	return joinBlocks([
		[
			`${detailTitle(kind)}${formatEventStatus(entry.header)}`,
			`・${nameForId(selectedId, names)}`,
			`期間: ${formatEventPeriod(entry.header)}`,
			`ver:${versionText(entry.header)}`,
			`id: ${selectedId}`,
		],
		[
			"開催期間:",
			...formatTimeBlockLines(entry.timeBlocks).map((line) => `・${line}`),
		],
		targets.length > 0 ? [targetSectionTitle(kind), ...targets] : [],
		links.length > 0 ? ["リンク:", ...links] : [],
	]);
}

function searchText(json: SaleJson, names: SaleNameMaps, query: string): string {
	const lower = query.toLowerCase();
	const now = new Date();
	const rows = json.data
		.filter((entry) => !isPermanent(entry) && parseDate(entry.header.endDate, entry.header.endTime) > now)
		.flatMap((entry) => entry.stageIds.map((id) => ({ entry, id, kind: kindForId(id) })))
		.filter((row) => targetSearchText(row.id, names).includes(lower))
		.sort((a, b) =>
			parseDate(a.entry.header.startDate, a.entry.header.startTime).getTime() -
			parseDate(b.entry.header.startDate, b.entry.header.startTime).getTime()
		);
	if (rows.length === 0) return `「${query}」は見つかりませんでした`;
	const blocks = [
		[`「${query}」検索結果 (${rows.length}件)`],
		scheduleSection("イベント", rows.filter((row) => row.kind === "sale").map((row) => ({
			entry: row.entry,
			id: row.id,
			status: isActive(row.entry, now) ? "開催中" as const : "予定" as const,
			period: formatSchedulePeriod(row.entry),
		})), names),
		scheduleSection("ミッション", rows.filter((row) => row.kind === "mission").map((row) => ({
			entry: row.entry,
			id: row.id,
			status: isActive(row.entry, now) ? "開催中" as const : "予定" as const,
			period: formatSchedulePeriod(row.entry),
		})), names),
	].filter((block) => block.length > 0);
	return blocks.map((block) => block.join("\n")).join("\n\n");
}

export const saleCommand: LineCommand = {
	name: "sale",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!sale",
				"",
				"!sale",
				"  今後のイベントとミッションを分けて、ID・名前・期間だけ一覧表示します。",
				"!sale <ID>",
				"  指定したIDの期間、ver、開催期間、対象ステージ、リンクを表示します。",
				"!sale <検索語>",
				"  イベント名、ID、分類コード(A000など)で検索します。",
				"!sale <ID> json",
				"  元データをKBC独自のJSON形式で表示します。",
				"!sale <ID> r",
				"  rawデータを表示します。",
			].join("\n"));
			return;
		}

		try {
			const { json, names } = await loadSale();
			if (args.length === 0) {
				await sendLongToThread(message, scheduleText(json, names));
				return;
			}

			const first = args[0];
			if (isExactInteger(first)) {
				const id = parseInt(first, 10);
				const modifier = args[1]?.toLowerCase();
				const entries = json.data.filter((entry) => entry.stageIds.includes(id));
				if (entries.length === 0) {
					await sendError(message, `ID ${id} は sale.json に見つかりませんでした`);
					return;
				}
				if (modifier === "j" || modifier === "json") {
					await sendLongToThread(message, JSON.stringify(entries.map(({ raw: _raw, ...data }) => data), null, 2), "json");
					return;
				}
				if (modifier === "r") {
					await sendLongToThread(
						message,
						entries.map((entry) => entry.raw || `(startDate: ${entry.header.startDate}) rawなし`).join("\n\n")
							.replace(/\t/g, "    "),
					);
					return;
				}
				await sendLongToThread(message, entries.map((entry) => detailText(entry, names, id)).join("\n\n"));
				return;
			}

			await sendLongToThread(message, searchText(json, names, args.join(" ")));
		} catch (error) {
			console.error("[sale] failed", error);
			await sendError(message, "セールデータの取得または処理に失敗しました");
		}
	},
};
