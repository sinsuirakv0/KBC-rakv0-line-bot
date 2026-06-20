import type { LineCommand } from "./shared.js";
import { pushSubscriptionStore } from "../subscriptions/store.js";

export const pushskdCommand: LineCommand = {
	name: "pushskd",
	async execute({ message, args }) {
		const action = args[0]?.toLowerCase() || "on";

		if (action === "status") {
			const enabled = pushSubscriptionStore.has(message.destination);
			await message.reply(
				`スケジュール更新通知: ${enabled ? "有効" : "無効"}\n` +
				`トーク種別: ${message.destination.chatType}\n` +
				`トークMID: ${message.destination.chatMid}\n` +
				`送信者MID: ${message.destination.senderMid}`,
			);
			return;
		}

		if (action === "off" || action === "remove" || action === "disable") {
			const removed = await pushSubscriptionStore.unsubscribe(message.destination);
			await message.reply(removed
				? "このトークへのスケジュール更新通知を解除しました。"
				: "このトークはスケジュール更新通知に登録されていません。");
			return;
		}

		if (action !== "on") {
			await message.reply("使い方: !pushskd [on|off|status]");
			return;
		}

		try {
			const added = await pushSubscriptionStore.subscribe(message.destination);
			await message.reply(added
				? "このトークへスケジュール更新通知を送信します。"
				: "このトークはすでにスケジュール更新通知へ登録されています。");
		} catch (error) {
			await message.reply(error instanceof Error ? error.message : String(error));
		}
	},
};
