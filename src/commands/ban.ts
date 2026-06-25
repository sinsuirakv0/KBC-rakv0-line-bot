import type { LineCommand } from "./shared.js";
import { argValue, parseTarget, targetLabel } from "./permissionArgs.js";
import { permissionDeniedText, permissionStore, targetFromDestination } from "../permissions/store.js";

function helpText(): string {
	return [
		"!ban",
		"",
		"!ban userID:<ユーザーMID>",
		"  このトークで指定ユーザーの全コマンド実行権限を剥奪します。モデレーター以上が必要です。",
		"!ban talk",
		"  このトークで管理者以外のコマンド実行権限を剥奪します。モデレーター以上が必要です。",
		"!ban userID:<ユーザーMID> talkID:<トークMID> group",
		"  別グループの指定ユーザーを遠隔BANします。",
		"!ban userID:<ユーザーMID> talkID:<トークMID> square",
		"  別OCの指定ユーザーを遠隔BANします。",
		"!ban talk talkID:<トークMID> group",
		"  別グループを遠隔でトークBANします。",
		"!ban talk talkID:<トークMID> square",
		"  別OCを遠隔でトークBANします。",
	].join("\n");
}

export const banCommand: LineCommand = {
	name: "ban",
	async execute({ message, args }) {
		const action = args[0]?.toLowerCase();
		if (action === "help" || !action) {
			await message.send(helpText());
			return;
		}

		const currentTarget = targetFromDestination(message.destination);
		if (!currentTarget) {
			await message.send("このコマンドはグループまたはOpenChatで実行してください。");
			return;
		}
		if (!permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "mod")) {
			await message.send(permissionDeniedText("mod"));
			return;
		}

		const target = parseTarget(args, message.destination);
		if (!target) {
			await message.send("talkIDを指定する場合は group または square も指定してください。");
			return;
		}

		if (action === "talk") {
			const result = permissionStore.banTalk(target, message.destination.senderMid);
			await permissionStore.flush();
			await message.send(result === "banned"
				? `このトークで管理者以外のコマンド実行権限を剥奪しました。\n対象: ${targetLabel(target)}`
				: `このトークはすでにトークBANされています。\n対象: ${targetLabel(target)}`);
			return;
		}

		const userMid = argValue(args, "userID") || argValue(args, "userId") || argValue(args, "userid");
		if (!userMid) {
			await message.send("userID:<ユーザーMID> を指定してください。\n使い方: !ban userID:<ユーザーMID>");
			return;
		}

		const result = permissionStore.banUser(target, userMid, message.destination.senderMid);
		await permissionStore.flush();
		if (result === "admin") {
			await message.send("管理者はBANできません。");
			return;
		}
		await message.send(result === "banned"
			? `指定ユーザーの全コマンド実行権限を剥奪しました。\n対象: ${targetLabel(target)}\nユーザーMID: ${userMid}`
			: `指定ユーザーはすでにBANされています。\n対象: ${targetLabel(target)}\nユーザーMID: ${userMid}`);
	},
};
