import type { LineCommand, LineDestination } from "./shared.js";
import { fetchCsvMap, fetchJson, isExactInteger } from "./shared.js";
import {
	findNextEventOccurrence,
	formatEventSchedule,
	formatNextEventOccurrence,
} from "../eventPush/format.js";
import { isIgnoredEventEntry, type SaleEntry, type SaleJson } from "../eventPush/schedule.js";
import { eventPushStore } from "../eventPush/store.js";
import { pushReminderStore } from "../reminders/store.js";
import {
	formatReminderDate,
	parseReminderArgs,
	type ReminderParseFailureReason,
} from "../reminders/time.js";
import { pushSubscriptionStore } from "../subscriptions/store.js";

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
			!isIgnoredEventEntry(entry) && entry.stageIds.includes(eventId)
		),
	};
}

async function eventLabel(eventId: number): Promise<string> {
	const names = await fetchCsvMap("data/sale_name.csv");
	return `${eventId} ${names.get(eventId) || "名称不明"}`;
}

function pushHelpText(): string {
	return [
		"!push",
		"",
		"!push 178 <内容>",
		"  178分後に登録者へメンションして内容を送信します。",
		"!push 6/26 <内容>",
		"  指定日の00:00(JST)に登録者へメンションして内容を送信します。",
		"!push 6/26-2:00 <内容>",
		"  指定日の02:00(JST)に登録者へメンションして内容を送信します。",
		"!push status",
		"  このトークの通知設定を表示します。スケジュール更新通知とイベント開始通知の両方を確認できます。",
		"!push skd",
		"  このグループ/OCを、gatya/sale/item更新検知の通知先に登録します。個人チャットは登録できません。",
		"!push skd del",
		"  このトークのスケジュール更新通知を解除します。",
		"!push event",
		"  この個人/グループ/OCを、イベント開始通知先として登録します。",
		"!push event <イベントID>",
		"  通知するイベントIDを追加します。開催5分前、開催時刻、終了10分前に通知します。",
		"!push event <イベントID> del",
		"  指定したイベントIDの通知を解除します。",
		"!push event del",
		"  このトークのイベント開始通知設定を削除します。",
	].join("\n");
}

function reminderErrorText(reason: ReminderParseFailureReason): string {
	const usage = "使い方: !push 178 内容 / !push 6/26 内容 / !push 6/26-2:00 内容";
	if (reason === "missing-content") return `通知する内容を指定してください。\n${usage}`;
	if (reason === "invalid-time") return `時刻の指定を確認してください。\n${usage}`;
	if (reason === "past") return `過去の時刻には登録できません。\n${usage}`;
	if (reason === "too-far") return `10年より先のリマインダーは登録できません。\n${usage}`;
	return usage;
}

async function statusText(destination: LineDestination): Promise<string> {
	const skdEnabled = pushSubscriptionStore.has(destination);
	const event = eventPushStore.get(destination);
	const lines = [
		"通知設定",
		`スケジュール更新通知: ${skdEnabled ? "有効" : "無効"}`,
		`イベント開始通知: ${event ? "有効" : "無効"}`,
	];

	if (event) {
		if (event.eventIds.length === 0) {
			lines.push("イベントID: 未登録");
		} else {
			const names = await fetchCsvMap("data/sale_name.csv");
			lines.push("イベントID:");
			for (const eventId of event.eventIds) {
				lines.push(`  ${eventId} ${names.get(eventId) || "名称不明"}`);
			}
		}
	}

	lines.push(`トーク種別: ${destination.chatType}`);
	lines.push(`トークMID: ${destination.chatMid}`);
	return lines.join("\n");
}

export const pushCommand: LineCommand = {
	name: "push",
	async execute({ message, args }) {
		const action = args[0]?.toLowerCase();
		if (action === "help") {
			await message.send(pushHelpText());
			return;
		}

		if (action === "status") {
			await message.send(await statusText(message.destination));
			return;
		}

		const reminder = parseReminderArgs(args);
		if (reminder.ok) {
			const saved = await pushReminderStore.add({
				destination: message.destination,
				remindAt: reminder.remindAt,
				message: reminder.content,
			});
			await message.send([
				"リマインダーを登録しました。",
				`通知時刻: ${formatReminderDate(new Date(saved.remindAt))}`,
			].join("\n"));
			return;
		}
		if (reminder.reason !== "not-reminder") {
			await message.send(reminderErrorText(reminder.reason));
			return;
		}

		if (action === "skd") {
			const skdAction = args[1]?.toLowerCase() || "on";
			if (skdAction === "help") {
				await message.send([
					"!push skd",
					"",
					"!push skd",
					"  このグループ/OCを、gatya/sale/item更新検知の通知先に登録します。",
					"!push skd del",
					"  このトークのスケジュール更新通知を解除します。",
					"!push status",
					"  現在の通知設定を確認します。",
				].join("\n"));
				return;
			}
			if (skdAction === "del" || skdAction === "off" || skdAction === "remove" || skdAction === "disable") {
				const removed = await pushSubscriptionStore.unsubscribe(message.destination);
				await message.send(removed
					? "このトークへのスケジュール更新通知を解除しました。"
					: "このトークはスケジュール更新通知に登録されていません。");
				return;
			}
			if (skdAction !== "on") {
				await message.send("使い方: !push skd [del]");
				return;
			}
			try {
				const added = await pushSubscriptionStore.subscribe(message.destination);
				await message.send(added
					? "このトークへスケジュール更新通知を送信します。"
					: "このトークはすでにスケジュール更新通知へ登録されています。");
			} catch (error) {
				await message.send(error instanceof Error ? error.message : String(error));
			}
			return;
		}


		if (action !== "event") {
			await message.send("使い方: !push 178 内容 / !push 6/26 内容 / !push 6/26-2:00 内容 / !push [status|skd|event]\n詳しくは !push help");
			return;
		}

		const option = args[1]?.toLowerCase();
		try {
			if (option === "help") {
				await message.send([
					"!push event",
					"",
					"!push event",
					"  この個人/グループ/OCをイベント開始通知先として登録します。",
					"!push event <イベントID>",
					"  通知するイベントIDを追加します。イベントIDはsale.jsonのstageIdsから判定します。",
					"  stageIdsに102、104、112のいずれかを含むイベントは通知対象外です。",
					"!push event <イベントID> del",
					"  指定したイベントIDの通知を解除します。",
					"!push event del",
					"  このトークのイベント開始通知設定を削除します。",
					"!push status",
					"  現在の通知設定を確認します。",
				].join("\n"));
				return;
			}

			if (option === "status") {
				await message.send("!push event status は !push status に変更されました。");
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
				await message.send("イベントIDは整数で指定してください。\n使い方: !push event [イベントID [del]|del]\n設定確認: !push status");
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
