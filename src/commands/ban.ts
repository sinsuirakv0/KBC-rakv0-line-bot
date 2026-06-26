import { permissionDeniedText, permissionStore, targetFromDestination, type PermissionTarget } from "../permissions/store.js";
import { argValue, parseTarget, targetLabel } from "./permissionArgs.js";
import type { LineCommand } from "./shared.js";

function helpText(): string {
	return [
		"!ban",
		"",
		"!ban @ユーザー",
		"  ユーザーBAN。Talk側は全グループ共通",
		"!ban del @ユーザー",
		"  このトークでユーザーBAN解除",
		"!ban userID:<MID> [talkID:<MID>] [del]",
		"  MID指定。talkIDは遠隔操作時のみ",
		"!ban talk [talkID:<MID>] [del]",
		"  トーク全体のBAN/解除",
		"",
		"talkIDの種類は通常自動判定します。",
	].join("\n");
}

function userBanScopeLabel(target: PermissionTarget): string {
	return target.chatType === "SQUARE" ? targetLabel(target) : "TALK全体";
}

function mentionedOrArgUserMid(context: Parameters<LineCommand["execute"]>[0]): string | undefined {
	return context.message.mentionMids[0] ||
		argValue(context.args, "userID") ||
		argValue(context.args, "userId") ||
		argValue(context.args, "userid");
}

export const banCommand: LineCommand = {
	name: "ban",
	async execute(context) {
		const { message, args } = context;
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
			await message.send("対象トークを判定できませんでした。talkID:<MID> を指定してください。");
			return;
		}
		const isDelete = args.some((arg) => arg.toLowerCase() === "del");
		const isTalkBan = action === "talk" || args.some((arg) => arg.toLowerCase() === "talk");

		if (isTalkBan) {
			const result = isDelete
				? permissionStore.unbanTalk(target)
				: permissionStore.banTalk(target, message.destination.senderMid);
			await permissionStore.flush();
			if (isDelete) {
				await message.send(result === "removed"
					? `トークBANを解除しました。\n対象: ${targetLabel(target)}`
					: `このトークはBANされていません。\n対象: ${targetLabel(target)}`);
				return;
			}
			await message.send(result === "banned"
				? `管理者以外のコマンド実行権限を剥奪しました。\n対象: ${targetLabel(target)}`
				: `すでにトークBANされています。\n対象: ${targetLabel(target)}`);
			return;
		}

		const userMid = mentionedOrArgUserMid(context);
		if (!userMid) {
			await message.send("対象ユーザーをメンションするか userID:<MID> を指定してください。");
			return;
		}

		if (isDelete) {
			const result = permissionStore.unbanUser(target, userMid);
			await permissionStore.flush();
			await message.send(result === "removed"
				? `ユーザーBANを解除しました。\n対象: ${userBanScopeLabel(target)}`
				: `このユーザーはBANされていません。\n対象: ${userBanScopeLabel(target)}`);
			return;
		}

		const result = permissionStore.banUser(target, userMid, message.destination.senderMid);
		await permissionStore.flush();
		if (result === "admin") {
			await message.send("管理者はBANできません。");
			return;
		}
		await message.send(result === "banned"
			? `ユーザーをBANしました。\n対象: ${userBanScopeLabel(target)}`
			: `すでにBANされています。\n対象: ${userBanScopeLabel(target)}`);
	},
};
