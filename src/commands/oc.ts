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
		"!oc authority",
		"  このOCでのbot権限を表示",
		"!oc kicktest @ユーザー",
		"  強制退会リクエストの事前確認",
		"!oc kicktest @ユーザー confirm",
		"  実際に退会リクエストを送信",
		"",
		"注意: confirm付きは成功すると本当に退会します。",
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

function targetUserMid(args: string[], mentions: string[]): string | undefined {
	return mentions[0] ||
		argValue(args, "userID") ||
		argValue(args, "userId") ||
		argValue(args, "userid");
}

function errorSummary(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const raw = error as {
		name?: string;
		message?: string;
		code?: string | number;
		status?: string | number;
		reason?: string;
		data?: unknown;
	};
	const lines = [
		`name: ${raw.name ?? "(なし)"}`,
		`message: ${raw.message ?? "(なし)"}`,
	];
	if (raw.code !== undefined) lines.push(`code: ${raw.code}`);
	if (raw.status !== undefined) lines.push(`status: ${raw.status}`);
	if (raw.reason !== undefined) lines.push(`reason: ${raw.reason}`);
	if (raw.data !== undefined) {
		const data = JSON.stringify(raw.data);
		lines.push(`data: ${data.length > 300 ? `${data.slice(0, 300)}...` : data}`);
	}
	return lines.join("\n");
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

async function kickTest(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const currentTarget = targetFromDestination(message.destination);
	if (!currentTarget || !permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) {
		await message.send(permissionDeniedText("admin"));
		return;
	}
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}

	const userMid = targetUserMid(args, message.mentionMids);
	if (!userMid || !userMid.startsWith("p")) {
		await message.send("対象ユーザーをメンションするか userID:<p...> を指定してください。");
		return;
	}

	const confirmed = args.some((arg) => arg.toLowerCase() === "confirm");
	const squareMid = message.destination.scopeMid;
	const [chat, authorityResponse, targetMemberResponse] = await Promise.all([
		message.client.base.square.getSquareChat({ squareChatMid: message.destination.chatMid }),
		message.client.base.square.getSquareAuthority({ request: { squareMid } }),
		message.client.base.square.getSquareMember({ squareMemberMid: userMid }),
	]);
	const rawChat = chat as unknown as { squareChatMember?: { squareMemberMid?: string } };
	let myRole: SquareRole;
	if (rawChat.squareChatMember?.squareMemberMid) {
		const selfMember = await message.client.base.square.getSquareMember({
			squareMemberMid: rawChat.squareChatMember.squareMemberMid,
		});
		myRole = selfMember.squareMember.role;
	}
	const authority = authorityResponse.authority;
	const targetMember = targetMemberResponse.squareMember;
	const precheck = [
		"強制退会リクエスト確認",
		`OC MID: ${squareMid}`,
		`対象: ${targetMember.displayName || "(名前なし)"}`,
		`対象MID: ${targetMember.squareMemberMid}`,
		`対象状態: ${targetMember.membershipState}`,
		`対象ロール: ${roleText(targetMember.role)}`,
		`botロール: ${roleText(myRole)}`,
		`必要権限: ${roleText(authority.removeSquareMember)}`,
		`事前判定: ${canRoleExecute(myRole, authority.removeSquareMember) ? "実行可能そう" : "権限不足の可能性あり"}`,
	];

	if (!confirmed) {
		await message.send([
			...precheck,
			"",
			"まだ送信していません。",
			"実際に試す場合は同じコマンドに confirm を付けてください。",
			"成功した場合は本当に退会します。",
		].join("\n"));
		return;
	}

	try {
		const response = await message.client.base.square.deleteOtherFromSquare(userMid);
		await message.send([
			...precheck,
			"",
			"送信結果: 成功",
			`更新状態: ${response.squareMember.membershipState}`,
			`更新対象: ${response.squareMember.squareMemberMid}`,
		].join("\n"));
	} catch (error) {
		await message.send([
			...precheck,
			"",
			"送信結果: 失敗",
			errorSummary(error),
		].join("\n"));
	}
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
		if (action === "kicktest") {
			await kickTest(command);
			return;
		}
		await command.message.send("使い方: !oc [authority|kicktest]\n詳しくは !oc help");
	},
};
