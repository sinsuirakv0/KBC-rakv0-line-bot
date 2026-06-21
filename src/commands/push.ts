import type { LineCommand } from "./shared.js";
import { fetchCsvMap, fetchJson, isExactInteger } from "./shared.js";
import {
	findNextEventOccurrence,
	formatEventSchedule,
	formatNextEventOccurrence,
} from "../eventPush/format.js";
import type { SaleEntry, SaleJson } from "../eventPush/schedule.js";
import { eventPushStore } from "../eventPush/store.js";

interface EventDetails {
	name: string;
	entries: SaleEntry[];
}

async function loadEventDetails(eventId: number): Promise<EventDetails> {
	const [sale, names] = await Promise.all([
		fetchJson<SaleJson>("data/sale.json", 60_000),
		fetchCsvMap("data/sale_name.csv"),
	]);
	return {
		name: names.get(eventId) || "名称不明",
		entries: sale.data.filter((entry) =>
			!entry.stageIds.includes(104) && entry.stageIds.includes(eventId)
		),
	};
}

async function eventLabel(eventId: number): Promise<string> {
	const names = await fetchCsvMap("data/sale_name.csv");
	return `${eventId} ${names.get(eventId) || "名称不明"}`;
}

export const pushCommand: LineCommand = {
	name: "push",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() !== "event") {
			await message.send("使い方: !push event [イベントID [del]|del|status]");
			return;
		}

		const option = args[1]?.toLowerCase();
		try {
			if (option === "status") {
				const current = eventPushStore.get(message.destination);
				if (!current) {
					await message.send("このトークはイベント通知先に登録されていません。");
					return;
				}
				if (current.eventIds.length === 0) {
					await message.send("イベント通知先: 登録済み\n通知対象ID: 未登録\n時間基準: JST");
					return;
				}
				const names = await fetchCsvMap("data/sale_name.csv");
				await message.send([
					"イベント開始通知: 指定イベント",
					...current.eventIds.map((eventId) => `${eventId} ${names.get(eventId) || "名称不明"}`),
					"時間基準: JST",
				].join("\n"));
				return;
			}

			if (option === "del" || option === "off") {
				const removed = await eventPushStore.remove(message.destination);
				await message.send(removed
					? "このトークをイベント通知先から削除しました。"
					: "このトークはイベント通知先に登録されていません。");
				return;
			}

			if (option === undefined) {
				await eventPushStore.registerDestination(message.destination);
				await message.send("このトークをイベント通知先として登録しました。\nイベントIDを !push event ID で追加してください。");
				return;
			}

			if (!isExactInteger(option)) {
				await message.send("イベントIDは整数で指定してください。\n使い方: !push event [イベントID [del]|del|status]");
				return;
			}

			const eventId = Number.parseInt(option, 10);
			if (args[2]?.toLowerCase() === "del") {
				const result = await eventPushStore.removeId(message.destination, eventId);
				const text = result === "removed"
					? `${await eventLabel(eventId)} の通知を解除しました。`
					: `${eventId} はこのトークの通知対象に登録されていません。`;
				await message.send(text);
				return;
			}

			const details = await loadEventDetails(eventId);
			if (details.entries.length === 0) {
				await message.send(`ID ${eventId} は通知対象の sale.json に存在しません。`);
				return;
			}
			if (!eventPushStore.get(message.destination)) {
				await message.send("先に !push event でこのトークを通知先として登録してください。");
				return;
			}

			await eventPushStore.addId(message.destination, eventId);
			const now = new Date();
			const next = findNextEventOccurrence(eventId, details.entries, now);
			await message.send([
				`${eventId} ${details.name}`,
				"を登録しました",
				"開催期間",
				...formatEventSchedule(details.entries),
				"次の開催",
				next ? formatNextEventOccurrence(next, now) : "予定なし",
			].join("\n"));
		} catch (error) {
			console.error("[push:event] command failed", error);
			await message.send(`イベント通知の設定に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
