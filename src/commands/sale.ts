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
	cleanDetailLines,
	compactLine,
	formatEventPeriod,
	formatEventPeriodShort,
	formatEventStatus,
	formatTimeBlockLines,
	formatVersionRange,
	joinBlocks,
	type EventHeader,
} from "./eventDisplay.js";
import {
	classifyEventId,
	formatEventIdTags,
	isMissionEventId,
	missionLookupId,
} from "../search/eventIdClassification.js";

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

function popupTextForId(id: number, names: SaleNameMaps): string[] {
	if (!isMissionEventId(id)) return [];
	const raw = names.mission.get(missionLookupId(id));
	if (!raw) return [];
	return cleanDetailLines(splitMissionText(raw).popupText);
}

function orderedIds(entry: SaleEntry, selectedId?: number): number[] {
	if (selectedId === undefined || !entry.stageIds.includes(selectedId)) return entry.stageIds;
	return [selectedId, ...entry.stageIds.filter((id) => id !== selectedId)];
}

function targetLine(id: number, names: SaleNameMaps): string {
	const classification = classifyEventId(id);
	const code = classification.displayCode ? ` [${classification.displayCode}]` : "";
	return `${id}${code} ${nameForId(id, names)}（${classification.kind} / ${classification.tagLabel}）`;
}

function targetSearchText(id: number, names: SaleNameMaps): string {
	return [
		String(id),
		nameForId(id, names),
		formatEventIdTags(id),
		classifyEventId(id).jdbUrl ?? "",
	].join(" ").toLowerCase();
}

function scheduleText(json: SaleJson, names: SaleNameMaps): string {
	const now = new Date();
	const entries = json.data
		.filter((entry) => !isPermanent(entry) && parseDate(entry.header.endDate, entry.header.endTime) > now)
		.sort((a, b) =>
			parseDate(a.header.startDate, a.header.startTime).getTime() -
			parseDate(b.header.startDate, b.header.startTime).getTime()
		);

	const lines = ["sale/missionスケジュール", `更新: ${json.updatedAt}`];
	for (const entry of entries) {
		const start = parseDate(entry.header.startDate, entry.header.startTime);
		const end = parseDate(entry.header.endDate, entry.header.endTime);
		lines.push("");
		lines.push(`${isActive(entry, now) ? "開催中" : "予定"} ${formatDateShort(start)} ~ ${formatDateShort(end)}`);
		for (const id of entry.stageIds) {
			lines.push(`・${targetLine(id, names)}`);
		}
		if (entry.timeBlocks.length > 0) {
			lines.push(`  開催期間: ${compactLine(formatTimeBlockLines(entry.timeBlocks).join(" / "), 120)}`);
		}
	}
	return lines.join("\n").trim();
}

function detailText(entry: SaleEntry, names: SaleNameMaps, selectedId?: number): string {
	const ids = orderedIds(entry, selectedId);
	const primaryId = selectedId ?? ids[0];
	const primary = classifyEventId(primaryId);
	const tagSummary = [...new Set(ids.flatMap((id) => {
		const classification = classifyEventId(id);
		return [
			classification.kind,
			classification.tagLabel,
			classification.displayCode,
		].filter(Boolean);
	}))].join(" / ");
	const popupLines = ids.flatMap((id) => popupTextForId(id, names));
	const linkLines = [
		primary.jdbUrl ? `JDB: ${primary.jdbUrl}` : "",
		primary.dbUrl ? `DB: ${primary.dbUrl}` : "",
		primary.stageProxyUrl ? `公式表示: ${primary.stageProxyUrl}` : "",
	].filter(Boolean);

	return joinBlocks([
		[
			`【${primary.kind}詳細】${formatEventStatus(entry.header)}`,
			`期間: ${formatEventPeriod(entry.header)}`,
			`ver: ${formatVersionRange(entry.header)}`,
			`id: ${primaryId}${primary.displayCode ? ` [${primary.displayCode}]` : ""}`,
			`タグ: ${tagSummary || "その他"}`,
		],
		[
			"開催期間:",
			...formatTimeBlockLines(entry.timeBlocks).map((line) => `・${line}`),
		],
		[
			ids.length > 1 ? "対象ステージ:" : "対象ID:",
			...ids.map((id) => `・${targetLine(id, names)}`),
		],
		popupLines.length > 0 ? ["ポップアップ:", ...popupLines] : [],
		linkLines.length > 0 ? ["リンク:", ...linkLines] : [],
		[`短縮期間: ${formatEventPeriodShort(entry.header)}`],
	]);
}

function searchText(json: SaleJson, names: SaleNameMaps, query: string): string {
	const ids = [...new Set(json.data.flatMap((entry) => entry.stageIds))].sort((a, b) => a - b);
	const matched = ids.filter((id) => targetSearchText(id, names).includes(query.toLowerCase()));
	if (matched.length === 0) return `「${query}」は見つかりませんでした`;
	return [
		`「${query}」検索結果 (${matched.length}件)`,
		...matched.map((id) => targetLine(id, names)),
	].join("\n");
}

export const saleCommand: LineCommand = {
	name: "sale",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!sale",
				"",
				"!sale",
				"  今後のsale/missionスケジュールを一覧表示します。",
				"!sale <ID>",
				"  指定したIDの期間、分類、開催期間、対象ID、リンクを表示します。",
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
