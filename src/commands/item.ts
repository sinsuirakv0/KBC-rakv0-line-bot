import type { LineCommand, TimeBlock } from "./shared.js";
import {
	fetchCsvMap,
	fetchItemNameData,
	fetchJson,
	fetchOptionalText,
	formatDateShort,
	isExactInteger,
	parseDate,
	parseTsvFirstColumnText,
	sendError,
	sendLongToThread,
	type ItemNameData,
} from "./shared.js";
import {
	cleanDetailLines,
	compactLine,
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

interface ItemHeader extends EventHeader {}

interface Gift {
	eventId: number;
	giftType: number;
	giftAmount: number;
	title: string;
	message: string;
	url: string;
	repeatFlag: number;
}

interface ItemEntry {
	header: ItemHeader;
	timeBlocks: TimeBlock[];
	gift: Gift;
	raw?: string;
}

interface ItemJson {
	updatedAt: string;
	data: ItemEntry[];
}

interface ItemLookup {
	names: Map<number, string>;
	details: Map<number, string>;
	packs: Map<number, string>;
}

const GATYA_ITEM_GIFT_TYPES = new Set([301, 302]);

async function loadItem(): Promise<{ json: ItemJson; lookup: ItemLookup }> {
	const [json, itemNameData, packs] = await Promise.all([
		fetchJson<ItemJson>("data/item.json"),
		fetchItemNameData("data/item_name.csv"),
		fetchCsvMap("data/item_pack.csv"),
	]);
	return {
		json,
		lookup: {
			names: itemNameData.names,
			details: itemNameData.details,
			packs,
		},
	};
}

function isPermanent(entry: ItemEntry): boolean {
	return entry.header.endDate === "20300101";
}

function isGatyaItem(entry: ItemEntry): boolean {
	return GATYA_ITEM_GIFT_TYPES.has(entry.gift.giftType);
}

function giftTypeName(giftType: number, lookup: Pick<ItemNameData, "names">): string {
	return lookup.names.get(giftType) ?? `giftType:${giftType}`;
}

function displayName(entry: ItemEntry, lookup: Pick<ItemNameData, "names">): string {
	const title = cleanDetailLines(entry.gift.title).join(" ");
	return title || giftTypeName(entry.gift.giftType, lookup);
}

function repeatLabel(repeatFlag: number): string {
	return repeatFlag === 0 ? "1回限り" : "繰り返し";
}

function isDailyLoginTextGift(giftType: number): boolean {
	return (giftType >= 900 && giftType <= 999) || (giftType >= 35_000 && giftType <= 35_999);
}

async function fetchDailyLoginText(giftType: number): Promise<string[]> {
	if (!isDailyLoginTextGift(giftType)) return [];
	const text = await fetchOptionalText(`data/DailyLoginEventText/DailyLoginEventText_${giftType}_ja.tsv`);
	if (!text) return [];
	return cleanDetailLines(parseTsvFirstColumnText(text));
}

function searchEntries(id: number, json: ItemJson): { entries: ItemEntry[]; fallback: boolean } {
	const byGiftType = json.data.filter((entry) => entry.gift.giftType === id);
	if (byGiftType.length > 0) return { entries: byGiftType, fallback: false };
	return {
		entries: json.data.filter((entry) => entry.gift.eventId === id),
		fallback: true,
	};
}

async function detailText(entry: ItemEntry, lookup: ItemLookup): Promise<string> {
	const gift = entry.gift;
	const amount = formatAmount(gift.giftAmount);
	const messageLines = cleanDetailLines(gift.message);
	const detailLines = cleanDetailLines(lookup.details.get(gift.giftType));
	const dailyLoginLines = await fetchDailyLoginText(gift.giftType);
	const packUrl = lookup.packs.get(gift.giftType);
	const tagParts = [
		isPermanent(entry) ? "常設" : "期間限定",
		entry.timeBlocks.length > 0 ? "時間帯指定あり" : "",
		repeatLabel(gift.repeatFlag),
		isGatyaItem(entry) ? "gatya扱い" : "",
	].filter(Boolean);

	return joinBlocks([
		[
			`【item詳細】${formatEventStatus(entry.header)}`,
			`名称: ${displayName(entry, lookup)}`,
			`期間: ${formatEventPeriod(entry.header)}`,
			`ver: ${formatVersionRange(entry.header)}`,
			`id: ${gift.giftType}`,
			`イベントID: ${gift.eventId}（ID帯: ${formatIdBand(gift.eventId)}）`,
			`タグ: ${tagParts.join(" / ") || "なし"}`,
		],
		[
			"開催期間:",
			...formatTimeBlockLines(entry.timeBlocks).map((line) => `・${line}`),
		],
		[
			"メッセージ:",
			...(messageLines.length > 0 ? messageLines : ["なし"]),
			...(gift.url ? [`URL: ${gift.url}`] : []),
		],
		[
			"ギフト:",
			`id:${gift.giftType} ${giftTypeName(gift.giftType, lookup)}${amount}`,
		],
		detailLines.length > 0 || packUrl
			? [
				"ギフト詳細:",
				...detailLines,
				...(packUrl ? [`公式: ${packUrl}`] : []),
			]
			: [],
		dailyLoginLines.length > 0
			? ["ログイン文:", ...dailyLoginLines]
			: [],
		[`短縮期間: ${formatEventPeriodShort(entry.header)}`],
	]);
}

function scheduleText(json: ItemJson, lookup: ItemLookup): string {
	const now = new Date();
	const entries = json.data
		.filter((entry) =>
			!isGatyaItem(entry) &&
			!isPermanent(entry) &&
			parseDate(entry.header.endDate, entry.header.endTime) > now
		)
		.sort((a, b) =>
			parseDate(a.header.startDate, a.header.startTime).getTime() -
			parseDate(b.header.startDate, b.header.startTime).getTime()
		);
	const lines = ["itemスケジュール", `更新: ${json.updatedAt}`];
	for (const entry of entries) {
		const start = parseDate(entry.header.startDate, entry.header.startTime);
		const end = parseDate(entry.header.endDate, entry.header.endTime);
		const gift = entry.gift;
		const name = giftTypeName(gift.giftType, lookup);
		const title = cleanDetailLines(gift.title).join(" ");
		lines.push("");
		lines.push(`${start <= now ? "開催中" : "予定"} ${formatDateShort(start)} ~ ${formatDateShort(end)}`);
		lines.push(`・${gift.giftType} ${name}${formatAmount(gift.giftAmount)} / eventId:${gift.eventId} (${formatIdBand(gift.eventId)})`);
		if (title && title !== name) lines.push(`  ${compactLine(title)}`);
		if (gift.repeatFlag === 0) lines.push("  1回限り");
	}
	return lines.join("\n").trim();
}

function searchText(json: ItemJson, lookup: ItemLookup, query: string): string {
	const lower = query.toLowerCase();
	const rows = new Map<number, string>();
	for (const [id, name] of lookup.names.entries()) {
		if (`${id} ${name}`.toLowerCase().includes(lower)) rows.set(id, `${id} ${name}`);
	}
	for (const entry of json.data) {
		const gift = entry.gift;
		const text = [
			String(gift.giftType),
			String(gift.eventId),
			displayName(entry, lookup),
			giftTypeName(gift.giftType, lookup),
			gift.message,
			gift.url,
		].join(" ").toLowerCase();
		if (text.includes(lower)) {
			rows.set(gift.giftType, `${gift.giftType} ${giftTypeName(gift.giftType, lookup)} / eventId:${gift.eventId}`);
		}
	}
	if (rows.size === 0) return `「${query}」は見つかりませんでした`;
	return [`「${query}」検索結果 (${rows.size}件)`, ...rows.values()].join("\n");
}

export const itemCommand: LineCommand = {
	name: "item",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!item",
				"",
				"!item",
				"  今後のアイテムスケジュールを一覧表示します。",
				"!item <ID>",
				"  giftTypeまたはeventIdで配布内容、イベントID、ギフト詳細、メッセージを表示します。",
				"!item <検索語>",
				"  アイテム名、タイトル、eventIdで検索します。",
				"!item <ID> json",
				"  元データをKBC独自のJSON形式で表示します。",
				"!item <ID> r",
				"  rawデータを表示します。",
			].join("\n"));
			return;
		}

		try {
			const { json, lookup } = await loadItem();
			if (args.length === 0) {
				await sendLongToThread(message, scheduleText(json, lookup));
				return;
			}

			const last = args.at(-1)?.toLowerCase();
			const beforeLast = args.at(-2);
			if ((last === "j" || last === "json") && beforeLast && isExactInteger(beforeLast)) {
				const id = parseInt(beforeLast, 10);
				const { entries, fallback } = searchEntries(id, json);
				if (entries.length === 0) {
					await sendError(message, `${id} は giftType/eventId のどちらでも見つかりませんでした`);
					return;
				}
				await sendLongToThread(
					message,
					`${fallback ? "giftTypeではなくeventIdで検索しました\n" : ""}${
						JSON.stringify(entries.map(({ raw: _raw, ...data }) => data), null, 2)
					}`,
					"json",
				);
				return;
			}
			if (last === "r" && beforeLast && isExactInteger(beforeLast)) {
				const id = parseInt(beforeLast, 10);
				const { entries, fallback } = searchEntries(id, json);
				if (entries.length === 0) {
					await sendError(message, `${id} は giftType/eventId のどちらでも見つかりませんでした`);
					return;
				}
				await sendLongToThread(
					message,
					`${fallback ? "giftTypeではなくeventIdで検索しました\n\n" : ""}${
						entries.map((entry) => entry.raw || `(startDate: ${entry.header.startDate}) rawなし`).join("\n\n")
					}`.replace(/\t/g, "    "),
				);
				return;
			}

			if (isExactInteger(args[0])) {
				const id = parseInt(args[0], 10);
				const { entries, fallback } = searchEntries(id, json);
				if (entries.length === 0) {
					await sendError(message, `${id} は giftType/eventId のどちらでも見つかりませんでした`);
					return;
				}
				const details = await Promise.all(entries.map((entry) => detailText(entry, lookup)));
				await sendLongToThread(
					message,
					`${fallback ? "giftTypeではなくeventIdで検索しました\n\n" : ""}${details.join("\n\n")}`,
				);
				return;
			}

			await sendLongToThread(message, searchText(json, lookup, args.join(" ")));
		} catch (error) {
			console.error("[item] failed", error);
			await sendError(message, "アイテムデータの取得または処理に失敗しました");
		}
	},
};
