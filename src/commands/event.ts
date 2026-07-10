import type { LineCommand, ReplyableLineMessage } from "./shared.js";
import { isExactInteger, sendError, sendLong } from "./shared.js";
import {
	eventDetailsFromCatalog,
	formatEventDetailsLines,
	loadEventCatalog,
} from "../eventPush/catalog.js";
import {
	dailyRootText,
	formatDailyDate,
	formatDailyScheduleBody,
	parseDailyDateArgument,
	tomorrowJstStart,
} from "../eventPush/daily.js";
import { sendSquareThreadWithRoot } from "../eventPush/squareThread.js";

function eventHelpText(): string {
	return [
		"!event",
		"",
		"!event <イベントID>",
		"  イベント名、開催期間、次の開催日時を表示します。",
		"!event daily",
		"  翌日24時間のイベント予定を表示します。",
		"!event daily 7/11",
		"  JSTの当年7月11日のイベント予定を表示します。YYYY/M/Dも指定できます。",
	].join("\n");
}

async function sendDailyResult(
	message: ReplyableLineMessage,
	dayStart: Date,
	body: string,
): Promise<void> {
	if (message.destination.kind === "square") {
		await sendSquareThreadWithRoot(
			message.client,
			message.destination.chatMid,
			dailyRootText(dayStart),
			body,
		);
		return;
	}
	await sendLong(message, `${formatDailyDate(dayStart)}の予定\n\n${body}`);
}

export const eventCommand: LineCommand = {
	name: "event",
	async execute({ message, args }) {
		const action = args[0]?.toLowerCase();
		if (!action || action === "help") {
			await message.send(eventHelpText());
			return;
		}

		try {
			if (action === "daily") {
				if (args.length > 2) {
					await message.send("使い方: !event daily [M/D|YYYY/M/D]");
					return;
				}
				const dayStart = args[1]
					? parseDailyDateArgument(args[1])
					: tomorrowJstStart();
				if (!dayStart) {
					await message.send("日付は 7/11 または 2026/7/11 の形式で指定してください。");
					return;
				}
				const catalog = await loadEventCatalog();
				await sendDailyResult(
					message,
					dayStart,
					formatDailyScheduleBody(catalog.sale, catalog.names, dayStart),
				);
				return;
			}

			if (!isExactInteger(action) || args.length > 1) {
				await message.send("使い方: !event <イベントID> / !event daily [日付]");
				return;
			}
			const eventId = Number.parseInt(action, 10);
			const catalog = await loadEventCatalog();
			const details = eventDetailsFromCatalog(catalog, eventId);
			if (details.entries.length === 0) {
				await sendError(message, `ID ${eventId} は通知対象の sale.json に存在しません`);
				return;
			}
			await sendLong(message, formatEventDetailsLines(details).join("\n"));
		} catch (error) {
			console.error("[event] command failed", error);
			await sendError(message, "イベントデータの取得または表示に失敗しました");
		}
	},
};
