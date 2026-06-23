import type { LineCommand, TimeBlock } from "./shared.js";
import {
	fetchItemNameMap,
	fetchJson,
	formatDateFull,
	formatDateShort,
	formatTimeBlock,
	isExactInteger,
	parseDate,
	sendError,
	sendLong,
} from "./shared.js";

interface ItemHeader {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	minVersion: string;
	maxVersion: string;
}

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

async function loadItem(): Promise<{ json: ItemJson; names: Map<number, string> }> {
	const [json, names] = await Promise.all([
		fetchJson<ItemJson>("data/item.json"),
		fetchItemNameMap("data/item_name.csv"),
	]);
	return { json, names };
}

function isPermanent(entry: ItemEntry): boolean {
	return entry.header.endDate === "20300101";
}

function searchEntries(id: number, json: ItemJson): { entries: ItemEntry[]; fallback: boolean } {
	const byGiftType = json.data.filter((entry) => entry.gift.giftType === id);
	if (byGiftType.length > 0) return { entries: byGiftType, fallback: false };
	return {
		entries: json.data.filter((entry) => entry.gift.eventId === id),
		fallback: true,
	};
}

function detailText(entry: ItemEntry, names: Map<number, string>): string {
	const start = parseDate(entry.header.startDate, entry.header.startTime);
	const end = isPermanent(entry) ? null : parseDate(entry.header.endDate, entry.header.endTime);
	const gift = entry.gift;
	const name = names.get(gift.giftType) ?? "不明";
	const amount = gift.giftAmount > 0 ? ` x${gift.giftAmount}` : "";
	const lines = [
		`giftType: ${gift.giftType}`,
		`${formatDateFull(start)} ~ ${end ? formatDateFull(end) : "常設"}  ver.${entry.header.minVersion}~${entry.header.maxVersion}`,
		`eventId: ${gift.eventId}`,
		`${name}${amount}`,
	];
	if (gift.repeatFlag === 0) lines.push("1回限定");
	const extras = [gift.title, gift.message?.replace(/<br>/gi, "\n"), gift.url].filter(Boolean);
	if (extras.length) lines.push("", ...extras);
	if (entry.timeBlocks.length) {
		lines.push("");
		for (const block of entry.timeBlocks) lines.push(`・${formatTimeBlock(block)}`);
	}
	return lines.join("\n");
}

function scheduleText(json: ItemJson, names: Map<number, string>): string {
	const now = new Date();
	const entries = json.data
		.filter((entry) => !isPermanent(entry) && parseDate(entry.header.endDate, entry.header.endTime) > now)
		.sort((a, b) =>
			parseDate(a.header.startDate, a.header.startTime).getTime() -
			parseDate(b.header.startDate, b.header.startTime).getTime()
		);
	const lines = [`アイテム配布スケジュール 更新: ${json.updatedAt}`];
	for (const entry of entries) {
		const start = parseDate(entry.header.startDate, entry.header.startTime);
		const end = parseDate(entry.header.endDate, entry.header.endTime);
		const gift = entry.gift;
		const amount = gift.giftAmount > 0 ? ` x${gift.giftAmount}` : "";
		lines.push(`${start <= now ? "開催中" : "予定"} ${formatDateShort(start)} ~ ${formatDateShort(end)}`);
		lines.push(`  ${gift.giftType} ${names.get(gift.giftType) ?? "不明"}${amount}`);
		if (gift.title) lines.push(`  ${gift.title}`);
		lines.push("");
	}
	return lines.join("\n").trim();
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
				"  giftTypeまたはeventIdで配布内容を表示します。giftTypeで見つからない場合はeventIdでも検索します。",
				"!item <検索語>",
				"  アイテム名で検索します。",
				"!item <ID> json",
				"  元データをKBC独自のJSON形式で表示します。",
				"!item <ID> r",
				"  rawデータを表示します。",
			].join("\n"));
			return;
		}

		try {
			const { json, names } = await loadItem();
			if (args.length === 0) {
				await sendLong(message, scheduleText(json, names));
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
				await sendLong(
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
				await sendLong(
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
				await sendLong(
					message,
					`${fallback ? "giftTypeではなくeventIdで検索しました\n\n" : ""}${
						entries.map((entry) => detailText(entry, names)).join("\n\n")
					}`,
				);
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
			console.error("[item] failed", error);
			await sendError(message, "アイテムデータの取得または処理に失敗しました");
		}
	},
};
