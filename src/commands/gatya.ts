import type { LineCommand } from "./shared.js";
import {
	fetchCsvMap,
	fetchJson,
	formatDateShort,
	isExactInteger,
	parseDate,
	sendError,
	sendLong,
} from "./shared.js";

type Mode = "R" | "E" | "N";

interface GachaRate {
	normal: number;
	rare: number;
	superRare: number;
	uberRare: number;
	legendRare: number;
}

interface GachaEntry {
	id: number;
	price: number;
	flags: number;
	rates: GachaRate;
	guaranteed: boolean;
	message?: string;
}

interface GachaHeader {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	minVersion: string;
	maxVersion: string;
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

interface CsvSet {
	rare: Map<number, string>;
	event: Map<number, string>;
	normal: Map<number, string>;
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

function typeTag(type: number): string {
	if (type === 4) return " <イベント>";
	if (type === 0) return " <ノーマル>";
	if (type === 1) return " <レア>";
	return "";
}

function flagLabel(flags: number): string {
	return FLAGS_MAP[flags] ?? "";
}

function modeMatches(mode: Mode | null, gachaType: number): boolean {
	if (!mode) return true;
	if (mode === "R") return gachaType === 1;
	if (mode === "E") return gachaType === 4;
	if (mode === "N") return gachaType === 0;
	return true;
}

function namesFor(type: number, csv: CsvSet): Map<number, string> {
	if (type === 1) return csv.rare;
	if (type === 4) return csv.event;
	return csv.normal;
}

async function loadGatya(): Promise<{ json: GachaJson; csv: CsvSet }> {
	const [json, rare, event, normal] = await Promise.all([
		fetchJson<GachaJson>("data/gatya.json"),
		fetchCsvMap("data/gatya_name.csv"),
		fetchCsvMap("data/gatya_e_name.csv"),
		fetchCsvMap("data/gatya_n_name.csv"),
	]);
	return { json, csv: { rare, event, normal } };
}

function currentBlocks(json: GachaJson): GachaBlock[] {
	const now = new Date();
	return json.data.filter((block) => {
		if (block.header.endDate === "20300101") return false;
		return parseDate(block.header.endDate, block.header.endTime) > now;
	});
}

function collectScheduleRows(json: GachaJson, csv: CsvSet, mode: Mode | null): ScheduleRow[] {
	const rows: ScheduleRow[] = [];
	const seen = new Set<string>();

	for (const block of currentBlocks(json)) {
		if (!modeMatches(mode, block.header.gachaType)) continue;
		const start = parseDate(block.header.startDate, block.header.startTime);
		for (const gacha of block.gachas) {
			if (gacha.id < 0) continue;
			const key = `${start.getTime()}:${block.header.gachaType}:${gacha.id}:${gacha.flags}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const name = namesFor(block.header.gachaType, csv).get(gacha.id) ?? "不明";
			const flag = flagLabel(gacha.flags);
			const tag = typeTag(block.header.gachaType);
			const text = `${String(gacha.id).padEnd(4)} ${name}${tag}${flag ? ` ${flag}` : ""}`;
			rows.push({
				start,
				id: gacha.id,
				text,
				searchable: `${gacha.id} ${name} ${tag} ${flag}`.toLowerCase(),
			});
		}
	}

	rows.sort((a, b) => a.start.getTime() - b.start.getTime() || a.id - b.id);
	return rows;
}

function scheduleText(json: GachaJson, csv: CsvSet, mode: Mode | null): string {
	const now = new Date();
	const rows = collectScheduleRows(json, csv, mode);
	const lines: string[] = [`ガチャスケジュール 更新: ${json.updatedAt}`];
	let lastDate = "";
	for (const row of rows) {
		const date = formatDateShort(row.start).slice(0, 8);
		if (date !== lastDate) {
			lines.push(row.start <= now ? date : `[${date}]`);
			lastDate = date;
		}
		lines.push(`  ${row.text}`);
	}
	return lines.join("\n");
}

function searchText(json: GachaJson, csv: CsvSet, mode: Mode | null, query: string): string {
	const now = new Date();
	const rows = collectScheduleRows(json, csv, mode)
		.filter((row) => row.searchable.includes(query.toLowerCase()));
	if (rows.length === 0) return `「${query}」は見つかりませんでした`;

	const lines: string[] = [`「${query}」検索結果 (${rows.length}件)`];
	let lastDate = "";
	for (const row of rows) {
		const date = formatDateShort(row.start).slice(0, 8);
		if (date !== lastDate) {
			lines.push(row.start <= now ? date : `[${date}]`);
			lastDate = date;
		}
		lines.push(`  ${row.text}`);
	}
	return lines.join("\n");
}

function detailText(id: number, mode: Mode | null, json: GachaJson, csv: CsvSet): string[] {
	const blocks = json.data.filter((block) =>
		modeMatches(mode, block.header.gachaType) && block.gachas.some((gacha) => gacha.id === id)
	);
	return blocks.map((block) => {
		const gacha = block.gachas.find((entry) => entry.id === id)!;
		const start = parseDate(block.header.startDate, block.header.startTime);
		const period = block.header.endDate === "20300101"
			? `${formatDateShort(start)} ~ 常設`
			: `${formatDateShort(start)} ~ ${
				formatDateShort(parseDate(block.header.endDate, block.header.endTime))
			}`;
		const name = namesFor(block.header.gachaType, csv).get(id) ?? "不明";
		const flag = flagLabel(gacha.flags);
		const rates = [
			gacha.rates.rare,
			gacha.rates.superRare,
			gacha.rates.uberRare,
			gacha.rates.legendRare,
		].join(",");
		return [
			`${period}  ver.${block.header.minVersion}~${block.header.maxVersion}`,
			`${id} ${name}${typeTag(block.header.gachaType)}${flag ? ` ${flag}` : ""}${
				gacha.guaranteed ? " 確定" : ""
			}`,
			`レート: ${rates}`,
			gacha.message ? `メッセージ: ${gacha.message}` : "",
		].filter(Boolean).join("\n");
	});
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
				"  指定したガチャIDの開催期間、レート、確定情報などを表示します。",
				"!gatya <検索語>",
				"  ガチャ名で検索します。",
				"!gatya <ID> json",
				"  元データをKBC独自のJSON形式で表示します。",
				"!gatya <ID> r",
				"  rawデータを表示します。",
			].join("\n"));
			return;
		}

		try {
			const { json, csv } = await loadGatya();
			let mode: Mode | null = null;
			let rest = args;
			const first = args[0]?.toUpperCase();
			if (first === "R" || first === "E" || first === "N") {
				mode = first;
				rest = args.slice(1);
			}

			if (rest.length === 0) {
				await sendLong(message, scheduleText(json, csv, mode));
				return;
			}

			const last = rest.at(-1)?.toLowerCase();
			const beforeLast = rest.at(-2);
			if ((last === "j" || last === "json") && beforeLast && isExactInteger(beforeLast)) {
				const id = parseInt(beforeLast, 10);
				const blocks = json.data.filter((block) => block.gachas.some((gacha) => gacha.id === id));
				await sendLong(message, JSON.stringify(blocks.map(({ raw: _raw, ...data }) => data), null, 2), "json");
				return;
			}
			if (last === "r" && beforeLast && isExactInteger(beforeLast)) {
				const id = parseInt(beforeLast, 10);
				const raws = json.data
					.filter((block) => block.gachas.some((gacha) => gacha.id === id))
					.map((block) => block.raw || `(startDate: ${block.header.startDate}) rawなし`)
					.join("\n\n");
				await sendLong(message, raws.replace(/\t/g, "    "));
				return;
			}

			const query = rest.join(" ").trim();
			if (isExactInteger(query)) {
				const details = detailText(parseInt(query, 10), mode, json, csv);
				if (details.length === 0) {
					await sendError(message, `ID ${query} は gatya.json に見つかりませんでした`);
					return;
				}
				await sendLong(message, details.join("\n\n"));
				return;
			}

			await sendLong(message, searchText(json, csv, mode, query));
		} catch (error) {
			console.error("[gatya] failed", error);
			await sendError(message, "ガチャデータの取得または処理に失敗しました");
		}
	},
};
