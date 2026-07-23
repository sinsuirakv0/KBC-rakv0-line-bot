import { LINEStruct } from "@evex/linejs/thrift";
import {
	ocIdentitySnapshotsStore,
	type OcIdentityMatch,
} from "../moderation/ocIdentitySnapshots.js";
import { ocKickHistoryStore } from "../moderation/ocKickHistory.js";
import { ocModerationSettingsStore } from "../moderation/ocModerationSettings.js";
import {
	permissionDeniedText,
	permissionStore,
	targetFromDestination,
} from "../permissions/store.js";
import { argValue } from "./permissionArgs.js";
import { sendLong, type LineCommand, type ReplyableLineMessage } from "./shared.js";

type SquareRole = string | number | undefined;
type IdentitySnapshotInput = Parameters<typeof ocIdentitySnapshotsStore.record>[0];

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
		"!oc status",
		"  OC自動削除設定を表示",
		"!oc authority",
		"  このOCでのbot権限を表示",
		"",
		"管理者向けコマンドは !oc adminhelp",
	].join("\n");
}

function adminHelpText(): string {
	return [
		"OC管理コマンド",
		"",
		"!oc setup",
		"  セットアップメニューを表示",
		"!oc modroom set",
		"  このトークを副官部屋に設定",
		"!oc modroom del",
		"  副官部屋設定を解除",
		"!oc modroom test",
		"  副官部屋への送信をテスト",
		"!oc joinmes [mention] [id] <内容> / !oc joinmes del",
		"  参加時に送信するメッセージを、このトーク単位で設定/解除",
		"!oc leavemes [mention] [id] <内容> / !oc leavemes del",
		"  退室時に送信するメッセージを、このトーク単位で設定/解除",
		"!oc lineurl / !oc lineurl del",
		"  line.meを含むURL削除のON/OFF",
		"!oc media / !oc media del",
		"  画像/動画連投削除のON/OFF",
		"!oc identity [@ユーザー|userID:<p...>]",
		"  OC内の識別材料を取得し、過去スナップショットと照合",
		"!oc identity list",
		"  OC内の識別材料スナップショット履歴を表示",
		"!oc probe",
		"  仕様未確認のSquare APIを安全条件つきで検証",
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

function compactJson(value: unknown, maxLength = 700): string {
	const seen = new WeakSet<object>();
	const text = JSON.stringify(value, (_key, current) => {
		if (typeof current === "bigint") return current.toString();
		if (current && typeof current === "object") {
			if (seen.has(current)) return "[Circular]";
			seen.add(current);
		}
		return current;
	}, 2) ?? String(value);
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1)}…`;
}

function objectKeys(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	return Object.keys(value as Record<string, unknown>);
}

function countArray(value: unknown): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

function summarizeProbeValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value !== "object") return String(value);
	const record = value as Record<string, unknown>;
	const members = countArray(record.members);
	if (members !== undefined) {
		return `members=${members} total=${String(record.totalCount ?? "?")} continuation=${record.continuationToken ? "yes" : "no"}`;
	}
	const mentionables = countArray(record.mentionables);
	if (mentionables !== undefined) {
		return `mentionables=${mentionables} continuation=${record.continuationToken ? "yes" : "no"}`;
	}
	const keys = objectKeys(value);
	return keys.length > 0 ? `keys=${keys.slice(0, 10).join(",")}` : compactJson(value, 240);
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

function collectIdentityTarget(args: string[], mentions: string[], senderMid: string): string {
	const mentioned = mentions.find((mid) => mid.startsWith("p"));
	if (mentioned) return mentioned;

	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		const lower = arg.toLowerCase();
		const keyed = argValue([arg], "userID") || argValue([arg], "userId") || argValue([arg], "userid");
		if (keyed && isUserIdToken(keyed)) return keyed;
		if ((lower === "userid:" || lower === "userid") && isUserIdToken(args[index + 1] ?? "")) {
			return args[index + 1];
		}
		if (isUserIdToken(arg)) return arg;
		if (lower === "me" || lower === "self" || arg === "自分") return senderMid;
	}
	return senderMid;
}

function valueString(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value).trim();
	return text || undefined;
}

function positiveInt64String(value: unknown): string | undefined {
	const text = valueString(value);
	if (!text) return undefined;
	const numeric = typeof value === "bigint"
		? Number(value)
		: typeof value === "number"
			? value
			: Number(text);
	return Number.isFinite(numeric) && numeric > 0 ? text : undefined;
}

function valueStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const text = valueString(item);
		return text ? [text] : [];
	});
}

function isoFromInt64(value: unknown): string | undefined {
	const numeric = typeof value === "bigint"
		? Number(value)
		: typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
	const millis = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
	const date = new Date(millis);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

function formatInt64Time(value: unknown): string {
	const raw = valueString(value);
	const iso = isoFromInt64(value);
	if (!iso) return raw ?? "(なし)";
	return `${formatJst(iso)} (${raw ?? String(value)})`;
}

function truncateText(value: string | undefined, maxLength: number): string {
	if (!value) return "(なし)";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function shortId(value: string | undefined): string {
	if (!value) return "(なし)";
	if (value.length <= 24) return value;
	return `${value.slice(0, 12)}...${value.slice(-6)}`;
}

function socialUrlsText(urls: string[]): string {
	if (urls.length === 0) return "(なし)";
	return urls.slice(0, 3).map((url) => truncateText(url, 60)).join(", ");
}

function identityMatchLines(matches: OcIdentityMatch[]): string[] {
	if (matches.length === 0) return ["過去候補: なし"];
	return [
		"過去候補:",
		...matches.map((match, index) => {
			const snapshot = match.snapshot;
			return [
				`${index + 1}. score=${match.score} ${formatJst(snapshot.at)} ${truncateText(snapshot.displayName, 20)}`,
				`   mid=${shortId(snapshot.targetMid)} reasons=${match.reasons.join(", ")}`,
			].join("\n");
		}),
	];
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

function setupStatusLines(squareMid: string): string[] {
	const settings = ocModerationSettingsStore.snapshot(squareMid);
	const lockedCount = settings.urlOffenders.filter((offender) => offender.deleteAllMessages).length;
	return [
		`line.me URL削除: ${enabledText(settings.linkDeleteEnabled)}`,
		`URL再犯の発言削除対象: ${lockedCount}人`,
		`画像/動画連投削除: ${enabledText(settings.mediaBurstDeleteEnabled)}`,
		`即抜け監視: ${enabledText(settings.leftSoonMonitoringEnabled)}`,
		`初参加・危険語処分: ${enabledText(settings.dangerWordAutoKickEnabled)}`,
		`短時間一斉参加監視: ${enabledText(settings.joinCohortWatchEnabled)}`,
		`副官部屋: ${settings.modRoomChatMid ? `設定済み (${shortId(settings.modRoomChatMid)})` : "未設定"}`,
	];
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

async function canRunOpenChatSetupMessage(message: ReplyableLineMessage): Promise<boolean> {
	const currentTarget = targetFromDestination(message.destination);
	if (currentTarget && permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) return true;
	if (message.destination.kind !== "square") return false;
	try {
		const member = await message.client.base.square.getSquareMember({
			squareMemberMid: message.destination.senderMid,
		});
		return roleRank(member.squareMember.role) >= roleRank("CO_ADMIN");
	} catch (error) {
		console.warn(`[oc] failed to resolve setup actor role for ${message.destination.senderMid}`, error);
		return false;
	}
}

async function canRunOpenChatSetup(command: Parameters<LineCommand["execute"]>[0]): Promise<boolean> {
	return canRunOpenChatSetupMessage(command.message);
}

async function sendModerationStatus(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	await message.send([
		"OC自動削除設定",
		...setupStatusLines(message.destination.scopeMid),
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

async function sendIdentitySnapshotList(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message } = command;
	const entries = ocIdentitySnapshotsStore.recent(message.destination.scopeMid, 10);
	if (entries.length === 0) {
		await message.send("このOCの識別材料スナップショットはまだありません。");
		return;
	}
	await message.send([
		"OC識別材料スナップショット履歴",
		...entries.map((entry, index) => [
			`${index + 1}. ${formatJst(entry.at)} ${truncateText(entry.displayName, 20)}`,
			`mid=${shortId(entry.targetMid)} oneOnOne=${shortId(entry.oneOnOneChatMid)} icon=${shortId(entry.profileImageObsHash)}`,
		].join("\n")),
	].join("\n\n"));
}

async function executeIdentityTest(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	if (!await canManageOpenChatSettings(command)) {
		await message.send("実行権限がありません。BOT管理者・モデレーター、またはこのOCの管理者・副官のみ実行できます。");
		return;
	}

	const subAction = args[1]?.toLowerCase();
	if (subAction === "list" || subAction === "his" || subAction === "history") {
		await sendIdentitySnapshotList(command);
		return;
	}

	const targetMid = collectIdentityTarget(args, message.mentionMids, message.destination.senderMid);
	let memberResponse;
	try {
		memberResponse = await message.client.base.square.getSquareMember({ squareMemberMid: targetMid });
	} catch (error) {
		await message.send(`識別材料を取得できませんでした。\n対象: ${targetMid}\nエラー: ${compactError(error)}`);
		return;
	}

	const member = memberResponse.squareMember;
	const memberSquareMid = valueString(member.squareMid);
	if (memberSquareMid && memberSquareMid !== message.destination.scopeMid) {
		await message.send([
			"対象はこのOCのメンバーではない可能性があります。",
			`対象squareMid: ${memberSquareMid}`,
			`このOC: ${message.destination.scopeMid}`,
		].join("\n"));
		return;
	}

	let chatMembershipState: string | undefined;
	let chatMemberRevision: string | undefined;
	let chatMemberError: string | undefined;
	try {
		const chatMemberResponse = await message.client.base.square.getSquareChatMember({
			request: {
				squareMemberMid: member.squareMemberMid || targetMid,
				squareChatMid: message.destination.chatMid,
			},
		});
		chatMembershipState = valueString(chatMemberResponse.squareChatMember.membershipState);
		chatMemberRevision = valueString(chatMemberResponse.squareChatMember.revision);
	} catch (error) {
		chatMemberError = compactError(error);
	}

	const snapshotInput: IdentitySnapshotInput = {
		squareMid: message.destination.scopeMid,
		squareChatMid: message.destination.chatMid,
		targetMid: member.squareMemberMid || targetMid,
		displayName: valueString(member.displayName),
		role: valueString(member.role),
		membershipState: valueString(member.membershipState),
		profileImageObsHash: valueString(member.profileImageObsHash),
		ableToReceiveMessage: member.ableToReceiveMessage,
		joinMessage: valueString(member.joinMessage),
		memberCreatedAt: positiveInt64String(member.createdAt),
		memberRevision: valueString(member.revision),
		selfIntroduction: valueString(member.selfIntroduction),
		socialMediaAccountUrls: valueStringArray(member.socialMediaAccountUrls),
		oneOnOneChatMid: valueString(memberResponse.oneOnOneChatMid),
		relationState: valueString(memberResponse.relation?.state),
		relationRevision: valueString(memberResponse.relation?.revision),
		contentsAttribute: valueString(memberResponse.contentsAttribute),
		chatMembershipState,
		chatMemberRevision,
		chatMemberError,
		actorMid: message.destination.senderMid,
		actorName: valueString(message.destination.senderName),
	};
	const matches = ocIdentitySnapshotsStore.findCandidates(snapshotInput, 8);
	const saved = ocIdentitySnapshotsStore.record(snapshotInput);
	await ocIdentitySnapshotsStore.flush();

	const chatMemberText = saved.chatMembershipState
		? `${saved.chatMembershipState} rev=${saved.chatMemberRevision ?? "(なし)"}`
		: saved.chatMemberError
			? `取得失敗: ${saved.chatMemberError}`
			: "(なし)";
	await message.send([
		"OC識別材料テスト",
		`保存ID: ${saved.id}`,
		`対象: ${saved.displayName ?? "(名前なし)"} (${saved.targetMid})`,
		`role: ${saved.role ?? "(なし)"}`,
		`membershipState: ${saved.membershipState ?? "(なし)"}`,
		`createdAt: ${formatInt64Time(member.createdAt)}`,
		`oneOnOneChatMid: ${saved.oneOnOneChatMid ?? "(空)"}`,
		`profileImageObsHash: ${saved.profileImageObsHash ?? "(空)"}`,
		`relation: ${saved.relationState ?? "(なし)"} rev=${saved.relationRevision ?? "(なし)"}`,
		`contentsAttribute: ${saved.contentsAttribute ?? "(なし)"}`,
		`chatMember: ${chatMemberText}`,
		`ableToReceiveMessage: ${saved.ableToReceiveMessage === undefined ? "(なし)" : String(saved.ableToReceiveMessage)}`,
		`selfIntroduction: ${truncateText(saved.selfIntroduction, 80)}`,
		`socialUrls: ${socialUrlsText(saved.socialMediaAccountUrls)}`,
		"",
		...identityMatchLines(matches),
	].join("\n"));
}

type ProbeStep = {
	name: string;
	run: () => Promise<unknown>;
};

type ProbeStepResult = {
	name: string;
	ok: boolean;
	durationMs: number;
	summary: string;
	raw?: unknown;
	error?: string;
};

function probeHelpText(): string {
	return [
		"OC API probe",
		"",
		"読み取り:",
		"!oc probe read",
		"  OC/トーク/ノート/権限/feature/emid/メンバー検索をまとめて検証",
		"!oc probe members [名前]",
		"  searchSquareChatMembersを検証",
		"!oc probe mentionables [名前]",
		"  linejs未ラップのsearchSquareChatMentionablesを検証",
		"",
		"低リスク破壊系:",
		"!oc probe destroy-bot confirm-destroy",
		"  bot自身が送った検証メッセージで削除APIを比較",
		"",
		"要注意:",
		"!oc probe hide @ユーザー confirm-hide",
		"  hideSquareMemberContentsを検証。管理者/副官は対象外",
		"!oc probe unhide @ユーザー confirm-unhide",
		"  unhideSquareMemberContentsを検証",
		"",
		"詳細な戻り値はbotログの [oc-probe] に出します。",
	].join("\n");
}

function probeId(): string {
	return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasArg(args: string[], expected: string): boolean {
	return args.some((arg) => arg.toLowerCase() === expected.toLowerCase());
}

function collectExplicitProbeTarget(args: string[], mentions: string[]): string | undefined {
	const mentioned = mentions.find((mid) => mid.startsWith("p"));
	if (mentioned) return mentioned;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		const lower = arg.toLowerCase();
		const keyed = argValue([arg], "userID") || argValue([arg], "userId") || argValue([arg], "userid");
		if (keyed && isUserIdToken(keyed)) return keyed;
		if ((lower === "userid:" || lower === "userid") && isUserIdToken(args[index + 1] ?? "")) {
			return args[index + 1];
		}
		if (isUserIdToken(arg)) return arg;
	}
	return undefined;
}

async function runProbeStep(step: ProbeStep): Promise<ProbeStepResult> {
	const started = Date.now();
	try {
		const raw = await step.run();
		return {
			name: step.name,
			ok: true,
			durationMs: Date.now() - started,
			summary: summarizeProbeValue(raw),
			raw,
		};
	} catch (error) {
		return {
			name: step.name,
			ok: false,
			durationMs: Date.now() - started,
			summary: compactError(error),
			error: compactError(error),
		};
	}
}

async function runProbeSteps(
	command: Parameters<LineCommand["execute"]>[0],
	action: string,
	steps: ProbeStep[],
): Promise<void> {
	const { message, args } = command;
	const id = probeId();
	const results: ProbeStepResult[] = [];
	for (const step of steps) {
		results.push(await runProbeStep(step));
	}
	console.log("[oc-probe]", compactJson({
		id,
		action,
		args,
		at: new Date().toISOString(),
		actorMid: message.destination.senderMid,
		actorName: message.destination.senderName,
		squareMid: message.destination.scopeMid,
		squareChatMid: message.destination.chatMid,
		results,
	}, 20_000));

	await sendLong(message, [
		`OC API probe: ${id}`,
		`action: ${action}`,
		"",
		...results.map((result) =>
			`${result.ok ? "OK" : "NG"} ${result.name} ${result.durationMs}ms\n${result.summary}`
		),
		"",
		"詳細な戻り値はbotログの [oc-probe] を確認してください。",
	].join("\n"));
}

async function searchSquareChatMentionablesRaw(
	message: ReplyableLineMessage,
	displayName: string,
): Promise<unknown> {
	return await message.client.base.request.request(
		LINEStruct.SquareService_searchSquareChatMentionables_args({
			request: {
				squareChatMid: message.destination.chatMid,
				searchOption: { displayName },
				continuationToken: "",
				limit: 20,
			},
		}),
		"searchSquareChatMentionables",
		message.client.base.square.protocolType,
		true,
		message.client.base.square.requestPath,
	);
}

async function executeProbeRead(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message } = command;
	const squareMid = message.destination.scopeMid;
	const squareChatMid = message.destination.chatMid;
	await runProbeSteps(command, "read", [
		{ name: "getSquare", run: () => message.client.base.square.getSquare({ squareMid }) },
		{ name: "getSquareChat", run: () => message.client.base.square.getSquareChat({ squareChatMid }) },
		{ name: "getSquareAuthority", run: () => message.client.base.square.getSquareAuthority({ request: { squareMid } }) },
		{ name: "getSquareChatStatus", run: () => message.client.base.square.getSquareChatStatus({ request: { squareChatMid } }) },
		{ name: "getSquareChatFeatureSet", run: () => message.client.base.square.getSquareChatFeatureSet({ request: { squareChatMid } }) },
		{ name: "getNoteStatus", run: () => message.client.base.square.getNoteStatus({ request: { squareMid } }) },
		{ name: "getSquareEmid", run: () => message.client.base.square.getSquareEmid({ request: { squareMid } }) },
		{ name: "getSquareChatEmid", run: () => message.client.base.square.getSquareChatEmid({ request: { squareChatMid } }) },
		{ name: "getSquareInfoByChatMid", run: () => message.client.base.livetalk.getSquareInfoByChatMid({ request: { squareChatMid } }) },
		{
			name: "searchSquareChatMembers",
			run: () => message.client.base.square.searchSquareChatMembers({
				squareChatMid,
				searchOption: { displayName: "", includingMe: true },
				limit: 10,
			}),
		},
		{ name: "searchSquareChatMentionables(raw)", run: () => searchSquareChatMentionablesRaw(message, "") },
	]);
}

async function executeProbeMembers(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const query = args.slice(2).filter((arg) => !arg.toLowerCase().startsWith("userid")).join(" ").trim();
	await runProbeSteps(command, "members", [
		{
			name: "searchSquareChatMembers",
			run: () => message.client.base.square.searchSquareChatMembers({
				squareChatMid: message.destination.chatMid,
				searchOption: { displayName: query, includingMe: true },
				limit: 20,
			}),
		},
	]);
}

async function executeProbeMentionables(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const query = args.slice(2).join(" ").trim();
	await runProbeSteps(command, "mentionables", [
		{ name: "searchSquareChatMentionables(raw)", run: () => searchSquareChatMentionablesRaw(message, query) },
	]);
}

async function executeProbeDestroyBot(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	if (!hasArg(args, "confirm-destroy")) {
		await message.send("bot自身の検証メッセージで削除APIを比較します。実行する場合は `!oc probe destroy-bot confirm-destroy` と送ってください。");
		return;
	}
	const makeTarget = async (label: string): Promise<string> => {
		const targetMessageId = await message.send(`OC API probe ${label} target ${probeId()}`);
		if (!targetMessageId) throw new Error(`${label}: 検証用メッセージIDを取得できませんでした`);
		return targetMessageId;
	};
	let bulkWithThreadId: string;
	let bulkWithoutThreadId: string;
	let destroyOneId: string;
	let unsendOneId: string;
	try {
		bulkWithThreadId = await makeTarget("destroyMessages-thread");
		bulkWithoutThreadId = await makeTarget("destroyMessages-no-thread");
		destroyOneId = await makeTarget("destroyMessage");
		unsendOneId = await makeTarget("unsendMessage");
	} catch (error) {
		await message.send(`検証用メッセージの作成に失敗したため中止しました: ${compactError(error)}`);
		return;
	}
	await runProbeSteps(command, "destroy-bot", [
		{
			name: "destroyMessages(threadMid empty)",
			run: () => message.client.base.square.destroyMessages({
				request: {
					squareChatMid: message.destination.chatMid,
					messageIds: [bulkWithThreadId],
					threadMid: "",
				},
			}),
		},
		{
			name: "destroyMessages(threadMid omitted)",
			run: () => message.client.base.square.destroyMessages({
				request: {
					squareChatMid: message.destination.chatMid,
					messageIds: [bulkWithoutThreadId],
				} as {
					squareChatMid: string;
					messageIds: string[];
					threadMid: string;
				},
			}),
		},
		{
			name: "destroyMessage(single)",
			run: () => message.client.base.square.destroyMessage({
				squareChatMid: message.destination.chatMid,
				messageId: destroyOneId,
			}),
		},
		{
			name: "unsendMessage(single)",
			run: () => message.client.base.square.unsendMessage({
				squareChatMid: message.destination.chatMid,
				messageId: unsendOneId,
			}),
		},
	]);
}

async function executeProbeHide(command: Parameters<LineCommand["execute"]>[0], unhide: boolean): Promise<void> {
	const { message, args } = command;
	const confirm = unhide ? "confirm-unhide" : "confirm-hide";
	if (!hasArg(args, confirm)) {
		await message.send(`対象MIDを指定し、最後に ${confirm} を付けてください。例: !oc probe ${unhide ? "unhide" : "hide"} @ユーザー ${confirm}`);
		return;
	}
	const targetMid = collectExplicitProbeTarget(args, message.mentionMids);
	if (!targetMid) {
		await message.send("対象ユーザーをメンションするか、userID:<p...> を指定してください。");
		return;
	}

	let targetName = targetMid;
	try {
		const response = await message.client.base.square.getSquareMember({ squareMemberMid: targetMid });
		targetName = response.squareMember.displayName || targetMid;
		if (!unhide && roleRank(response.squareMember.role) >= roleRank("CO_ADMIN")) {
			await message.send("安全のため、管理者/副官に対するhide検証は実行しません。検証用の一般メンバーで試してください。");
			return;
		}
	} catch (error) {
		await message.send(`対象メンバー情報を取得できませんでした: ${compactError(error)}`);
		return;
	}

	await runProbeSteps(command, unhide ? "unhide" : "hide", [
		{
			name: `${unhide ? "unhideSquareMemberContents" : "hideSquareMemberContents"}(${targetName})`,
			run: () => unhide
				? message.client.base.square.unhideSquareMemberContents({ request: { squareMemberMid: targetMid } })
				: message.client.base.square.hideSquareMemberContents({ request: { squareMemberMid: targetMid } }),
		},
	]);
}

async function executeProbe(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	if (!await canRunOpenChatSetup(command)) {
		await message.send(setupPermissionDeniedText());
		return;
	}

	const subAction = args[1]?.toLowerCase();
	if (!subAction || subAction === "help") {
		await message.send(probeHelpText());
		return;
	}
	if (subAction === "read" || subAction === "status") {
		await executeProbeRead(command);
		return;
	}
	if (subAction === "members" || subAction === "chatmembers") {
		await executeProbeMembers(command);
		return;
	}
	if (subAction === "mentionables" || subAction === "mentions") {
		await executeProbeMentionables(command);
		return;
	}
	if (subAction === "destroy-bot" || subAction === "destroyself") {
		await executeProbeDestroyBot(command);
		return;
	}
	if (subAction === "hide") {
		await executeProbeHide(command, false);
		return;
	}
	if (subAction === "unhide") {
		await executeProbeHide(command, true);
		return;
	}

	await message.send(probeHelpText());
}

function setupMenuText(squareMid: string): string {
	return [
		"OC管理セットアップ",
		"",
		"有効にしたい機能の番号を、このメッセージにリプライしてください。",
		"複数指定できます。例: 1 2 3",
		"解除は off 1 2 のように送信してください。",
		"",
		"1. line.me URL削除",
		"2. 画像/動画連投削除",
		"3. このトークを副官部屋に設定",
		"4. 即抜け監視",
		"5. 初参加・危険語処分",
		"6. 短時間一斉参加監視",
		"7. 実装済み項目をまとめてON",
		"8. 自動処理系をOFF（副官部屋は維持）",
		"9. 現在の設定を確認",
		"",
		"現在:",
		...setupStatusLines(squareMid),
	].join("\n");
}

function setupPermissionDeniedText(): string {
	return "実行権限がありません。BOT管理者、またはこのOCの管理者/副官のみ実行できます。";
}

function flagChangeText(label: string, result: "enabled" | "disabled" | "unchanged", enabled: boolean): string {
	if (result === "unchanged") return `${label}: 変更なし（${enabledText(enabled)}）`;
	return `${label}: ${enabled ? "有効化" : "解除"}`;
}

function parseSetupSelection(text: string): { numbers: number[]; disable: boolean } {
	const normalized = text.normalize("NFKC").toLowerCase();
	const disable = /(?:^|\s)(?:off|del|disable|解除|無効|オフ)(?:\s|$)/.test(normalized);
	const numbers = new Set<number>();
	for (const match of normalized.matchAll(/\d+/g)) {
		const value = Number(match[0]);
		if (Number.isInteger(value)) numbers.add(value);
	}
	if (/\bstatus\b|設定確認|確認/.test(normalized)) numbers.add(9);
	if (/\ball\b|全部|すべて/.test(normalized)) numbers.add(7);
	return { numbers: [...numbers], disable };
}

async function applySetupSelection(
	message: ReplyableLineMessage,
	numbers: number[],
	disable: boolean,
): Promise<string> {
	const squareMid = message.destination.scopeMid;
	const actorMid = message.destination.senderMid;
	const lines: string[] = ["OC管理セットアップ結果"];
	const applied = new Set<number>();

	const applyLinkDelete = (enabled: boolean): void => {
		const result = ocModerationSettingsStore.setLinkDelete(squareMid, enabled, actorMid);
		lines.push(flagChangeText("line.me URL削除", result, enabled));
	};
	const applyMediaDelete = (enabled: boolean): void => {
		const result = ocModerationSettingsStore.setMediaBurstDelete(squareMid, enabled, actorMid);
		lines.push(flagChangeText("画像/動画連投削除", result, enabled));
	};
	const applyModRoom = (enabled: boolean): void => {
		if (enabled) {
			const result = ocModerationSettingsStore.setModRoom(squareMid, message.destination.chatMid, actorMid);
			lines.push(result === "unchanged"
				? "副官部屋: 変更なし（このトークに設定済み）"
				: "副官部屋: このトークに設定");
			return;
		}
		const result = ocModerationSettingsStore.clearModRoom(squareMid, actorMid);
		lines.push(result === "unchanged" ? "副官部屋: 変更なし（未設定）" : "副官部屋: 解除");
	};
	const applyLeftSoon = (enabled: boolean): void => {
		const result = ocModerationSettingsStore.setLeftSoonMonitoring(squareMid, enabled, actorMid);
		lines.push(flagChangeText("即抜け監視", result, enabled));
	};
	const applyDangerWord = (enabled: boolean): void => {
		const result = ocModerationSettingsStore.setDangerWordAutoKick(squareMid, enabled, actorMid);
		lines.push(flagChangeText("初参加・危険語処分", result, enabled));
	};
	const applyJoinCohort = (enabled: boolean): void => {
		const result = ocModerationSettingsStore.setJoinCohortWatch(squareMid, enabled, actorMid);
		lines.push(flagChangeText("短時間一斉参加監視", result, enabled));
	};

	for (const rawNumber of numbers) {
		const number = rawNumber === 8 ? 8 : rawNumber;
		if (applied.has(number)) continue;
		applied.add(number);
		if (number === 1) applyLinkDelete(!disable);
		else if (number === 2) applyMediaDelete(!disable);
		else if (number === 3) applyModRoom(!disable);
		else if (number === 4) applyLeftSoon(!disable);
		else if (number === 5) applyDangerWord(!disable);
		else if (number === 6) applyJoinCohort(!disable);
		else if (number === 7) {
			if (disable) {
				applyLinkDelete(false);
				applyMediaDelete(false);
				applyLeftSoon(false);
				applyDangerWord(false);
				applyJoinCohort(false);
			} else {
				applyLinkDelete(true);
				applyMediaDelete(true);
				applyModRoom(true);
				applyLeftSoon(true);
				applyDangerWord(true);
				applyJoinCohort(true);
			}
		} else if (number === 8) {
			applyLinkDelete(false);
			applyMediaDelete(false);
			applyLeftSoon(false);
			applyDangerWord(false);
			applyJoinCohort(false);
		} else if (number === 9) {
			lines.push("", "現在:", ...setupStatusLines(squareMid));
		} else {
			lines.push(`${number}: 対応していない番号です。`);
		}
	}

	await ocModerationSettingsStore.flush();
	if (!applied.has(9)) lines.push("", "現在:", ...setupStatusLines(squareMid));
	return lines.join("\n");
}

async function executeSetup(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	if (!await canRunOpenChatSetup(command)) {
		await message.send(setupPermissionDeniedText());
		return;
	}

	const subAction = args[1]?.toLowerCase();
	if (subAction === "status") {
		await message.send(["OC管理セットアップ状況", ...setupStatusLines(message.destination.scopeMid)].join("\n"));
		return;
	}

	const sentId = await message.send(setupMenuText(message.destination.scopeMid));
	if (sentId) {
		ocModerationSettingsStore.recordSetupSession({
			messageId: sentId,
			squareMid: message.destination.scopeMid,
			squareChatMid: message.destination.chatMid,
			createdBy: message.destination.senderMid,
		});
		await ocModerationSettingsStore.flush();
	}
}

async function executeModRoom(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	if (!await canRunOpenChatSetup(command)) {
		await message.send(setupPermissionDeniedText());
		return;
	}

	const subAction = args[1]?.toLowerCase();
	if (subAction === "set") {
		const result = ocModerationSettingsStore.setModRoom(
			message.destination.scopeMid,
			message.destination.chatMid,
			message.destination.senderMid,
		);
		await ocModerationSettingsStore.flush();
		await message.send(result === "unchanged"
			? "このトークはすでに副官部屋として設定済みです。"
			: "このトークを副官部屋として設定しました。");
		return;
	}
	if (subAction === "del" || subAction === "off" || subAction === "解除") {
		const result = ocModerationSettingsStore.clearModRoom(message.destination.scopeMid, message.destination.senderMid);
		await ocModerationSettingsStore.flush();
		await message.send(result === "unchanged" ? "副官部屋は未設定です。" : "副官部屋設定を解除しました。");
		return;
	}
	if (subAction === "test") {
		const settings = ocModerationSettingsStore.snapshot(message.destination.scopeMid);
		if (!settings.modRoomChatMid) {
			await message.send("副官部屋が未設定です。副官部屋で !oc modroom set を実行してください。");
			return;
		}
		try {
			await message.client.base.square.sendMessage({
				squareChatMid: settings.modRoomChatMid,
				text: [
					"【副官部屋テスト】",
					"OC管理ログの送信先として設定されています。",
					`実行者: ${message.destination.senderName ?? message.destination.senderMid}`,
				].join("\n"),
			});
			await message.send("副官部屋へテストログを送信しました。");
		} catch (error) {
			await message.send(`副官部屋への送信に失敗しました: ${compactError(error)}`);
		}
		return;
	}

	await message.send([
		"副官部屋設定",
		...setupStatusLines(message.destination.scopeMid).filter((line) => line.startsWith("副官部屋:")),
		"",
		"使い方:",
		"!oc modroom set",
		"!oc modroom del",
		"!oc modroom test",
	].join("\n"));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandActionRemainder(command: Parameters<LineCommand["execute"]>[0]): string {
	const action = command.args[0];
	if (!action) return "";
	const pattern = new RegExp(`^\\s*\\S+\\s+${escapeRegExp(action)}(?:\\s+|$)([\\s\\S]*)$`, "i");
	return command.body.match(pattern)?.[1]?.trim() ?? "";
}

type MemberMessageMode = "join" | "leave";

interface MemberMessageLabels {
	command: string;
	title: string;
	actionName: string;
	personName: string;
}

const MEMBER_MESSAGE_LABELS: Record<MemberMessageMode, MemberMessageLabels> = {
	join: {
		command: "joinmes",
		title: "参加メッセージ設定",
		actionName: "参加メッセージ",
		personName: "参加者",
	},
	leave: {
		command: "leavemes",
		title: "退室メッセージ設定",
		actionName: "退室メッセージ",
		personName: "退室者",
	},
};

function memberMessageUsageText(mode: MemberMessageMode): string {
	const labels = MEMBER_MESSAGE_LABELS[mode];
	return [
		labels.title,
		"",
		"設定:",
		`!oc ${labels.command} <内容>`,
		`!oc ${labels.command} mention <内容>`,
		`!oc ${labels.command} id <内容>`,
		"",
		"解除:",
		`!oc ${labels.command} del`,
		"",
		`mention を付けると、${labels.personName}をメンションしてから内容を送信します。`,
		`id を付けると、${labels.personName}のOC内短縮IDを送信します。`,
		`本文中の <name> は${labels.personName}名に置き換わります。`,
		"副官部屋で実行した場合は、送信先を番号で選択します。",
	].join("\n");
}

interface ParsedMemberMessageInput {
	kind: "status" | "clear" | "set";
	mention: boolean;
	showId: boolean;
	text: string;
}

function parseMemberMessageInput(input: string): ParsedMemberMessageInput {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "status", mention: false, showId: false, text: "" };

	let rest = trimmed;
	let mention = false;
	let showId = false;
	let clear = false;
	while (rest) {
		const match = rest.match(/^(\S+)(?:\s+|$)([\s\S]*)$/);
		if (!match) break;
		const token = match[1].normalize("NFKC").toLowerCase();
		if (token === "mention") {
			mention = true;
			rest = (match[2] ?? "").trimStart();
			continue;
		}
		if (token === "id") {
			showId = true;
			rest = (match[2] ?? "").trimStart();
			continue;
		}
		if (["del", "off", "disable", "clear", "解除"].includes(token)) {
			clear = true;
			rest = (match[2] ?? "").trimStart();
			continue;
		}
		break;
	}

	if (clear) return { kind: "clear", mention: false, showId, text: "" };
	const text = rest.trim();
	if (!text) return { kind: showId ? "status" : "set", mention, showId, text: "" };
	return { kind: "set", mention, showId, text };
}

interface MemberMessageTargetOption {
	squareMid: string;
	squareChatMid: string;
	name: string;
	type?: SquareRole;
	configured: boolean;
}

interface MemberMessageTargetSelectionSession {
	mode: MemberMessageMode;
	squareMid: string;
	promptChatMid: string;
	createdBy: string;
	expiresAt: number;
	parsed: ParsedMemberMessageInput;
	options: MemberMessageTargetOption[];
}

const MEMBER_MESSAGE_SELECTION_TTL_MS = 10 * 60_000;
const memberMessageTargetSessions = new Map<string, MemberMessageTargetSelectionSession>();

function isMainSquareChatType(type: SquareRole): boolean {
	return type === 4 || type === "SQUARE_DEFAULT";
}

function memberMessageSetting(mode: MemberMessageMode, squareChatMid: string) {
	return mode === "join"
		? ocModerationSettingsStore.joinMessage(squareChatMid)
		: ocModerationSettingsStore.leaveMessage(squareChatMid);
}

function memberMessageSettings(mode: MemberMessageMode) {
	return mode === "join"
		? ocModerationSettingsStore.joinMessageSettings()
		: ocModerationSettingsStore.leaveMessageSettings();
}

function setMemberMessageSetting(
	mode: MemberMessageMode,
	squareMid: string,
	squareChatMid: string,
	text: string,
	mention: boolean,
	showId: boolean,
	updatedBy: string,
): "set" | "unchanged" {
	return mode === "join"
		? ocModerationSettingsStore.setJoinMessage(squareMid, squareChatMid, text, mention, showId, updatedBy)
		: ocModerationSettingsStore.setLeaveMessage(squareMid, squareChatMid, text, mention, showId, updatedBy);
}

function clearMemberMessageSetting(mode: MemberMessageMode, squareChatMid: string): "cleared" | "unchanged" {
	return mode === "join"
		? ocModerationSettingsStore.clearJoinMessage(squareChatMid)
		: ocModerationSettingsStore.clearLeaveMessage(squareChatMid);
}

function memberTargetKindText(option: Pick<MemberMessageTargetOption, "type">): string {
	return isMainSquareChatType(option.type) ? "本OC" : "サブOC";
}

function squareChatName(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const chat = value as { name?: unknown };
	const name = typeof chat.name === "string" ? chat.name.trim() : "";
	return name || undefined;
}

function squareChatMid(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const chat = value as { squareChatMid?: unknown };
	const mid = typeof chat.squareChatMid === "string" ? chat.squareChatMid.trim() : "";
	return mid || undefined;
}

function squareChatSquareMid(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const chat = value as { squareMid?: unknown };
	const mid = typeof chat.squareMid === "string" ? chat.squareMid.trim() : "";
	return mid || undefined;
}

function squareChatType(value: unknown): SquareRole {
	if (!value || typeof value !== "object") return undefined;
	const chat = value as { type?: unknown };
	return typeof chat.type === "string" || typeof chat.type === "number" ? chat.type : undefined;
}

function isJoinedChatMember(value: unknown): boolean {
	if (!value || typeof value !== "object") return true;
	const member = value as { membershipState?: unknown };
	const state = member.membershipState;
	return state === undefined || state === 1 || state === "JOINED";
}

async function addSquareChatOption(
	options: Map<string, MemberMessageTargetOption>,
	chat: unknown,
	squareMid: string,
	mode: MemberMessageMode,
): Promise<void> {
	const chatMid = squareChatMid(chat);
	const chatSquareMid = squareChatSquareMid(chat);
	if (!chatMid || chatSquareMid !== squareMid) return;
	const existing = options.get(chatMid);
	const name = squareChatName(chat) ?? existing?.name ?? (isMainSquareChatType(squareChatType(chat)) ? "本OC" : "名前未取得のサブOC");
	options.set(chatMid, {
		squareMid,
		squareChatMid: chatMid,
		name,
		type: squareChatType(chat) ?? existing?.type,
		configured: Boolean(memberMessageSetting(mode, chatMid)),
	});
}

async function addSquareChatByMid(
	command: Parameters<LineCommand["execute"]>[0],
	options: Map<string, MemberMessageTargetOption>,
	squareMid: string,
	squareChatMid: string | undefined,
	mode: MemberMessageMode,
): Promise<void> {
	if (!squareChatMid || options.has(squareChatMid)) return;
	try {
		const response = await command.message.client.base.square.getSquareChat({ squareChatMid });
		await addSquareChatOption(options, (response as { squareChat?: unknown }).squareChat, squareMid, mode);
	} catch (error) {
		console.warn("[oc] failed to resolve member message target chat", { squareChatMid, mode, error });
	}
}

async function memberMessageTargetOptions(
	command: Parameters<LineCommand["execute"]>[0],
	mode: MemberMessageMode,
): Promise<MemberMessageTargetOption[]> {
	const { message } = command;
	const squareMid = message.destination.scopeMid;
	const options = new Map<string, MemberMessageTargetOption>();
	try {
		let continuationToken = "";
		for (let page = 0; page < 10; page++) {
			const response = await message.client.base.square.getJoinedSquareChats({
				request: { continuationToken, limit: 100 },
			});
			const rawResponse = response as {
				chats?: unknown[];
				chatMembers?: Record<string, unknown>;
				continuationToken?: string;
			};
			for (const chat of rawResponse.chats ?? []) {
				const chatMid = squareChatMid(chat);
				if (chatMid && !isJoinedChatMember(rawResponse.chatMembers?.[chatMid])) continue;
				await addSquareChatOption(options, chat, squareMid, mode);
			}
			continuationToken = rawResponse.continuationToken || "";
			if (!continuationToken) break;
		}
	} catch (error) {
		console.warn("[oc] failed to fetch joined square chats", error);
	}

	await addSquareChatByMid(command, options, squareMid, message.destination.chatMid, mode);
	const settings = ocModerationSettingsStore.snapshot(squareMid);
	await addSquareChatByMid(command, options, squareMid, settings.modRoomChatMid, mode);
	for (const setting of memberMessageSettings(mode).filter((item) => item.squareMid === squareMid)) {
		await addSquareChatByMid(command, options, squareMid, setting.squareChatMid, mode);
	}

	const sorted = [...options.values()]
		.sort((left, right) => {
			const typeOrder = Number(!isMainSquareChatType(left.type)) - Number(!isMainSquareChatType(right.type));
			if (typeOrder !== 0) return typeOrder;
			return left.name.localeCompare(right.name, "ja") || left.squareChatMid.localeCompare(right.squareChatMid);
		});
	return sorted;
}

function memberTargetLine(option: MemberMessageTargetOption, index: number): string {
	return [
		`${index + 1}. ${memberTargetKindText(option)}: ${option.name}`,
		option.configured ? "設定済み" : "",
	].filter(Boolean).join(" / ");
}

function isModRoom(message: ReplyableLineMessage): boolean {
	if (message.destination.kind !== "square") return false;
	const settings = ocModerationSettingsStore.snapshot(message.destination.scopeMid);
	return Boolean(settings.modRoomChatMid && settings.modRoomChatMid === message.destination.chatMid);
}

function cleanupMemberMessageTargetSessions(): void {
	const now = Date.now();
	for (const [messageId, session] of memberMessageTargetSessions) {
		if (session.expiresAt <= now) memberMessageTargetSessions.delete(messageId);
	}
}

function selectedMemberTarget(session: MemberMessageTargetSelectionSession, text: string): MemberMessageTargetOption | undefined {
	const normalized = text.normalize("NFKC").trim().toLowerCase();
	const number = Number(normalized.match(/^\d+/)?.[0] ?? Number.NaN);
	if (Number.isInteger(number) && number >= 1 && number <= session.options.length) {
		return session.options[number - 1];
	}
	return undefined;
}

async function applyMemberMessageSetting(
	message: ReplyableLineMessage,
	parsed: ParsedMemberMessageInput,
	target: MemberMessageTargetOption,
	mode: MemberMessageMode,
): Promise<void> {
	const labels = MEMBER_MESSAGE_LABELS[mode];
	if (parsed.kind === "clear") {
		const result = clearMemberMessageSetting(mode, target.squareChatMid);
		await ocModerationSettingsStore.flush();
		await message.send(result === "unchanged"
			? `${target.name} の${labels.actionName}は未設定です。`
			: `${target.name} の${labels.actionName}を解除しました。`);
		return;
	}

	if (!parsed.text) {
		await message.send(`${memberMessageUsageText(mode)}\n\n内容が空です。`);
		return;
	}

	const result = setMemberMessageSetting(
		mode,
		target.squareMid,
		target.squareChatMid,
		parsed.text,
		parsed.mention,
		parsed.showId,
		message.destination.senderMid,
	);
	await ocModerationSettingsStore.flush();
	await message.send([
		result === "unchanged"
			? `${labels.actionName}はすでに同じ内容で設定されています。`
			: `${labels.actionName}を設定しました。`,
		`送信先: ${target.name}`,
		`メンション: ${parsed.mention ? "ON" : "OFF"}`,
		`短縮ID: ${parsed.showId ? "ON" : "OFF"}`,
		parsed.text.includes("<name>") ? "名前差し込み: ON" : "名前差し込み: OFF",
		"",
		"内容:",
		parsed.text,
	].join("\n"));
}

async function sendMemberMessageTargetSelection(
	command: Parameters<LineCommand["execute"]>[0],
	parsed: ParsedMemberMessageInput,
	mode: MemberMessageMode,
): Promise<void> {
	const { message } = command;
	const labels = MEMBER_MESSAGE_LABELS[mode];
	const options = await memberMessageTargetOptions(command, mode);
	if (options.length === 0) {
		await message.send(`送信先候補を取得できませんでした。対象トーク本体で !oc ${labels.command} を実行してください。`);
		return;
	}
	const lines = [
		`${labels.actionName}の送信先を選択してください。`,
		"このメッセージに番号でリプライすると設定します。",
		"",
		...options.map((option, index) => memberTargetLine(option, index)),
	].filter(Boolean);
	const sentId = await message.send(lines.join("\n"));
	if (!sentId) {
		await message.send("選択メッセージIDを取得できなかったため、対象トーク本体で直接設定してください。");
		return;
	}
	cleanupMemberMessageTargetSessions();
	memberMessageTargetSessions.set(sentId, {
		mode,
		squareMid: message.destination.scopeMid,
		promptChatMid: message.destination.chatMid,
		createdBy: message.destination.senderMid,
		expiresAt: Date.now() + MEMBER_MESSAGE_SELECTION_TTL_MS,
		parsed,
		options,
	});
}

async function sendMemberMessageStatus(
	command: Parameters<LineCommand["execute"]>[0],
	mode: MemberMessageMode,
): Promise<void> {
	const { message } = command;
	const labels = MEMBER_MESSAGE_LABELS[mode];
	const current = memberMessageSetting(mode, message.destination.chatMid);
	const currentTarget = (await memberMessageTargetOptions(command, mode)).find((option) =>
		option.squareChatMid === message.destination.chatMid
	);
	if (!current) {
		await message.send(`${memberMessageUsageText(mode)}\n\n現在: 未設定`);
		return;
	}
	await message.send([
		labels.title,
		"現在: 設定済み",
		currentTarget ? `送信先: ${currentTarget.name}` : "",
		`メンション: ${current.mention ? "ON" : "OFF"}`,
		`短縮ID: ${current.showId ? "ON" : "OFF"}`,
		current.text.includes("<name>") ? "名前差し込み: ON" : "名前差し込み: OFF",
		"",
		"内容:",
		current.text,
	].filter(Boolean).join("\n"));
}

async function executeMemberMessage(command: Parameters<LineCommand["execute"]>[0], mode: MemberMessageMode): Promise<void> {
	const { message } = command;
	const labels = MEMBER_MESSAGE_LABELS[mode];
	if (message.destination.kind !== "square") {
		await message.send("このコマンドはOpenChatで実行してください。");
		return;
	}
	if (message.isThreadSource) {
		await message.send(`${labels.actionName}は、スレッドではなく対象トーク本体で設定してください。`);
		return;
	}
	if (!await canRunOpenChatSetup(command)) {
		await message.send(setupPermissionDeniedText());
		return;
	}

	const parsed = parseMemberMessageInput(commandActionRemainder(command));
	if (parsed.kind === "status") {
		await sendMemberMessageStatus(command, mode);
		return;
	}

	if (isModRoom(message)) {
		await sendMemberMessageTargetSelection(command, parsed, mode);
		return;
	}

	const target: MemberMessageTargetOption = {
		squareMid: message.destination.scopeMid,
		squareChatMid: message.destination.chatMid,
		name: (await memberMessageTargetOptions(command, mode)).find((option) => option.squareChatMid === message.destination.chatMid)
			?.name ?? "このトーク",
		type: undefined,
		configured: Boolean(memberMessageSetting(mode, message.destination.chatMid)),
	};
	await applyMemberMessageSetting(message, parsed, target, mode);
}

export async function handleOcSetupReply(messageText: string, message: ReplyableLineMessage): Promise<boolean> {
	if (message.destination.kind !== "square" || !message.replyToMessageId) return false;
	const targetSession = memberMessageTargetSessions.get(message.replyToMessageId);
	if (targetSession) {
		const labels = MEMBER_MESSAGE_LABELS[targetSession.mode];
		if (targetSession.expiresAt <= Date.now()) {
			memberMessageTargetSessions.delete(message.replyToMessageId);
			await message.send(`${labels.actionName}の送信先選択は期限切れです。もう一度 !oc ${labels.command} を実行してください。`);
			return true;
		}
		if (targetSession.squareMid !== message.destination.scopeMid || targetSession.promptChatMid !== message.destination.chatMid) {
			return false;
		}
		if (!await canRunOpenChatSetupMessage(message)) {
			await message.send(setupPermissionDeniedText());
			return true;
		}
		const target = selectedMemberTarget(targetSession, messageText);
		if (!target) {
			await message.send("番号で指定してください。");
			return true;
		}
		memberMessageTargetSessions.delete(message.replyToMessageId);
		await applyMemberMessageSetting(message, targetSession.parsed, target, targetSession.mode);
		return true;
	}
	const session = ocModerationSettingsStore.findSetupSession(
		message.replyToMessageId,
		message.destination.scopeMid,
	);
	if (!session || session.squareChatMid !== message.destination.chatMid) return false;

	if (!await canRunOpenChatSetupMessage(message)) {
		await message.send(setupPermissionDeniedText());
		return true;
	}

	const selection = parseSetupSelection(messageText);
	if (selection.numbers.length === 0) {
		await message.send("番号を指定してください。例: 1 2 3 / off 1 2 / 9");
		return true;
	}
	await message.send(await applySetupSelection(message, selection.numbers, selection.disable));
	return true;
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

interface KickResultSummary {
	targetMid: string;
	targetName: string;
	result: "success" | "failed";
	error?: string;
}

async function sendKickSummaryToModRoom(
	command: Parameters<LineCommand["execute"]>[0],
	results: KickResultSummary[],
	reason: string,
): Promise<void> {
	const { message } = command;
	if (message.destination.kind !== "square" || results.length === 0) return;
	const settings = ocModerationSettingsStore.snapshot(message.destination.scopeMid);
	if (!settings.modRoomChatMid || settings.modRoomChatMid === message.destination.chatMid) return;

	const actorName = message.destination.senderName || message.destination.senderMid;
	const lines = [
		"【手動処分】OC再参加禁止",
		"",
		`実行トーク: ${shortId(message.destination.chatMid)}`,
		`実行者: ${actorName} (${message.destination.senderMid})`,
		`理由: ${reason || "なし"}`,
		"",
		"対象:",
		...results.map((result) =>
			`- ${result.result === "success" ? "成功" : "失敗"}: ${result.targetName} (${result.targetMid})${
				result.error ? ` / ${result.error}` : ""
			}`
		),
	];
	try {
		await message.client.base.square.sendMessage({
			squareChatMid: settings.modRoomChatMid,
			text: lines.join("\n"),
		});
	} catch (error) {
		console.warn("[oc] kick mod room log send failed", {
			squareMid: message.destination.scopeMid,
			modRoomChatMid: settings.modRoomChatMid,
			error,
		});
	}
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
	const results: KickResultSummary[] = [];
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
			results.push({ targetMid: userMid, targetName: kickedName, result: "success" });
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
			results.push({ targetMid: userMid, targetName, result: "failed", error: summary });
			lines.push(`失敗: ${targetName} (${userMid}) ${summary}`);
		}
	}
	await ocKickHistoryStore.flush();
	await sendKickSummaryToModRoom(command, results, reason);
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
		if (action === "adminhelp" || action === "secret" || action === "managehelp") {
			if (!await canRunOpenChatSetup(command)) {
				await command.message.send(setupPermissionDeniedText());
				return;
			}
			await command.message.send(adminHelpText());
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
		if (action === "setup") {
			await executeSetup(command);
			return;
		}
		if (action === "modroom") {
			await executeModRoom(command);
			return;
		}
		if (action === "joinmes" || action === "joinmsg" || action === "joinmessage") {
			await executeMemberMessage(command, "join");
			return;
		}
		if (
			action === "leavemes" ||
			action === "leavemsg" ||
			action === "leavemessage" ||
			action === "leftmes" ||
			action === "leftmsg" ||
			action === "leftmessage" ||
			action === "exitmes" ||
			action === "exitmsg"
		) {
			await executeMemberMessage(command, "leave");
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
		if (action === "identity" || action === "idtest" || action === "fingerprint" || action === "fp") {
			await executeIdentityTest(command);
			return;
		}
		if (action === "probe" || action === "apitest" || action === "sqtest") {
			await executeProbe(command);
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
		await command.message.send("使い方: !oc [authority|status]\n詳しくは !oc help");
	},
};
