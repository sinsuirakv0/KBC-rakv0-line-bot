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
import type { LineCommand, ReplyableLineMessage } from "./shared.js";

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
		"!oc lineurl / !oc lineurl del",
		"  line.meを含むURL削除のON/OFF",
		"!oc media / !oc media del",
		"  画像/動画連投削除のON/OFF",
		"!oc identity [@ユーザー|userID:<p...>]",
		"  OC内の識別材料を取得し、過去スナップショットと照合",
		"!oc identity list",
		"  OC内の識別材料スナップショット履歴を表示",
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
		`初参加・即抜け監視: ${enabledText(settings.leftSoonMonitoringEnabled)}`,
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
		"4. 初参加・即抜け監視",
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
		lines.push(flagChangeText("初参加・即抜け監視", result, enabled));
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

export async function handleOcSetupReply(messageText: string, message: ReplyableLineMessage): Promise<boolean> {
	if (message.destination.kind !== "square" || !message.replyToMessageId) return false;
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
