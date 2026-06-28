import type { Client } from "@evex/linejs";
import {
	botStopTargetFromDestination,
	botStopTargetLabel,
	permissionDeniedText,
	permissionStore,
	requiredPermissionLabel,
	roleLabel,
	targetFromDestination,
	type PermissionChatType,
	type PermissionRole,
} from "../permissions/store.js";
import { runtimeStore } from "../runtime/store.js";
import { argValue, parseTarget, targetLabel } from "./permissionArgs.js";
import type { LineCommand, LineDestination } from "./shared.js";

type RoleSnapshot = ReturnType<typeof permissionStore.snapshot>["roles"][number];
type SquareRole = string | number | undefined;

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}日`);
	if (hours > 0) parts.push(`${hours}時間`);
	if (minutes > 0) parts.push(`${minutes}分`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
	return parts.join("");
}

function formatBytes(bytes: number): string {
	const mib = bytes / 1024 / 1024;
	return `${mib.toFixed(1)}MiB`;
}

function helpText(): string {
	return [
		"!bot",
		"",
		"!bot status",
		"  稼働状態を表示",
		"!bot stop",
		"  このトークでbotを停止",
		"!bot start",
		"  このトークでbotを再開",
		"!bot stop all",
		"  全てのトークでbotを停止",
		"!bot start all",
		"  全体停止を解除。個別停止は維持",
		"!bot admin [talkID:<MID>]",
		"  管理者/モデレーター一覧",
		"!bot setting status",
		"  自分のBOT実行権限を確認",
		"!bot setting admin/mod @ユーザー",
		"  現在のトークで登録",
		"!bot setting admin/mod del @ユーザー",
		"  現在のトークで解除",
		"!bot setting admin/mod userID:<MID> [talkID:<MID>] [del]",
		"  MID指定。talkIDは遠隔設定時のみ",
		"",
		"talkIDの種類は通常自動判定します。",
	].join("\n");
}

function settingHelpText(): string {
	return [
		"!bot setting",
		"",
		"!bot setting status",
		"  自分のBOT実行権限を確認",
		"!bot setting admin/mod @ユーザー",
		"  現在のトークで登録",
		"!bot setting admin/mod del @ユーザー",
		"  現在のトークで解除",
		"!bot setting admin/mod userID:<MID> [talkID:<MID>] [del]",
		"  MID指定。talkIDは遠隔設定時のみ",
		"",
		"talkIDの種類は通常自動判定します。",
	].join("\n");
}

function isOpenChatManagerRole(role: SquareRole): boolean {
	return role === 1 || role === 2 || role === "ADMIN" || role === "CO_ADMIN" ||
		role === "1" || role === "2";
}

async function isOpenChatManager(message: Parameters<LineCommand["execute"]>[0]["message"]): Promise<boolean> {
	if (message.destination.kind !== "square") return false;
	try {
		const response = await message.client.base.square.getSquareMember({
			squareMemberMid: message.destination.senderMid,
		});
		return isOpenChatManagerRole(response.squareMember.role);
	} catch (error) {
		console.warn(`[bot] failed to resolve OpenChat role for ${message.destination.senderMid}`, error);
		return false;
	}
}

async function canControlBotState(command: Parameters<LineCommand["execute"]>[0], all: boolean): Promise<boolean> {
	const { message } = command;
	const currentTarget = targetFromDestination(message.destination);
	if (permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) return true;
	if (all) return false;
	return await isOpenChatManager(message);
}

function botControlDeniedText(all: boolean): string {
	if (all) return permissionDeniedText("admin");
	return "実行権限がありません。BOT管理者、またはOpenChatの管理人/副官のみ操作できます。";
}

async function executeBotControl(
	command: Parameters<LineCommand["execute"]>[0],
	action: "start" | "stop",
): Promise<void> {
	const { message, args } = command;
	const all = args[1]?.toLowerCase() === "all";
	if (!await canControlBotState(command, all)) {
		await message.send(botControlDeniedText(all));
		return;
	}

	if (all) {
		if (action === "stop") {
			const result = permissionStore.stopBotAll(message.destination.senderMid);
			await permissionStore.flush();
			await message.send(result === "stopped"
				? "全体停止しました。全てのトークルーム/個人チャットでbotは動作しません。"
				: "すでに全体停止中です。");
			return;
		}

		const result = permissionStore.startBotAll();
		await permissionStore.flush();
		await message.send(result === "started"
			? "全体停止を解除しました。個別に停止していたトークは停止したままです。"
			: "全体停止は有効ではありません。個別停止は変更していません。");
		return;
	}

	const target = botStopTargetFromDestination(message.destination);
	if (action === "stop") {
		const result = permissionStore.stopBot(target, message.destination.senderMid);
		await permissionStore.flush();
		await message.send(result === "stopped"
			? `このトークでbotを停止しました。\n対象: ${botStopTargetLabel(target)}`
			: `このトークはすでに停止中です。\n対象: ${botStopTargetLabel(target)}`);
		return;
	}

	const result = permissionStore.startBot(target);
	await permissionStore.flush();
	const status = permissionStore.botStopStatus(target);
	const lines = [
		result === "started"
			? `このトークでbotを再開しました。\n対象: ${botStopTargetLabel(target)}`
			: `このトークは個別停止されていません。\n対象: ${botStopTargetLabel(target)}`,
	];
	if (status.allStopped) {
		lines.push("ただし全体停止中のため、!bot start all まで実際の動作は再開しません。");
	}
	await message.send(lines.join("\n"));
}

function rawUserName(raw: unknown): string | undefined {
	const value = raw as {
		targetProfileDetail?: { profileName?: string };
		profileName?: string;
		displayName?: string;
		name?: string;
	};
	return value.targetProfileDetail?.profileName || value.profileName || value.displayName || value.name;
}

async function resolveUserName(
	client: Client,
	chatType: PermissionChatType | LineDestination["chatType"],
	userMid: string,
	fallback?: string,
): Promise<string> {
	if (fallback) return fallback;
	try {
		if (chatType === "SQUARE") {
			const response = await client.base.square.getSquareMember({ squareMemberMid: userMid });
			return response.squareMember.displayName || "(名前なし)";
		}
		const user = await client.getUser(userMid);
		return rawUserName(user.raw) || "(名前なし)";
	} catch (error) {
		console.warn(`[bot] failed to resolve user name for ${userMid}`, error);
		return "(取得失敗)";
	}
}

async function adminListText(client: Client, chatType: PermissionChatType, roles: RoleSnapshot[]): Promise<string[]> {
	if (roles.length === 0) return ["  なし"];
	const lines: string[] = [];
	for (const role of roles) {
		const name = await resolveUserName(client, chatType, role.userMid);
		lines.push(`  ${roleLabel(role.role)}: ${name}`);
		lines.push(`  MID: ${role.userMid}`);
	}
	return lines;
}

async function sendAdminList(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const target = parseTarget(command.args.slice(1), command.message.destination);
	if (!target) {
		await command.message.send("対象トークを判定できませんでした。talkID:<MID> を指定してください。");
		return;
	}
	const snapshot = permissionStore.snapshot(target);
	await command.message.send([
		"BOT管理者一覧",
		`対象: ${targetLabel(target)}`,
		"管理者/モデレーター:",
		...(await adminListText(command.message.client, target.chatType, snapshot.roles)),
	].join("\n"));
}

async function sendPermissionStatus(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const target = parseTarget(args.slice(2), message.destination);
	if (!target) {
		await message.send("対象トークを判定できませんでした。talkID:<MID> を指定してください。");
		return;
	}
	const status = permissionStore.executionStatus(target, message.destination.senderMid);
	const name = await resolveUserName(
		message.client,
		message.destination.chatType,
		message.destination.senderMid,
		message.destination.senderName,
	);
	await message.send([
		"bot実行権限",
		`名前: ${name}`,
		`あなたの状態: ${status.banned ? "BAN" : "正常"}`,
		`権限: ${roleLabel(status.role)}`,
	].join("\n"));
}

function mentionedOrArgUserMid(command: Parameters<LineCommand["execute"]>[0]): string | undefined {
	return command.message.mentionMids[0] ||
		argValue(command.args, "userID") ||
		argValue(command.args, "userId") ||
		argValue(command.args, "userid");
}

async function executeSetting(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const action = args[1]?.toLowerCase();
	const currentTarget = targetFromDestination(message.destination);
	if (!currentTarget) {
		await message.send("このコマンドはグループまたはOpenChatで実行してください。");
		return;
	}

	if (action === "help" || !action) {
		await message.send(settingHelpText());
		return;
	}

	if (action === "status") {
		await sendPermissionStatus(command);
		return;
	}

	if (action !== "admin" && action !== "mod") {
		await message.send("使い方: !bot setting [status|admin|mod]\n詳しくは !bot setting help");
		return;
	}

	if (!permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) {
		await message.send(permissionDeniedText("admin"));
		return;
	}

	const target = parseTarget(args.slice(2), message.destination);
	if (!target) {
		await message.send("対象トークを判定できませんでした。talkID:<MID> を指定してください。");
		return;
	}
	const userMid = mentionedOrArgUserMid(command);
	if (!userMid) {
		await message.send("対象ユーザーをメンションするか userID:<MID> を指定してください。");
		return;
	}

	const role = action as PermissionRole;
	const isDelete = args.some((arg) => arg.toLowerCase() === "del");
	if (isDelete) {
		const result = permissionStore.removeRole(target, userMid, role);
		await permissionStore.flush();
		await message.send(result === "removed"
			? `${requiredPermissionLabel(role)}を解除しました。\n対象: ${targetLabel(target)}`
			: `${requiredPermissionLabel(role)}は登録されていません。\n対象: ${targetLabel(target)}`);
		return;
	}

	const result = permissionStore.setRole(target, userMid, role, message.destination.senderMid);
	await permissionStore.flush();
	const verb = result === "created" ? "登録しました" : result === "updated" ? "更新しました" : "すでに登録されています";
	await message.send([
		`${requiredPermissionLabel(role)}を${verb}。`,
		`対象: ${targetLabel(target)}`,
		`ユーザーMID: ${userMid}`,
	].join("\n"));
}

export const botCommand: LineCommand = {
	name: "bot",
	async execute(command) {
		const { message, args } = command;
		const action = args[0]?.toLowerCase();
		if (action === "help") {
			await message.send(helpText());
			return;
		}

		if (action === "admin") {
			await sendAdminList(command);
			return;
		}

		if (action === "setting") {
			await executeSetting(command);
			return;
		}

		if (action === "stop" || action === "start") {
			await executeBotControl(command, action);
			return;
		}

		if (action !== "status") {
			await message.send("使い方: !bot [status|start|stop|admin|setting]\n詳しくは !bot help");
			return;
		}

		const status = runtimeStore.snapshot();
		const stopTarget = botStopTargetFromDestination(message.destination);
		const stopStatus = permissionStore.botStopStatus(stopTarget);
		await message.send([
			"bot status",
			`動作状態: ${stopStatus.stopped ? "停止中" : "稼働中"}`,
			`全体停止: ${stopStatus.allStopped ? "有効" : "無効"}`,
			`このトークの個別停止: ${stopStatus.targetStopped ? "有効" : "無効"}`,
			`現在の稼働時間: ${formatDuration(status.sessionUptimeMs)}`,
			`累計稼働時間: ${formatDuration(status.totalUptimeMs)}`,
			`メモリ使用率: ${(status.systemUsedRatio * 100).toFixed(1)}%`,
			`プロセスRSS: ${formatBytes(status.rssBytes)}`,
			`ヒープ: ${formatBytes(status.heapUsedBytes)} / ${formatBytes(status.heapTotalBytes)}`,
		].join("\n"));
	},
};
