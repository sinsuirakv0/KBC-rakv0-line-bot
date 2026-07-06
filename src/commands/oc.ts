import { ocKickHistoryStore } from "../moderation/ocKickHistory.js";
import { ocModerationSettingsStore } from "../moderation/ocModerationSettings.js";
import {
	permissionDeniedText,
	permissionStore,
	targetFromDestination,
} from "../permissions/store.js";
import { argValue } from "./permissionArgs.js";
import type { LineCommand } from "./shared.js";

type SquareRole = string | number | undefined;

const ROLE_ORDER = new Map<string, number>([
	["ADMIN", 3],
	["1", 3],
	["CO_ADMIN", 2],
	["2", 2],
	["MEMBER", 1],
	["10", 1],
]);

function helpText(): string {
	return [
		"!oc",
		"",
		"!oc lineurl",
		"  line.meを含むURLの削除を有効化",
		"!oc lineurl del",
		"  line.meを含むURLの削除を解除",
		"!oc media",
		"  同一MIDの画像/動画連投削除を有効化",
		"!oc media del",
		"  同一MIDの画像/動画連投削除を解除",
		"!oc status",
		"  OC自動削除設定を表示",
		"!oc authority",
		"  このOCでのbot権限を表示",
		"!oc kick @ユーザー 理由",
		"  指定したメンバーを強制退会",
		"!oc kick @A @B 理由",
		"  複数人をまとめて強制退会",
		"!oc kick userID:<p...> <p...> 理由",
		"  MID指定で強制退会",
		"!oc kick his",
		"  強制退会履歴を表示",
	].join("\n");
}

function roleText(role: SquareRole): string {
	if (role === 1 || role === "ADMIN") return "ADMIN";
	if (role === 2 || role === "CO_ADMIN") return "CO_ADMIN";
	if (role === 10 || role === "MEMBER") return "MEMBER";
	return String(role ?? "不明");
}

function roleRank(role: SquareRole): number {
	return ROLE_ORDER.get(String(role ?? "")) ?? 0;
}

function canRoleExecute(myRole: SquareRole, requiredRole: SquareRole): boolean {
	const required = roleRank(requiredRole);
	const mine = roleRank(myRole);
	return required > 0 && mine >= required;
}

function compactError(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const raw = error as { name?: string; message?: string; code?: string | number; status?: string | number; reason?: string };
	return raw.message || raw.reason || raw.name || String(raw.code ?? raw.status ?? "不明なエラー");
}

function formatJst(iso: string): string {
	const date = new Date(iso);
	const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
	const y = jst.getUTCFullYear();
	const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
	const d = String(jst.getUTCDate()).padStart(2, "0");
	const hh = String(jst.getUTCHours()).padStart(2, "0");
	const mm = String(jst.getUTCMinutes()).padStart(2, "0");
	return `${y}/${m}/${d} ${hh}:${mm}`;
}

function isUserIdToken(token: string): boolean {
	return /^p[0-9a-f]{8,}$/i.test(token);
}

function collectKickTargets(args: string[], mentions: string[]): { mids: string[]; reason: string } {
	const mids = new Set<string>();
	for (const mid of mentions) {
		if (mid.startsWith("p")) mids.add(mid);
	}

	const reasonParts: string[] = [];
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		const lower = arg.toLowerCase();
		const keyed = argValue([arg], "userID") || argValue([arg], "userId") || argValue([arg], "userid");
		if (keyed && keyed.startsWith("p")) {
			mids.add(keyed);
			continue;
		}
		if ((lower === "userid:" || lower === "userid" || lower === "userID:".toLowerCase()) && args[index + 1]?.startsWith("p")) {
			mids.add(args[index + 1]);
			index += 1;
			continue;
		}
		if (isUserIdToken(arg)) {
			mids.add(arg);
			continue;
		}
		if (arg.startsWith("@")) continue;
		reasonParts.push(arg);
	}

	return {
		mids: [...mids],
		reason: reasonParts.join(" ").trim(),
	};
}

function enabledText(value: boolean): string {
	return value ? "有効" : "無効";
}

function isDeleteArgs(args: string[]): boolean {
	return args.slice(1).some((arg) => {
		const value = arg.toLowerCase();
		return value === "del" || value === "off" || value === "disable" || value === "解除";
	});
}

async function canManageOpenChatSettings(command: Parameters<LineCommand["execute"]>[0]): Promise<boolean> {
	const { message } = command;
	const currentTarget = targetFromDestination(message.destination);
	if (currentTarget && permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "mod")) return true;
	if (message.destination.kind !== "square") return false;
	try {
		const member = await message.client.base.square.getSquareMember({
			squareMemberMid: message.destination.senderMid,
		});
		return roleRank(member.squareMember.role) >= roleRank("CO_ADMIN");
	} catch (error) {
		console.warn(`[oc] failed to resolve setting actor role for ${message.destination.senderMid}`, error);
		return false;
	}
}

async function sendModerationStatus(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	const settings = ocModerationSettingsStore.snapshot(message.destination.scopeMid);
	await message.send([
		"OC自動削除設定",
		`line.me URL削除: ${enabledText(settings.linkDeleteEnabled)}`,
		`画像/動画連投削除: ${enabledText(settings.mediaBurstDeleteEnabled)}`,
	].join("\n"));
}

async function executeModerationSetting(
	command: Parameters<LineCommand["execute"]>[0],
	kind: "lineurl" | "media",
): Promise<void> {
	const { message, args } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	if (!await canManageOpenChatSettings(command)) {
		await message.send("実行権限がありません。BOT管理者/モデレーター、またはこのOCの管理者/副官のみ実行できます。");
		return;
	}

	const enabled = !isDeleteArgs(args);
	const result = kind === "lineurl"
		? ocModerationSettingsStore.setLinkDelete(message.destination.scopeMid, enabled, message.destination.senderMid)
		: ocModerationSettingsStore.setMediaBurstDelete(message.destination.scopeMid, enabled, message.destination.senderMid);
	await ocModerationSettingsStore.flush();

	const label = kind === "lineurl" ? "line.me URL削除" : "画像/動画連投削除";
	if (result === "unchanged") {
		await message.send(`${label}はすでに${enabledText(enabled)}です。`);
		return;
	}
	await message.send(`${label}を${enabled ? "有効化" : "解除"}しました。`);
}

async function authorityText(command: Parameters<LineCommand["execute"]>[0]): Promise<string> {
	const { message } = command;
	if (message.destination.kind !== "square") {
		return "このコマンドはOpenChatで実行してください。";
	}

	const squareMid = message.destination.scopeMid;
	const [chat, authorityResponse] = await Promise.all([
		message.client.base.square.getSquareChat({ squareChatMid: message.destination.chatMid }),
		message.client.base.square.getSquareAuthority({ request: { squareMid } }),
	]);
	const rawChat = chat as unknown as { squareChatMember?: { squareMemberMid?: string }; squareChat?: { squareMid?: string } };
	const mySquareMemberMid = rawChat.squareChatMember?.squareMemberMid ?? "(取得失敗)";
	let myRole: SquareRole;
	if (rawChat.squareChatMember?.squareMemberMid) {
		const selfMember = await message.client.base.square.getSquareMember({
			squareMemberMid: rawChat.squareChatMember.squareMemberMid,
		});
		myRole = selfMember.squareMember.role;
	}
	const authority = authorityResponse.authority;

	return [
		"OpenChat権限",
		`OC MID: ${squareMid}`,
		`トークMID: ${message.destination.chatMid}`,
		`bot squareMemberMid: ${mySquareMemberMid}`,
		`botロール: ${roleText(myRole)}`,
		"",
		`強制退会に必要: ${roleText(authority.removeSquareMember)}`,
		`共同管理者/権限変更に必要: ${roleText(authority.grantRole)}`,
		`告知作成に必要: ${roleText(authority.createSquareChatAnnouncement)}`,
		`全体メンションに必要: ${roleText(authority.sendAllMention)}`,
		"",
		`強制退会見込み: ${canRoleExecute(myRole, authority.removeSquareMember) ? "実行可能そう" : "権限不足の可能性あり"}`,
	].join("\n");
}

async function kickHistory(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	const entries = ocKickHistoryStore.list(message.destination.scopeMid, 10);
	if (entries.length === 0) {
		await message.send("強制退会履歴はありません。");
		return;
	}
	await message.send([
		"強制退会履歴",
		...entries.map((entry, index) => [
			`${index + 1}. ${formatJst(entry.at)} ${entry.result === "success" ? "成功" : "失敗"}`,
			`対象: ${entry.targetName} (${entry.targetMid})`,
			`実行者: ${entry.actorName}`,
			`理由: ${entry.reason || "なし"}`,
			entry.error ? `エラー: ${entry.error}` : "",
		].filter(Boolean).join("\n")),
	].join("\n\n"));
}

async function executeKick(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const currentTarget = targetFromDestination(message.destination);
	if (!currentTarget || !permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "mod")) {
		await message.send(permissionDeniedText("mod"));
		return;
	}
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}

	const subAction = args[1]?.toLowerCase();
	if (subAction === "his" || subAction === "history") {
		await kickHistory(command);
		return;
	}

	const { mids, reason } = collectKickTargets(args, message.mentionMids);
	if (mids.length === 0) {
		await message.send("対象ユーザーをメンションするか userID:<p...> を指定してください。");
		return;
	}

	const actorName = message.destination.senderName || message.destination.senderMid;
	const lines = ["強制退会結果"];
	for (const userMid of mids) {
		let targetName = userMid;
		try {
			const target = await message.client.base.square.getSquareMember({ squareMemberMid: userMid });
			targetName = target.squareMember.displayName || userMid;
		} catch {
			targetName = "(取得失敗)";
		}

		try {
			const response = await message.client.base.square.deleteOtherFromSquare(userMid);
			const kickedName = response.squareMember.displayName || targetName;
			ocKickHistoryStore.record({
				squareMid: message.destination.scopeMid,
				chatMid: message.destination.chatMid,
				targetMid: userMid,
				targetName: kickedName,
				actorMid: message.destination.senderMid,
				actorName,
				reason: reason || undefined,
				result: "success",
			});
			lines.push(`成功: ${kickedName} (${userMid})`);
		} catch (error) {
			const summary = compactError(error);
			ocKickHistoryStore.record({
				squareMid: message.destination.scopeMid,
				chatMid: message.destination.chatMid,
				targetMid: userMid,
				targetName,
				actorMid: message.destination.senderMid,
				actorName,
				reason: reason || undefined,
				result: "failed",
				error: summary,
			});
			lines.push(`失敗: ${targetName} (${userMid}) ${summary}`);
		}
	}
	await ocKickHistoryStore.flush();
	if (reason) lines.push(`理由: ${reason}`);
	await message.send(lines.join("\n"));
}

export const ocCommand: LineCommand = {
	name: "oc",
	async execute(command) {
		const action = command.args[0]?.toLowerCase();
		if (!action || action === "help") {
			await command.message.send(helpText());
			return;
		}
		if (action === "authority") {
			await command.message.send(await authorityText(command));
			return;
		}
		if (action === "status") {
			await sendModerationStatus(command);
			return;
		}
		if (action === "lineurl" || action === "link" || action === "linkurl" || action === "adlink") {
			await executeModerationSetting(command, "lineurl");
			return;
		}
		if (action === "media" || action === "mediadel" || action === "mediaburst") {
			await executeModerationSetting(command, "media");
			return;
		}
		if (action === "kick") {
			await executeKick(command);
			return;
		}
		if (action === "kicktest") {
			await command.message.send("!oc kick を使用してください。confirmは不要です。");
			return;
		}
		await command.message.send("使い方: !oc [authority|kick|lineurl|media|status]\n詳しくは !oc help");
	},
};
