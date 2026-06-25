import type { LineCommand } from "./shared.js";
import { argValue, parseTarget, targetLabel } from "./permissionArgs.js";
import {
	permissionDeniedText,
	permissionStore,
	requiredPermissionLabel,
	roleLabel,
	targetFromDestination,
	type PermissionRole,
} from "../permissions/store.js";

function helpText(): string {
	return [
		"!botsetting",
		"",
		"!botsetting status",
		"  このトークのBOT管理権限とBAN状態を表示します。モデレーター以上が必要です。",
		"!botsetting admin userID:<ユーザーMID> talkID:<トークMID> group",
		"  指定ユーザーを指定グループの管理者にします。管理者権限が必要です。",
		"!botsetting admin userID:<ユーザーMID> talkID:<トークMID> square",
		"  指定ユーザーを指定OCの管理者にします。管理者権限が必要です。",
		"!botsetting mod userID:<ユーザーMID> talkID:<トークMID> group",
		"  指定ユーザーを指定グループのモデレーターにします。管理者権限が必要です。",
		"!botsetting mod userID:<ユーザーMID> talkID:<トークMID> square",
		"  指定ユーザーを指定OCのモデレーターにします。管理者権限が必要です。",
	].join("\n");
}

export const botsettingCommand: LineCommand = {
	name: "botsetting",
	async execute({ message, args }) {
		const action = args[0]?.toLowerCase();
		const currentTarget = targetFromDestination(message.destination);
		if (!currentTarget) {
			await message.send("このコマンドはグループまたはOpenChatで実行してください。");
			return;
		}

		if (action === "help" || !action) {
			await message.send(helpText());
			return;
		}

		if (action === "status") {
			if (!permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "mod")) {
				await message.send(permissionDeniedText("mod"));
				return;
			}
			const target = parseTarget(args.slice(1), message.destination);
			if (!target) {
				await message.send("talkIDを指定する場合は group または square も指定してください。");
				return;
			}
			const snapshot = permissionStore.snapshot(target);
			await message.send([
				"BOT管理設定",
				`対象: ${targetLabel(target)}`,
				`トークBAN: ${snapshot.talkBanned ? "有効" : "無効"}`,
				"権限:",
				...(snapshot.roles.length
					? snapshot.roles.map((role) => `  ${role.userMid}: ${roleLabel(role.role)}`)
					: ["  なし"]),
				"ユーザーBAN:",
				...(snapshot.userBans.length
					? snapshot.userBans.map((ban) => `  ${ban.userMid}`)
					: ["  なし"]),
			].join("\n"));
			return;
		}

		if (action !== "admin" && action !== "mod") {
			await message.send("使い方: !botsetting [status|admin|mod]\n詳しくは !botsetting help");
			return;
		}

		if (!permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) {
			await message.send(permissionDeniedText("admin"));
			return;
		}

		const target = parseTarget(args.slice(1), message.destination);
		if (!target) {
			await message.send("talkIDを指定する場合は group または square も指定してください。");
			return;
		}
		const userMid = argValue(args, "userID") || argValue(args, "userId") || argValue(args, "userid");
		if (!userMid) {
			await message.send("userID:<ユーザーMID> を指定してください。");
			return;
		}

		const role = action as PermissionRole;
		const result = permissionStore.setRole(target, userMid, role, message.destination.senderMid);
		await permissionStore.flush();
		const verb = result === "created" ? "登録しました" : result === "updated" ? "更新しました" : "すでに登録されています";
		await message.send([
			`${requiredPermissionLabel(role)}を${verb}。`,
			`対象: ${targetLabel(target)}`,
			`ユーザーMID: ${userMid}`,
		].join("\n"));
	},
};
