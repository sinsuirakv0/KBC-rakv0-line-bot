import type { LineCommand, LineDestination } from "./shared.js";
import { fetchCsvMap, isExactInteger } from "./shared.js";
import {
	eventDetailsFromCatalog,
	formatEventDetailsLines,
	loadEventCatalog,
} from "../eventPush/catalog.js";
import { eventPushStore } from "../eventPush/store.js";
import { pushReminderStore } from "../reminders/store.js";
import {
	formatReminderDate,
	parseReminderArgs,
	type ReminderParseFailureReason,
} from "../reminders/time.js";
import { pushSubscriptionStore } from "../subscriptions/store.js";

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
		"!push event <イベントID> [-分数]",
		"  通知するイベントIDを追加します。開催時刻と終了10分前に通知します。",
		"  -5 のように指定すると、開催5分前の通知も追加します。再指定すると上書きします。",
		"!push event <イベントID> del",
		"  指定したイベントIDの通知を解除します。",
		"!push event all",
		"  全イベントの開催時刻を通知します。個別登録との重複通知はしません。",
		"!push event all del",
		"  全イベント通知を解除します。個別イベントの設定は残ります。",
		"!push event daily",
		"  OpenChatで毎日22:00(JST)に翌日のイベント予定をスレッド通知します。",
		"!push event daily del",
		"  翌日イベント予定の通知を解除します。",
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
		lines.push(`全イベントの開催通知: ${event.allEvents ? "有効" : "無効"}`);
		lines.push(`毎日22時の翌日予定: ${event.daily ? "有効" : "無効"}`);
		if (event.eventIds.length === 0) {
			lines.push("イベントID: 未登録");
		} else {
			const names = await fetchCsvMap("data/sale_name.csv");
			lines.push("イベントID:");
			for (const eventId of event.eventIds) {
				const advanceMinutes = event.advanceMinutesByEvent[String(eventId)];
				const advanceLabel = advanceMinutes ? ` / ${advanceMinutes}分前通知` : "";
				lines.push(`  ${eventId} ${names.get(eventId) || "名称不明"}${advanceLabel}`);
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
					"!push event <イベントID> [-分数]",
					"  通知するイベントIDを追加します。イベントIDはsale.jsonのstageIdsから判定します。",
					"  stageIdsに102または112を含む場合、その2ID以外は表示・通知しません。",
					"  開催時刻と終了10分前に通知し、-5 のように指定すると開催5分前にも通知します。",
					"  同じイベントIDに別の分数を指定すると、事前通知時間を上書きします。",
					"!push event <イベントID> del",
					"  指定したイベントIDの通知を解除します。",
					"!push event all",
					"  sale.jsonにある全イベントの開催時刻を通知します。終了前通知はありません。",
					"!push event all del",
					"  全イベント通知のみ解除します。個別イベントの設定は残ります。",
					"!push event daily",
					"  OpenChatで毎日22:00(JST)に翌日24時間の予定をスレッド通知します。",
					"!push event daily del",
					"  翌日イベント予定の通知を解除します。",
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
				await message.send("このトークをイベント通知先として登録しました。\nイベントIDを !push event ID で追加するか、!push event all / daily を指定してください。");
				return;
			}

			if (option === "all") {
				const allAction = args[2]?.toLowerCase();
				if (allAction === undefined) {
					const result = await eventPushStore.setAllEvents(message.destination, true);
					await message.send(result === "updated"
						? "全イベントの開催通知を有効にしました。\n個別登録と重なる開催通知は1件だけ送信します。"
						: "全イベントの開催通知はすでに有効です。");
					return;
				}
				if (allAction === "del" || allAction === "off") {
					const result = await eventPushStore.setAllEvents(message.destination, false);
					await message.send(result === "updated"
						? "全イベントの開催通知を解除しました。\n個別イベントの通知設定は維持されます。"
						: "全イベントの開催通知は有効になっていません。");
					return;
				}
				await message.send("使い方: !push event all [del]");
				return;
			}

			if (option === "daily") {
				const dailyAction = args[2]?.toLowerCase();
				if (dailyAction === undefined) {
					if (message.destination.kind !== "square") {
						await message.send("!push event daily はスレッドを作成できるOpenChatでのみ利用できます。");
						return;
					}
					const result = await eventPushStore.setDaily(message.destination, true);
					await message.send(result === "updated"
						? "毎日22:00(JST)に翌日24時間のイベント予定をスレッド通知します。"
						: "翌日イベント予定の通知はすでに有効です。");
					return;
				}
				if (dailyAction === "del" || dailyAction === "off") {
					const result = await eventPushStore.setDaily(message.destination, false);
					await message.send(result === "updated"
						? "翌日イベント予定の通知を解除しました。"
						: "翌日イベント予定の通知は有効になっていません。");
					return;
				}
				await message.send("使い方: !push event daily [del]");
				return;
			}

			if (!isExactInteger(option)) {
				await message.send("イベントIDは整数で指定してください。\n使い方: !push event [イベントID [-分数|del]|all [del]|daily [del]|del]\n設定確認: !push status");
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

			const advanceArgument = args[2];
			let advanceMinutes: number | undefined;
			if (advanceArgument !== undefined) {
				if (!/^-\d+$/.test(advanceArgument)) {
					await message.send("事前通知は -5 のように、開催何分前かを負の整数で指定してください。");
					return;
				}
				advanceMinutes = Number.parseInt(advanceArgument.slice(1), 10);
				if (!Number.isSafeInteger(advanceMinutes) || advanceMinutes <= 0) {
					await message.send("事前通知の分数は1以上の整数で指定してください。");
					return;
				}
			}
			if (args.length > 3) {
				await message.send("使い方: !push event <イベントID> [-分数]");
				return;
			}

			const details = eventDetailsFromCatalog(await loadEventCatalog(), eventId);
			if (details.entries.length === 0) {
				await message.send(`ID ${eventId} は通知対象の sale.json に存在しません。`);
				return;
			}
			if (!eventPushStore.get(message.destination)) {
				await message.send("先に !push event でこのトークを通知先として登録してください。");
				return;
			}

			await eventPushStore.addId(message.destination, eventId, advanceMinutes);
			const saved = eventPushStore.get(message.destination);
			const savedAdvanceMinutes = saved?.advanceMinutesByEvent[String(eventId)];
			const detailLines = formatEventDetailsLines(details);
			await message.send([
				detailLines[0],
				"の通知設定を保存しました",
				`通知: 開催時刻、終了10分前${savedAdvanceMinutes ? `、開催${savedAdvanceMinutes}分前` : ""}`,
				...detailLines.slice(1),
			].join("\n"));
		} catch (error) {
			console.error("[push:event] command failed", error);
			await message.send(`イベント通知の設定に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
