import type { LineCommand, TimeBlock } from "./shared.js";
import {
	fetchCsvMap,
	fetchJson,
	formatDateFull,
	formatDateShort,
	formatTimeBlock,
	isExactInteger,
	parseDate,
	sendError,
	sendLong,
} from "./shared.js";

interface SaleHeader {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	minVersion: string;
	maxVersion: string;
}

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

async function loadSale(): Promise<{ json: SaleJson; names: Map<number, string> }> {
	const [json, names] = await Promise.all([
		fetchJson<SaleJson>("data/sale.json"),
		fetchCsvMap("data/sale_name.csv"),
	]);
	return { json, names };
}

function isPermanent(entry: SaleEntry): boolean {
	return entry.header.endDate === "20300101";
}

function isActive(entry: SaleEntry, now: Date): boolean {
	const start = parseDate(entry.header.startDate, entry.header.startTime);
	const end = parseDate(entry.header.endDate, entry.header.endTime);
	return now >= start && now < end;
}

function scheduleText(json: SaleJson, names: Map<number, string>): string {
	const now = new Date();
	const entries = json.data
		.filter((entry) => !isPermanent(entry) && parseDate(entry.header.endDate, entry.header.endTime) > now)
		.sort((a, b) =>
			parseDate(a.header.startDate, a.header.startTime).getTime() -
			parseDate(b.header.startDate, b.header.startTime).getTime()
		);

	const lines = [`セールスケジュール 更新: ${json.updatedAt}`];
	for (const entry of entries) {
		const start = parseDate(entry.header.startDate, entry.header.startTime);
		const end = parseDate(entry.header.endDate, entry.header.endTime);
		lines.push(`${isActive(entry, now) ? "開催中" : "予定"} ${formatDateShort(start)} ~ ${formatDateShort(end)}`);
		for (const id of entry.stageIds) {
			lines.push(`  ${id} ${names.get(id) ?? "不明"}`);
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

function detailText(entry: SaleEntry, names: Map<number, string>): string {
	const start = parseDate(entry.header.startDate, entry.header.startTime);
	const end = isPermanent(entry) ? null : parseDate(entry.header.endDate, entry.header.endTime);
	const lines = entry.stageIds.map((id) => `${id} ${names.get(id) ?? "不明"}`);
	lines.push(`${formatDateFull(start)} ~ ${end ? formatDateFull(end) : "常設"}  ver.${entry.header.minVersion}~${entry.header.maxVersion}`);
	if (entry.timeBlocks.length === 0) {
		lines.push("・常時開催");
	} else {
		for (const block of entry.timeBlocks) lines.push(`・${formatTimeBlock(block)}`);
	}
	return lines.join("\n");
}

export const saleCommand: LineCommand = {
	name: "sale",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!sale",
				"",
				"!sale",
				"  今後のセール/イベントスケジュールを一覧表示します。",
				"!sale <ID>",
				"  指定したイベントIDの開催期間や開催時間を表示します。",
				"!sale <検索語>",
				"  イベント名で検索します。",
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
				await sendLong(message, scheduleText(json, names));
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
					await sendLong(message, JSON.stringify(entries.map(({ raw: _raw, ...data }) => data), null, 2), "json");
					return;
				}
				if (modifier === "r") {
					await sendLong(
						message,
						entries.map((entry) => entry.raw || `(startDate: ${entry.header.startDate}) rawなし`).join("\n\n")
							.replace(/\t/g, "    "),
					);
					return;
				}
				await sendLong(message, entries.map((entry) => detailText(entry, names)).join("\n\n"));
				return;
			}

			const query = args.join(" ").toLowerCase();
			const matched = [...names.entries()].filter(([, name]) => name.toLowerCase().includes(query));
			if (matched.length === 0) {
				await sendError(message, `「${args.join(" ")}」は見つかりませんでした`);
				return;
			}
			await sendLong(
				message,
				[`「${args.join(" ")}」の検索結果 (${matched.length}件)`, ...matched.map(([id, name]) => `${id} ${name}`)]
					.join("\n"),
			);
		} catch (error) {
			console.error("[sale] failed", error);
			await sendError(message, "セールデータの取得または処理に失敗しました");
		}
	},
};
