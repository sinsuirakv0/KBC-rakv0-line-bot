import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { getActiveHistoryJob, tryStartHistoryJob, finishHistoryJob } from "../messageLog/historyJobs.js";
import { messageLogStore, type MessageLogFlushResult, type StoredMemberState, type StoredMessageLog } from "../messageLog/store.js";
import { memberNameHistoryStore } from "../nameHistory/store.js";
import { permissionDeniedText, permissionStore, targetFromDestination } from "../permissions/store.js";
import { sendSearchResults } from "./searchPages.js";
import type { LineCommand, LineDestination, ReplyableLineMessage } from "./shared.js";

type SquareMembershipState = "LEFT" | "KICK_OUT" | "BANNED" | "JOINED";

interface MemberInfo {
	mid: string;
	name: string;
}

interface FetchSquareChatEventsOptions {
	squareChatMid: string;
	syncToken?: string;
	continuationToken?: string;
	limit?: number;
	direction?: "FORWARD" | "BACKWARD";
	inclusive?: "NONE" | "ON" | "OFF";
	fetchType?: "DEFAULT" | "PREFETCH_BY_SERVER" | "PREFETCH_BY_CLIENT";
}

interface SquareHistoryEvent {
	createdTime?: number | bigint;
	type?: string | number;
	payload?: {
		receiveMessage?: SquareHistoryMessagePayload;
		sendMessage?: SquareHistoryMessagePayload;
		notifiedCreateSquareMember?: { squareMember?: SquareHistoryMember };
		notifiedCreateSquareChatMember?: {
			chatMember?: { squareMemberMid?: string };
			peerSquareMember?: SquareHistoryMember;
		};
		notifiedJoinSquareChat?: { joinedMember?: SquareHistoryMember };
		notifiedLeaveSquareChat?: { squareMember?: SquareHistoryMember; squareMemberMid?: string };
		notifiedKickoutFromSquare?: { kickees?: SquareHistoryMember[] };
		notifiedUpdateSquareMemberProfile?: { squareMember?: SquareHistoryMember };
		notifiedUpdateSquareMember?: { squareMember?: SquareHistoryMember };
		notificationMessage?: SquareHistoryMessagePayload;
	};
}

interface SquareHistoryMember {
	squareMemberMid?: string;
	squareMid?: string;
	displayName?: string;
	membershipState?: string | number;
	role?: string | number;
	createdAt?: number | bigint;
}

interface SquareHistoryMessagePayload {
	senderDisplayName?: string;
	squareChatMid?: string;
	squareMid?: string;
	squareMessage?: {
		message?: {
			id?: string;
			from?: string;
			createdTime?: number | bigint;
			text?: string;
			contentType?: string | number;
			hasContent?: boolean;
		};
	};
}

interface LogEntry {
	id: string;
	createdAt: number;
	content: string;
}

interface ResolvedTarget {
	member: MemberInfo;
	filter: string;
	ambiguous?: MemberInfo[];
}

interface MemberRefreshRecord {
	mid: string;
	name?: string;
	state: StoredMemberState;
	role?: string;
	seenAt?: number;
	source: string;
	extra?: Record<string, unknown>;
}

interface MemberRefreshResult {
	chatMembers: number;
	directoryMembers: number;
	historyMembers: number;
	historyPages: number;
	historyReachedCutoff: boolean;
	directResolved: number;
	updated: number;
	unnamed: number;
	localFiles: number;
	syncStarted: boolean;
	errors: string[];
}

const MAX_LOG_ROWS = 1000;
const LOG_PAGE_SIZE = 10;
const DEFAULT_LOG_LOOKBACK_DAYS = 30;
const DEFAULT_LOG_LOOKBACK_MS = DEFAULT_LOG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const MEMBER_UPDATE_HISTORY_LOOKBACK_DAYS = 183;
const MEMBER_UPDATE_HISTORY_LOOKBACK_MS = MEMBER_UPDATE_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const MEMBER_UPDATE_HISTORY_MAX_PAGES = 2500;
const LOG_TARGET_SELECTION_EXPIRES_MS = 10 * 60_000;
const LOG_DIRECT_NAME_RESOLVE_LIMIT = 200;
const LOG_DIRECT_NAME_CACHE_MS = 60 * 60_000;
let activeMessageLogSync: Promise<string> | undefined;
let messageLogSyncRequested = false;

interface LogTargetSelectionSession {
	query: string;
	all: boolean;
	candidates: MemberInfo[];
	destinationKey: string;
	senderMid: string;
	expiresAt: number;
}

const targetSelectionSessions = new Map<string, LogTargetSelectionSession>();
const recentTargetSelectionSessions = new Map<string, LogTargetSelectionSession>();
const directNameCache = new Map<string, { name: string; expiresAt: number }>();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function compactSearchText(value: string): string {
	return normalizeText(value).replace(/[\s\u3000\-_.・/\\()[\]{}「」『』【】!！?？~〜～、。，．,]/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
	let index = 0;
	for (const char of needle) {
		index = haystack.indexOf(char, index);
		if (index === -1) return false;
		index += char.length;
	}
	return true;
}

function looseNameMatches(name: string, query: string): boolean {
	const normalizedName = normalizeText(name);
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return false;
	if (normalizedName.includes(normalizedQuery)) return true;
	const compactName = compactSearchText(name);
	const compactQuery = compactSearchText(query);
	if (!compactQuery) return false;
	if (compactName.includes(compactQuery) || compactQuery.includes(compactName)) return true;
	return compactQuery.length >= 2 && isSubsequence(compactQuery, compactName);
}

async function fetchSquareChatEvents(
	client: Client,
	options: FetchSquareChatEventsOptions,
) {
	return await client.base.square.fetchSquareChatEvents(options as never);
}

function formatLogTime(createdAt: number): string {
	const date = new Date(createdAt + 9 * 60 * 60 * 1000);
	const yy = String(date.getUTCFullYear()).slice(-2);
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const min = String(date.getUTCMinutes()).padStart(2, "0");
	return `${yy}/${mm}/${dd}/${hh}:${min}`;
}

function formatLogDate(createdAt: number): string {
	const date = new Date(createdAt + 9 * 60 * 60 * 1000);
	const yy = String(date.getUTCFullYear()).slice(-2);
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	return `${yy}/${mm}/${dd}`;
}

function isAllSearchToken(value: string): boolean {
	return value.toLowerCase() === "all" || value.toLowerCase() === "--all";
}

function splitLogSearchArgs(args: string[]): { all: boolean; args: string[] } {
	let all = false;
	const filtered: string[] = [];
	for (const arg of args) {
		if (isAllSearchToken(arg)) {
			all = true;
			continue;
		}
		filtered.push(arg);
	}
	return { all, args: filtered };
}

function looksLikeUserMid(value: string): boolean {
	return /^[up][0-9a-f]{8,}$/i.test(value.trim());
}

function cleanDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || looksLikeUserMid(trimmed)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(trimmed)) return undefined;
	if (/^[\p{C}\s]+$/u.test(trimmed)) return undefined;
	return trimmed;
}

function displayNameOrMid(value: string | undefined, mid: string): string {
	return cleanDisplayName(value) ?? mid;
}

function destinationKey(message: ReplyableLineMessage): string {
	return `${message.destination.kind}:${message.destination.chatMid}`;
}

function recentSelectionKey(message: ReplyableLineMessage): string {
	return `${destinationKey(message)}:${message.destination.senderMid}`;
}

function cleanupTargetSelectionSessions(): void {
	const now = Date.now();
	for (const [messageId, session] of targetSelectionSessions) {
		if (session.expiresAt <= now) targetSelectionSessions.delete(messageId);
	}
	for (const [key, session] of recentTargetSelectionSessions) {
		if (session.expiresAt <= now) recentTargetSelectionSessions.delete(key);
	}
}

function formatTargetSelectionPrompt(query: string, candidates: MemberInfo[]): string {
	return [
		`「${query}」の対象候補`,
		...candidates.slice(0, 10).map((member, index) =>
			`${index + 1}. ${displayNameOrMid(member.name, member.mid)}\nMID: ${member.mid}`
		),
		"",
		"対象番号をこのメッセージに返信してください。",
	].join("\n");
}

async function sendTargetSelection(
	message: ReplyableLineMessage,
	query: string,
	all: boolean,
	candidates: MemberInfo[],
): Promise<void> {
	cleanupTargetSelectionSessions();
	const visibleCandidates = candidates.slice(0, 10);
	const session: LogTargetSelectionSession = {
		query,
		all,
		candidates: visibleCandidates,
		destinationKey: destinationKey(message),
		senderMid: message.destination.senderMid,
		expiresAt: Date.now() + LOG_TARGET_SELECTION_EXPIRES_MS,
	};
	const messageId = await message.send(formatTargetSelectionPrompt(query, visibleCandidates));
	if (messageId) targetSelectionSessions.set(messageId, session);
	recentTargetSelectionSessions.set(recentSelectionKey(message), session);
}

async function dismissProgressMessage(message: ReplyableLineMessage, messageId?: string): Promise<void> {
	if (!messageId) return;
	try {
		if (message.destination.kind === "square") {
			await message.client.base.square.destroyMessage({
				squareChatMid: message.destination.chatMid,
				messageId,
			});
			return;
		}
		await message.client.base.talk.unsendMessage({ messageId });
	} catch (error) {
		console.warn(`[log] progress message cleanup failed for ${messageId}`, error);
	}
}

async function sendLogSearchProgress(
	message: ReplyableLineMessage,
	all: boolean,
): Promise<string | undefined> {
	return await message.send(
		(all ? [
			"全期間検索を開始します。",
			"ログ量によってはかなり重くなります。連打しないでください。",
			"探索中...",
		] : [
			"ログ検索を開始します。",
			"探索中...",
		]).join("\n"),
	);
}

function contentTypeLabel(contentType: string | number | undefined, hasContent: boolean | undefined): string {
	switch (contentType) {
		case 1:
		case "IMAGE":
			return "画像が送信されました。";
		case 2:
		case "VIDEO":
			return "動画が送信されました。";
		case 3:
		case "AUDIO":
			return "音声が送信されました。";
		case 7:
		case "STICKER":
			return "スタンプが送信されました。";
		case 14:
		case "FILE":
			return "ファイルが送信されました。";
		case 15:
		case "LOCATION":
			return "位置情報が送信されました。";
		case 0:
		case "NONE":
		case undefined:
			return hasContent ? "メディアが送信されました。" : "";
		default:
			return `メディア(${String(contentType)})が送信されました。`;
	}
}

function formatContent(payload: SquareHistoryMessagePayload): string {
	const message = payload.squareMessage?.message;
	const text = (message?.text ?? "").replace(/\s+/g, " ").trim();
	const label = contentTypeLabel(message?.contentType, message?.hasContent);
	if (label && text) return `${label} ${text}`;
	if (label) return label;
	return text || "(本文なし)";
}

function eventMessagePayload(event: SquareHistoryEvent): SquareHistoryMessagePayload | undefined {
	return event.payload?.receiveMessage ?? event.payload?.sendMessage ?? event.payload?.notificationMessage;
}

function notificationTextFromEvent(event: SquareHistoryEvent): string | undefined {
	return event.payload?.notificationMessage?.squareMessage?.message?.text?.replace(/\s+/g, " ").trim();
}

function nameFromLeaveNotification(event: SquareHistoryEvent): string | undefined {
	const text = notificationTextFromEvent(event);
	if (!text) return undefined;
	const patterns = [
		/^(.+?)(?:さん)?が(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?)(?:さん)?が(?:トーク|OpenChat|オープンチャット)から(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?) left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
		/^(.+?) has left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		const name = cleanDisplayName(match?.[1]);
		if (name) return name;
	}
	return undefined;
}

function logEntryFromEvent(event: SquareHistoryEvent, targetMid: string, filter: string): LogEntry | undefined {
	const payload = eventMessagePayload(event);
	const message = payload?.squareMessage?.message;
	if (!message || message.from !== targetMid) return undefined;
	const content = formatContent(payload);
	if (filter && !normalizeText(content).includes(normalizeText(filter))) return undefined;
	const createdAt = Number(message.createdTime ?? event.createdTime);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
	return { id: message.id || `${targetMid}:${createdAt}:${content}`, createdAt, content };
}

function messageLogFromEvent(destination: LineDestination, event: SquareHistoryEvent): StoredMessageLog | undefined {
	const payload = eventMessagePayload(event);
	if (!payload) return undefined;
	const message = payload?.squareMessage?.message;
	if (!message?.from) return undefined;
	const createdAt = Number(message.createdTime ?? event.createdTime);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
	const content = formatContent(payload);
	return {
		id: message.id || `${message.from}:${createdAt}:${content}`,
		kind: "square",
		chatMid: payload.squareChatMid || destination.chatMid,
		scopeMid: destination.scopeMid,
		chatType: "SQUARE",
		senderMid: message.from,
		senderName: payload.senderDisplayName,
		createdAt,
		content,
		contentType: message.contentType === undefined ? undefined : String(message.contentType),
		metadata: {
			source: "history-square",
			squareChatMid: payload.squareChatMid,
			squareMid: payload.squareMid,
			hasContent: message.hasContent,
			eventType: event.type,
			eventCreatedTime: event.createdTime === undefined ? undefined : String(event.createdTime),
		},
	};
}

function recordMessageLogsFromEvents(destination: LineDestination, events: SquareHistoryEvent[]): { read: number; added: number; oldestAt?: number } {
	const messages = events.flatMap((event) => {
		const message = messageLogFromEvent(destination, event);
		return message ? [message] : [];
	});
	const added = messageLogStore.recordMany(messages);
	const oldestAt = messages.reduce<number | undefined>((oldest, message) => {
		if (oldest === undefined || message.createdAt < oldest) return message.createdAt;
		return oldest;
	}, undefined);
	return { read: messages.length, added, oldestAt };
}

function eventMembers(event: SquareHistoryEvent): MemberInfo[] {
	const members: MemberInfo[] = [];
	const add = (member: SquareHistoryMember | undefined) => {
		const name = cleanDisplayName(member?.displayName);
		if (member?.squareMemberMid?.startsWith("p") && name) {
			members.push({ mid: member.squareMemberMid, name });
		}
	};
	add(event.payload?.notifiedCreateSquareMember?.squareMember);
	add(event.payload?.notifiedCreateSquareChatMember?.peerSquareMember);
	add(event.payload?.notifiedJoinSquareChat?.joinedMember);
	add(event.payload?.notifiedLeaveSquareChat?.squareMember);
	add(event.payload?.notifiedUpdateSquareMemberProfile?.squareMember);
	add(event.payload?.notifiedUpdateSquareMember?.squareMember);
	for (const member of event.payload?.notifiedKickoutFromSquare?.kickees ?? []) add(member);

	const leftMemberMid = event.payload?.notifiedLeaveSquareChat?.squareMemberMid;
	const leftMemberName = nameFromLeaveNotification(event);
	if (leftMemberMid?.startsWith("p") && leftMemberName) {
		members.push({ mid: leftMemberMid, name: leftMemberName });
	}

	const messagePayload = eventMessagePayload(event);
	const messageMid = messagePayload?.squareMessage?.message?.from;
	const messageSenderName = cleanDisplayName(messagePayload?.senderDisplayName);
	if (messageMid?.startsWith("p") && messageSenderName) {
		members.push({ mid: messageMid, name: messageSenderName });
	}

	return members;
}

function eventMemberProfiles(event: SquareHistoryEvent): Array<{
	mid: string;
	name?: string;
	state: StoredMemberState;
	role?: string;
	seenAt?: number;
	source: string;
	extra?: Record<string, unknown>;
}> {
	const profiles: Array<{
		mid: string;
		name?: string;
		state: StoredMemberState;
		role?: string;
		seenAt?: number;
		source: string;
		extra?: Record<string, unknown>;
	}> = [];
	const eventCreatedAt = Number(event.createdTime);
	const seenAt = Number.isFinite(eventCreatedAt) && eventCreatedAt > 0 ? eventCreatedAt : Date.now();
	const add = (
		member: SquareHistoryMember | undefined,
		state: StoredMemberState,
		source: string,
		extra?: Record<string, unknown>,
	) => {
		if (!member?.squareMemberMid?.startsWith("p")) return;
		profiles.push({
			mid: member.squareMemberMid,
			name: cleanDisplayName(member.displayName),
			state,
			role: member.role === undefined ? undefined : String(member.role),
			seenAt: Number(member.createdAt) > 0 ? Number(member.createdAt) : seenAt,
			source,
			extra: {
				...(member.membershipState === undefined ? {} : { membershipState: String(member.membershipState) }),
				...(member.squareMid ? { squareMid: member.squareMid } : {}),
				...(extra ?? {}),
			},
		});
	};

	add(event.payload?.notifiedCreateSquareMember?.squareMember, "JOINED", "createSquareMember");
	add(event.payload?.notifiedCreateSquareChatMember?.peerSquareMember, "JOINED", "createSquareChatMember");
	add(event.payload?.notifiedJoinSquareChat?.joinedMember, "JOINED", "joinSquareChat");
	add(event.payload?.notifiedLeaveSquareChat?.squareMember, "LEFT", "leaveSquareChat");
	add(event.payload?.notifiedUpdateSquareMemberProfile?.squareMember, "UNKNOWN", "updateProfile");
	add(event.payload?.notifiedUpdateSquareMember?.squareMember, "UNKNOWN", "updateMember");
	for (const member of event.payload?.notifiedKickoutFromSquare?.kickees ?? []) {
		add(member, "KICK_OUT", "kickoutFromSquare");
	}

	const leftMemberMid = event.payload?.notifiedLeaveSquareChat?.squareMemberMid;
	if (leftMemberMid?.startsWith("p")) {
		profiles.push({
			mid: leftMemberMid,
			name: nameFromLeaveNotification(event),
			state: "LEFT",
			seenAt,
			source: "leaveSquareChatNotification",
			extra: { notificationText: notificationTextFromEvent(event) },
		});
	}

	const messagePayload = eventMessagePayload(event);
	const message = messagePayload?.squareMessage?.message;
	if (message?.from?.startsWith("p")) {
		profiles.push({
			mid: message.from,
			name: cleanDisplayName(messagePayload?.senderDisplayName),
			state: "JOINED",
			seenAt: Number(message.createdTime) > 0 ? Number(message.createdTime) : seenAt,
			source: "message",
			extra: messagePayload?.squareMid ? { squareMid: messagePayload.squareMid } : undefined,
		});
	}

	return profiles;
}

function recordEventNames(destination: LineDestination, events: SquareHistoryEvent[]): void {
	for (const event of events) {
		const createdAt = Number(event.createdTime);
		const seenAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
		for (const member of eventMembers(event)) {
			memberNameHistoryStore.record("square", destination.scopeMid, member.mid, member.name, seenAt);
		}
		for (const member of eventMemberProfiles(event)) {
			messageLogStore.recordMember({
				kind: "square",
				chatMid: destination.chatMid,
				scopeMid: destination.scopeMid,
				chatType: "SQUARE",
				mid: member.mid,
				name: member.name,
				state: member.state,
				role: member.role,
				seenAt: member.seenAt,
				source: member.source,
				extra: member.extra,
			});
		}
	}
}

function memberStateFromRaw(value: unknown, fallback: StoredMemberState): StoredMemberState {
	const text = String(value ?? "").toUpperCase();
	if (text.includes("JOINED")) return "JOINED";
	if (text.includes("LEFT")) return "LEFT";
	if (text.includes("KICK") || text.includes("KICK_OUT")) return "KICK_OUT";
	if (text.includes("BANNED")) return "BANNED";
	return fallback;
}

function memberCreatedAt(value: unknown): number | undefined {
	const createdAt = Number(value);
	return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined;
}

function addMemberRefreshRecord(
	records: Map<string, MemberRefreshRecord>,
	member: Partial<SquareHistoryMember> | undefined,
	source: string,
	fallbackState: StoredMemberState,
): boolean {
	const mid = typeof member?.squareMemberMid === "string" ? member.squareMemberMid : undefined;
	if (!mid) return false;
	const name = cleanDisplayName(typeof member?.displayName === "string" ? member.displayName : undefined);
	const state = memberStateFromRaw(member?.membershipState, fallbackState);
	const next: MemberRefreshRecord = {
		mid,
		name,
		state,
		role: member?.role === undefined ? undefined : String(member.role),
		seenAt: memberCreatedAt(member?.createdAt),
		source,
		extra: {
			source,
			...(member?.squareMid === undefined ? {} : { squareMid: member.squareMid }),
			...(member?.membershipState === undefined ? {} : { membershipState: String(member.membershipState) }),
		},
	};
	const existing = records.get(mid);
	records.set(mid, {
		...existing,
		...next,
		name: next.name ?? existing?.name,
		role: next.role ?? existing?.role,
		seenAt: next.seenAt ?? existing?.seenAt,
		extra: { ...(existing?.extra ?? {}), ...(next.extra ?? {}) },
	});
	return true;
}

function directNameCacheKey(scopeMid: string, mid: string): string {
	return `${scopeMid}:${mid}`;
}

function cachedDirectName(scopeMid: string, mid: string): string | undefined {
	const cached = directNameCache.get(directNameCacheKey(scopeMid, mid));
	if (!cached) return undefined;
	if (cached.expiresAt <= Date.now()) {
		directNameCache.delete(directNameCacheKey(scopeMid, mid));
		return undefined;
	}
	return cached.name;
}

function setCachedDirectName(scopeMid: string, mid: string, name: string): void {
	directNameCache.set(directNameCacheKey(scopeMid, mid), {
		name,
		expiresAt: Date.now() + LOG_DIRECT_NAME_CACHE_MS,
	});
}

async function resolveSquareMemberNamesDirect(
	client: Client,
	destination: LineDestination,
	mids: string[],
): Promise<Map<string, string>> {
	if (destination.kind !== "square") return new Map();
	const uniqueMids = [...new Set(mids)]
		.filter((mid) => mid.startsWith("p"))
		.slice(0, LOG_DIRECT_NAME_RESOLVE_LIMIT);
	const resolved = new Map<string, string>();
	for (const mid of uniqueMids) {
		const cached = cachedDirectName(destination.scopeMid, mid);
		if (cached) {
			resolved.set(mid, cached);
			continue;
		}
		try {
			const response = await client.base.square.getSquareMember({ squareMemberMid: mid });
			const member = response.squareMember;
			if (member.squareMid && member.squareMid !== destination.scopeMid) continue;
			const name = cleanDisplayName(member.displayName);
			if (!name) continue;
			resolved.set(mid, name);
			setCachedDirectName(destination.scopeMid, mid, name);
			memberNameHistoryStore.record("square", destination.scopeMid, mid, name);
			messageLogStore.recordMember({
				kind: "square",
				chatMid: destination.chatMid,
				scopeMid: destination.scopeMid,
				chatType: "SQUARE",
				mid,
				name,
				state: memberStateFromRaw(member.membershipState, "UNKNOWN"),
				role: member.role === undefined ? undefined : String(member.role),
				seenAt: memberCreatedAt(member.createdAt),
				source: "directGetSquareMember",
				extra: {
					...(member.squareMid ? { squareMid: member.squareMid } : {}),
					...(member.membershipState === undefined ? {} : { membershipState: String(member.membershipState) }),
				},
			});
		} catch (error) {
			console.warn(`[log] direct member name resolve failed for ${mid}`, error);
		}
	}
	return resolved;
}

async function scanRecentMemberHistoryForNames(
	client: Client,
	destination: LineDestination,
	cutoffAt: number,
	records: Map<string, MemberRefreshRecord>,
): Promise<{ members: number; pages: number; reachedCutoff: boolean; errors: string[] }> {
	const namedMembers = new Set<string>();
	const errors: string[] = [];
	let pages = 0;
	let reachedCutoff = false;
	let continuationToken: string | undefined;
	let syncToken: string | undefined;

	const processEvents = (events: SquareHistoryEvent[]) => {
		recordEventNames(destination, events);
		for (const event of events) {
			for (const member of eventMembers(event)) {
				if (cleanDisplayName(member.name)) {
					namedMembers.add(member.mid);
					const existing = records.get(member.mid);
					records.set(member.mid, {
						mid: member.mid,
						name: member.name,
						state: existing?.state ?? "UNKNOWN",
						role: existing?.role,
						seenAt: existing?.seenAt,
						source: existing?.source ?? "historyEventName",
						extra: { ...(existing?.extra ?? {}), historySource: "eventMembers" },
					});
				}
			}
			for (const member of eventMemberProfiles(event)) {
				if (cleanDisplayName(member.name)) namedMembers.add(member.mid);
				const existing = records.get(member.mid);
				records.set(member.mid, {
					mid: member.mid,
					name: member.name ?? existing?.name,
					state: member.state,
					role: member.role ?? existing?.role,
					seenAt: member.seenAt ?? existing?.seenAt,
					source: member.source,
					extra: { ...(existing?.extra ?? {}), ...(member.extra ?? {}) },
				});
			}
			const createdAt = Number(event.createdTime);
			if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < cutoffAt) {
				reachedCutoff = true;
			}
		}
	};

	try {
		for (let page = 0; page < 10; page++) {
			const response = await fetchSquareChatEvents(client, {
				squareChatMid: destination.chatMid,
				syncToken,
				limit: 100,
				direction: "FORWARD",
				fetchType: "DEFAULT",
			});
			pages += 1;
			syncToken = response.syncToken;
			processEvents(response.events as SquareHistoryEvent[]);
			if (response.events.length === 0) break;
			await sleep(50);
		}
		if (!syncToken) return { members: namedMembers.size, pages, reachedCutoff, errors };

		for (let page = 0; page < MEMBER_UPDATE_HISTORY_MAX_PAGES; page++) {
			const response = await fetchSquareChatEvents(client, {
				squareChatMid: destination.chatMid,
				syncToken,
				direction: "BACKWARD",
				inclusive: page === 0 ? "ON" : "OFF",
				fetchType: "DEFAULT",
				limit: 100,
				...(continuationToken ? { continuationToken } : {}),
			});
			pages += 1;
			syncToken = response.syncToken;
			continuationToken = response.continuationToken || undefined;
			processEvents(response.events as SquareHistoryEvent[]);
			if (reachedCutoff || !continuationToken) break;
			await sleep(80);
		}
	} catch (error) {
		errors.push(`recent history: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { members: namedMembers.size, pages, reachedCutoff, errors };
}

async function refreshSquareMemberJson(
	client: Client,
	destination: LineDestination,
): Promise<MemberRefreshResult> {
	if (destination.kind !== "square") throw new Error("メンバーJSON更新はOpenChatでのみ使用できます");
	const records = new Map<string, MemberRefreshRecord>();
	const errors: string[] = [];
	let chatMembers = 0;
	let directoryMembers = 0;
	let historyMembers = 0;
	let historyPages = 0;
	let historyReachedCutoff = false;
	let directResolved = 0;

	try {
		const squareChat = await client.getSquareChat(destination.chatMid);
		for (const member of await squareChat.getMembers()) {
			if (addMemberRefreshRecord(records, member, "manualChatMembers", "JOINED")) chatMembers += 1;
		}
	} catch (error) {
		errors.push(`chat members: ${error instanceof Error ? error.message : String(error)}`);
	}

	try {
		const states: SquareMembershipState[] = ["JOINED", "LEFT", "KICK_OUT", "BANNED"];
		for (const state of states) {
			let continuationToken: string | undefined;
			for (let page = 0; page < 1000; page++) {
				const response = await client.base.square.searchSquareMembers({
					request: {
						squareMid: destination.scopeMid,
						searchOption: {
							membershipState: state,
							memberRoles: [],
							displayName: "",
							ableToReceiveMessage: "NONE",
							ableToReceiveFriendRequest: "NONE",
							chatMidToExcludeMembers: "",
							includingMe: true,
							excludeBlockedMembers: false,
							includingMeOnlyMatch: false,
						},
						continuationToken,
						limit: 100,
					},
				});
				for (const member of response.members) {
					if (addMemberRefreshRecord(records, member, `manualSquareMembers:${state}`, state)) directoryMembers += 1;
				}
				continuationToken = response.continuationToken || undefined;
				if (!continuationToken || response.members.length === 0) break;
				await sleep(80);
			}
		}
	} catch (error) {
		errors.push(`square directory: ${error instanceof Error ? error.message : String(error)}`);
	}

	const historyResult = await scanRecentMemberHistoryForNames(
		client,
		destination,
		Date.now() - MEMBER_UPDATE_HISTORY_LOOKBACK_MS,
		records,
	);
	historyMembers = historyResult.members;
	historyPages = historyResult.pages;
	historyReachedCutoff = historyResult.reachedCutoff;
	errors.push(...historyResult.errors);

	const unnamedMids = [...records.values()]
		.filter((member) => !member.name)
		.map((member) => member.mid);
	if (unnamedMids.length > 0) {
		const directNames = await resolveSquareMemberNamesDirect(client, destination, unnamedMids);
		directResolved = directNames.size;
		for (const [mid, name] of directNames) {
			const member = records.get(mid);
			if (member) member.name = name;
		}
	}

	for (const member of records.values()) {
		if (member.name) memberNameHistoryStore.record("square", destination.scopeMid, member.mid, member.name, member.seenAt);
		messageLogStore.recordMember({
			kind: "square",
			chatMid: destination.chatMid,
			scopeMid: destination.scopeMid,
			chatType: "SQUARE",
			mid: member.mid,
			name: member.name,
			state: member.state,
			role: member.role,
			seenAt: member.seenAt,
			source: member.source,
			extra: member.extra,
		});
	}

	const localFiles = await messageLogStore.flushLocalOnly();
	const sync = queueMessageLogSync();
	void sync.promise.catch((error) => {
		console.error("[log:member-update] GitHub sync failed", error);
	});

	return {
		chatMembers,
		directoryMembers,
		historyMembers,
		historyPages,
		historyReachedCutoff,
		directResolved,
		updated: records.size,
		unnamed: [...records.values()].filter((member) => !member.name).length,
		localFiles,
		syncStarted: sync.started,
		errors,
	};
}

async function searchSquareMembersByName(
	client: Client,
	destination: LineDestination,
	query: string,
): Promise<MemberInfo[]> {
	if (destination.kind !== "square") throw new Error("!logはOpenChatでのみ使用できます");
	const states: SquareMembershipState[] = ["JOINED", "LEFT", "KICK_OUT", "BANNED"];
	const displayNameQueries = [...new Set([
		query,
		normalizeText(query),
		compactSearchText(query),
		query.split(/\s+/)[0] ?? "",
		"",
	].filter((value) => value !== undefined))];
	const found = new Map<string, MemberInfo>();

	for (const state of states) {
		for (const displayName of displayNameQueries) {
			let continuationToken: string | undefined;
			for (let page = 0; page < 20; page++) {
				const response = await client.base.square.searchSquareMembers({
					request: {
						squareMid: destination.scopeMid,
						searchOption: {
							membershipState: state,
							memberRoles: [],
							displayName,
							ableToReceiveMessage: "NONE",
							ableToReceiveFriendRequest: "NONE",
							chatMidToExcludeMembers: "",
							includingMe: true,
							excludeBlockedMembers: false,
							includingMeOnlyMatch: false,
						},
						continuationToken,
						limit: 100,
					},
				});
				for (const member of response.members) {
					const info = {
						mid: member.squareMemberMid,
						name: cleanDisplayName(member.displayName) ?? member.squareMemberMid,
					};
					memberNameHistoryStore.record("square", destination.scopeMid, info.mid, info.name);
					messageLogStore.recordMember({
						kind: "square",
						chatMid: destination.chatMid,
						scopeMid: destination.scopeMid,
						chatType: "SQUARE",
						mid: info.mid,
						name: info.name,
						state: state === "KICK_OUT" ? "KICK_OUT" : state,
						role: member.role === undefined ? undefined : String(member.role),
						seenAt: Number(member.createdAt) > 0 ? Number(member.createdAt) : Date.now(),
						source: "searchSquareMembers",
						extra: {
							searchState: state,
							...(member.membershipState === undefined ? {} : { membershipState: String(member.membershipState) }),
						},
					});
					if (looseNameMatches(info.name, query)) found.set(info.mid, info);
				}
				continuationToken = response.continuationToken || undefined;
				if (!continuationToken || response.members.length === 0) break;
			}
		}
		if (found.size > 0) break;
	}

	return [...found.values()]
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

async function resolveMentionedMember(
	client: Client,
	destination: LineDestination,
	mid: string,
): Promise<MemberInfo> {
	const response = await client.base.square.getSquareMember({ squareMemberMid: mid });
	const name = cleanDisplayName(response.squareMember.displayName) ?? mid;
	memberNameHistoryStore.record("square", destination.scopeMid, mid, name);
	return { mid, name };
}

async function searchHistoryMembersByName(
	client: Client,
	destination: LineDestination,
	query: string,
): Promise<MemberInfo[]> {
	if (destination.kind !== "square") throw new Error("!logはOpenChatでのみ使用できます");
	const found = new Map<string, MemberInfo>();
	let continuationToken: string | undefined;
	let syncToken: string | undefined;
	const collect = (events: SquareHistoryEvent[]) => {
		recordEventNames(destination, events);
		for (const event of events) {
			for (const member of eventMembers(event)) {
				if (looseNameMatches(member.name, query)) found.set(member.mid, member);
			}
		}
	};

	for (let page = 0; page < 10; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken;
		collect(response.events as SquareHistoryEvent[]);
		if (response.events.length === 0) break;
	}
	if (!syncToken) return [];

	for (let page = 0; page < 120; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			direction: "BACKWARD",
			inclusive: page === 0 ? "ON" : "OFF",
			fetchType: "DEFAULT",
			limit: 100,
			...(continuationToken ? { continuationToken } : {}),
		});
		syncToken = response.syncToken;
		continuationToken = response.continuationToken || undefined;
		collect(response.events as SquareHistoryEvent[]);
		if (!continuationToken) break;
	}

	return [...found.values()]
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

function uniqueMembers(members: MemberInfo[]): MemberInfo[] {
	const byMid = new Map<string, MemberInfo>();
	for (const member of members) byMid.set(member.mid, member);
	return [...byMid.values()]
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

async function resolveTarget(
	client: Client,
	destination: LineDestination,
	args: string[],
	mentionedMid?: string,
): Promise<ResolvedTarget | undefined> {
	if (mentionedMid?.startsWith("p")) {
		return {
			member: await resolveMentionedMember(client, destination, mentionedMid),
			filter: args.filter((arg) => !arg.startsWith("@")).join(" ").trim(),
		};
	}

	let ambiguous: MemberInfo[] | undefined;
	for (let split = args.length; split >= 1; split--) {
		const memberQuery = args.slice(0, split).join(" ").trim();
		const filter = args.slice(split).join(" ").trim();
		const members = uniqueMembers([
			...await searchSquareMembersByName(client, destination, memberQuery),
			...await searchHistoryMembersByName(client, destination, memberQuery),
		]);
		if (members.length === 1) return { member: members[0], filter };
		if (members.length > 1 && !ambiguous) ambiguous = members;
	}

	if (ambiguous) return { member: ambiguous[0], filter: "", ambiguous };
	return undefined;
}

async function collectMemberLogs(
	client: Client,
	destination: LineDestination,
	targetMid: string,
	filter: string,
): Promise<LogEntry[]> {
	let continuationToken: string | undefined;
	let syncToken: string | undefined;
	const rows: LogEntry[] = [];
	const seenMessageIds = new Set<string>();
	const addEntry = (entry: LogEntry | undefined): void => {
		if (!entry || seenMessageIds.has(entry.id)) return;
		seenMessageIds.add(entry.id);
		rows.push(entry);
	};

	for (let page = 0; page < 10; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken;
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		for (const event of response.events as SquareHistoryEvent[]) {
			addEntry(logEntryFromEvent(event, targetMid, filter));
		}
		if (response.events.length === 0 || rows.length >= MAX_LOG_ROWS) break;
	}
	if (!syncToken || rows.length >= MAX_LOG_ROWS) return rows.slice(0, MAX_LOG_ROWS);

	for (let page = 0; page < 120 && rows.length < MAX_LOG_ROWS; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			direction: "BACKWARD",
			inclusive: page === 0 ? "ON" : "OFF",
			fetchType: "DEFAULT",
			limit: 100,
			...(continuationToken ? { continuationToken } : {}),
		});
		syncToken = response.syncToken;
		continuationToken = response.continuationToken || undefined;
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		for (const event of response.events as SquareHistoryEvent[]) {
			addEntry(logEntryFromEvent(event, targetMid, filter));
			if (rows.length >= MAX_LOG_ROWS) break;
		}
		if (!continuationToken) break;
	}

	return rows
		.sort((left, right) => right.createdAt - left.createdAt)
		.slice(0, MAX_LOG_ROWS);
}

async function scanNamesFromHistory(
	client: Client,
	destination: LineDestination,
	targetMid: string,
): Promise<void> {
	let continuationToken: string | undefined;
	let syncToken: string | undefined;

	for (let page = 0; page < 10; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken;
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		if (response.events.length === 0) break;
	}
	if (!syncToken) return;

	for (let page = 0; page < 120; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			direction: "BACKWARD",
			inclusive: page === 0 ? "ON" : "OFF",
			fetchType: "DEFAULT",
			limit: 100,
			...(continuationToken ? { continuationToken } : {}),
		});
		syncToken = response.syncToken;
		continuationToken = response.continuationToken || undefined;
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		if (response.events.some((event) => eventMembers(event).some((member) => member.mid === targetMid))) {
			// Continue scanning; the same user may have older names.
		}
		if (!continuationToken) break;
	}
}

function formatLogRows(rows: LogEntry[]): string[] {
	return rows.map((row) => `${formatLogTime(row.createdAt)}:${row.content}`);
}

async function formatStoredRows(
	message: ReplyableLineMessage,
	rows: StoredMessageLog[],
	includeSender: boolean,
): Promise<string[]> {
	const memberNames = includeSender
		? await messageLogStore.getMemberNames(message.destination, rows.map((row) => row.senderMid))
		: new Map<string, string>();
	const historyNames = new Map<string, string>();
	if (includeSender && message.destination.kind === "square") {
		for (const row of rows) {
			if (historyNames.has(row.senderMid)) continue;
			const historyName = memberNameHistoryStore.get("square", message.destination.scopeMid, row.senderMid)[0]?.name;
			const cleanHistoryName = cleanDisplayName(historyName);
			if (cleanHistoryName) historyNames.set(row.senderMid, cleanHistoryName);
		}
	}
	const unresolvedMids = includeSender && message.destination.kind === "square"
		? rows
			.filter((row) =>
				row.senderMid.startsWith("p") &&
				!cleanDisplayName(row.senderName) &&
				!cleanDisplayName(memberNames.get(row.senderMid)) &&
				!historyNames.has(row.senderMid)
			)
			.map((row) => row.senderMid)
		: [];
	const directNames = unresolvedMids.length > 0
		? await resolveSquareMemberNamesDirect(message.client, message.destination, unresolvedMids)
		: new Map<string, string>();
	return rows.map((row) => {
		const sender = displayNameOrMid(
			cleanDisplayName(row.senderName) ??
				cleanDisplayName(memberNames.get(row.senderMid)) ??
				historyNames.get(row.senderMid) ??
				directNames.get(row.senderMid),
			row.senderMid,
		);
		return includeSender
			? `${formatLogTime(row.createdAt)}:${sender}:${row.content}`
			: `${formatLogTime(row.createdAt)}:${row.content}`;
	});
}

async function runLogSearch(
	message: ReplyableLineMessage,
	query: string,
	all: boolean,
	target?: MemberInfo,
	progressMessageId?: string,
): Promise<void> {
	const activeProgressMessageId = progressMessageId ?? await sendLogSearchProgress(message, all);
	const sinceCreatedAt = all ? undefined : Date.now() - DEFAULT_LOG_LOOKBACK_MS;
	try {
		const rows = await messageLogStore.search(message.destination, query, {
			senderMid: target?.mid,
			limit: MAX_LOG_ROWS,
			sinceCreatedAt,
		});
		await dismissProgressMessage(message, activeProgressMessageId);
		if (rows.length === 0) {
			const scopeText = all
				? "全期間"
				: `直近${DEFAULT_LOG_LOOKBACK_DAYS}日 (${formatLogDate(sinceCreatedAt ?? Date.now())}以降)`;
			await message.send(target
				? `${displayNameOrMid(target.name, target.mid)} の「${query}」を含む発言は${scopeText}の保存済みログに見つかりませんでした。`
				: `このトークで「${query}」を含む発言は${scopeText}の保存済みログに見つかりませんでした。`);
			return;
		}

		const title = [
			target ? `${displayNameOrMid(target.name, target.mid)} log "${query}"` : `talk log "${query}"`,
			all ? "全期間" : `直近${DEFAULT_LOG_LOOKBACK_DAYS}日`,
			rows.length >= MAX_LOG_ROWS ? `最大${MAX_LOG_ROWS}件` : "",
		].filter(Boolean).join(" / ");
		await sendSearchResults(
			message,
			title,
			await formatStoredRows(message, rows, !target),
			LOG_PAGE_SIZE,
		);
	} catch (error) {
		await dismissProgressMessage(message, activeProgressMessageId);
		await message.send(`ログ検索に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function handleLogTargetSelectionReply(
	messageText: string,
	message: ReplyableLineMessage,
): Promise<boolean> {
	cleanupTargetSelectionSessions();
	const raw = messageText.trim();
	const choice = Number.parseInt(raw, 10);
	if (!Number.isInteger(choice) || String(choice) !== raw || choice < 1) return false;
	const session = message.replyToMessageId
		? targetSelectionSessions.get(message.replyToMessageId)
		: recentTargetSelectionSessions.get(recentSelectionKey(message));
	if (!session) return false;
	if (session.destinationKey !== destinationKey(message) || session.senderMid !== message.destination.senderMid) return false;
	if (choice > session.candidates.length) {
		await message.send(`対象番号は1~${session.candidates.length}で指定してください。`);
		return true;
	}
	if (message.replyToMessageId) targetSelectionSessions.delete(message.replyToMessageId);
	recentTargetSelectionSessions.delete(recentSelectionKey(message));
	const target = session.candidates[choice - 1];
	const progressMessageId = await sendLogSearchProgress(message, session.all);
	await runLogSearch(message, session.query, session.all, target, progressMessageId);
	return true;
}

function formatNameHistoryRows(entries: ReturnType<typeof memberNameHistoryStore.get>): string[] {
	return entries.map((entry) => {
		const first = formatLogTime(Date.parse(entry.firstSeenAt));
		const last = formatLogTime(Date.parse(entry.lastSeenAt));
		return `${entry.name}\n初回: ${first}\n最終: ${last}\n確認: ${entry.count}回`;
	});
}

async function backfillSquareHistory(
	client: Client,
	destination: LineDestination,
	onProgress?: (read: number, added: number) => Promise<void>,
): Promise<{ read: number; added: number; skipped: number; oldestAt?: number; errors: number; lastError?: string }> {
	let continuationToken: string | undefined;
	let syncToken: string | undefined;
	let totalRead = 0;
	let totalAdded = 0;
	let oldestAt: number | undefined;
	let errors = 0;
	let lastError: string | undefined;
	let consecutiveSkippedPages = 0;
	const localFlushPages = Math.max(1, appConfig.messageLogBackfillLocalFlushPages);
	const remoteFlushPages = Math.max(localFlushPages, appConfig.messageLogBackfillRemoteFlushPages);
	const resumeAutoFlush = messageLogStore.suspendAutoFlush();
	const applyStats = (stats: { read: number; added: number; oldestAt?: number }) => {
		totalRead += stats.read;
		totalAdded += stats.added;
		if (stats.oldestAt !== undefined && (oldestAt === undefined || stats.oldestAt < oldestAt)) {
			oldestAt = stats.oldestAt;
		}
	};
	const noteError = (label: string, error: unknown) => {
		errors += 1;
		lastError = `${label}: ${error instanceof Error ? error.message : String(error)}`;
		console.warn(`[log:get] ${lastError}`);
	};
	const fetchWithRetry = async (
		label: string,
		options: FetchSquareChatEventsOptions,
	): Promise<Awaited<ReturnType<typeof fetchSquareChatEvents>> | undefined> => {
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				return await fetchSquareChatEvents(client, options);
			} catch (error) {
				noteError(`${label} attempt ${attempt}`, error);
				await sleep(appConfig.messageLogBackfillDelayMs * attempt);
			}
		}
		return undefined;
	};
	const flushCheckpoint = async (label: string) => {
		try {
			await messageLogStore.checkpointLocal();
		} catch (error) {
			noteError(label, error);
		}
	};

	try {
	for (let page = 0; page < 10; page++) {
		const response = await fetchWithRetry(`prime page ${page + 1}`, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		if (!response) break;
		syncToken = response.syncToken;
		const events = response.events as SquareHistoryEvent[];
		recordEventNames(destination, events);
		applyStats(recordMessageLogsFromEvents(destination, events));
		if ((page + 1) % localFlushPages === 0) {
			await flushCheckpoint(`local prime checkpoint page ${page + 1}`);
		}
		if (response.events.length === 0) break;
		await sleep(appConfig.messageLogBackfillDelayMs);
	}
	if (!syncToken) return { read: totalRead, added: totalAdded, skipped: totalRead - totalAdded, oldestAt, errors, lastError };

	for (let page = 0; page < 100_000; page++) {
		const response = await fetchWithRetry(`backward page ${page + 1}`, {
			squareChatMid: destination.chatMid,
			syncToken,
			direction: "BACKWARD",
			inclusive: page === 0 ? "ON" : "OFF",
			fetchType: "DEFAULT",
			limit: 100,
			...(continuationToken ? { continuationToken } : {}),
		});
		if (!response) {
			consecutiveSkippedPages += 1;
			if (consecutiveSkippedPages >= 5) {
				noteError("backfill aborted", "連続して履歴取得に失敗したため、この時点までの保存内容で終了します");
				break;
			}
			await sleep(appConfig.messageLogBackfillDelayMs);
			continue;
		}
		consecutiveSkippedPages = 0;
		syncToken = response.syncToken;
		continuationToken = response.continuationToken || undefined;
		const events = response.events as SquareHistoryEvent[];
		recordEventNames(destination, events);
		applyStats(recordMessageLogsFromEvents(destination, events));
		if ((page + 1) % localFlushPages === 0) {
			await flushCheckpoint(`local checkpoint page ${page + 1}`);
			await onProgress?.(totalRead, totalAdded);
		}
		if ((page + 1) % remoteFlushPages === 0) {
			const sync = queueMessageLogSync();
			if (sync.started) {
				void sync.promise.catch((error) => {
					console.error("[log:get] periodic GitHub sync failed", error);
				});
			}
		}
		if (!continuationToken) break;
		await sleep(appConfig.messageLogBackfillDelayMs);
	}

	messageLogStore.markBackfillComplete(destination, oldestAt);
	await flushCheckpoint("final local checkpoint");
	} finally {
		resumeAutoFlush();
	}
	return { read: totalRead, added: totalAdded, skipped: totalRead - totalAdded, oldestAt, errors, lastError };
}

function backfillKey(destination: LineDestination): string {
	return `${destination.kind}:${destination.chatMid}`;
}

async function startBackfill(message: Parameters<LineCommand["execute"]>[0]["message"]): Promise<void> {
	if (message.destination.kind !== "square") {
		await message.send("!log getはOpenChatでのみ使用できます。");
		return;
	}
	const key = backfillKey(message.destination);
	const activeJob = getActiveHistoryJob();
	if (activeJob) {
		await message.send([
			"現在、別の履歴取得が実行中です。",
			`実行者: ${activeJob.type === "auto" ? "自動履歴保存" : activeJob.requester}`,
			`開始: ${formatLogTime(activeJob.startedAt)}`,
			`経過: ${formatDuration(Date.now() - activeJob.startedAt)}`,
			"完了後にもう一度実行してください。",
		].join("\n"));
		return;
	}
	const startedAt = Date.now();
	const requester = message.destination.senderName || message.destination.senderMid;
	const jobId = `manual:${key}:${startedAt}`;
	if (!tryStartHistoryJob({ id: jobId, key, requester, startedAt, type: "manual" })) {
		await message.send("現在、別の履歴取得が実行中です。完了後にもう一度実行してください。");
		return;
	}
	const destination = { ...message.destination };
	await message.send("履歴取得を開始しました。完了までバックグラウンドでゆっくり読み込みます。");
	void backfillSquareHistory(message.client, destination)
		.then(async (result) => {
			const elapsedMs = Date.now() - startedAt;
			const label = `@${requester}`;
			const text = [
				label,
				"履歴取得が完了しました。",
				`読み込んだメッセージ数: ${result.read}`,
				`新規保存: ${result.added}`,
				`既存/重複: ${result.skipped}`,
				`途中エラー: ${result.errors}`,
				...(result.lastError ? [`最後のエラー: ${result.lastError}`] : []),
				`完了時間: ${formatLogTime(Date.now())}`,
				`かかった時間: ${formatDuration(elapsedMs)}`,
			].join("\n");
			if (message.sendMention) {
				await message.sendMention(text, [{ start: 0, end: label.length, mid: destination.senderMid }]);
			} else {
				await message.send(text);
			}
			const sync = queueMessageLogSync();
			void sync.promise
				.then((syncText) => message.send(syncText))
				.catch((error) => {
				console.error("[log:get] background GitHub sync failed", error);
				return message.send(`ログのGitHub同期に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
			});
		})
		.catch(async (error) => {
			const label = `@${requester}`;
			const text = `${label}\n履歴取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
			if (message.sendMention) {
				await message.sendMention(text, [{ start: 0, end: label.length, mid: destination.senderMid }]);
			} else {
				await message.send(text);
			}
		})
		.finally(() => {
			finishHistoryJob(jobId);
		});
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}時間${minutes}分${seconds}秒`;
	if (minutes > 0) return `${minutes}分${seconds}秒`;
	return `${seconds}秒`;
}

function formatMessageLogSyncResult(result: MessageLogFlushResult): string {
	if (!result.remoteEnabled) {
		return [
			"ログのGitHub同期は無効です。",
			"PUSH_SUBSCRIPTIONS_GITHUB_REPO と PUSH_SUBSCRIPTIONS_GITHUB_TOKEN を確認してください。",
			`ローカル保存: ${result.localFiles}ファイル`,
		].join("\n");
	}
	if (result.remoteSkipped) {
		return [
			"ログのGitHub同期は保留されました。",
			`ローカル保存: ${result.localFiles}ファイル`,
		].join("\n");
	}
	return [
		"ログのGitHub同期が完了しました。",
		`GitHub保存: ${result.remoteFiles}ファイル`,
		`ローカル保存: ${result.localFiles}ファイル`,
	].join("\n");
}

async function syncMessageLogToGitHub(): Promise<string> {
	const logResult = await messageLogStore.flush();
	await memberNameHistoryStore.flush();
	return formatMessageLogSyncResult(logResult);
}

function queueMessageLogSync(): { started: boolean; promise: Promise<string> } {
	messageLogSyncRequested = true;
	if (activeMessageLogSync) {
		return { started: false, promise: activeMessageLogSync };
	}
	activeMessageLogSync = runQueuedMessageLogSync()
		.finally(() => {
			activeMessageLogSync = undefined;
		});
	return { started: true, promise: activeMessageLogSync };
}

async function runQueuedMessageLogSync(): Promise<string> {
	let result = "";
	let runs = 0;
	while (messageLogSyncRequested) {
		messageLogSyncRequested = false;
		result = await syncMessageLogToGitHub();
		runs += 1;
		await sleep(500);
	}
	return runs > 1 ? `${result}\n追加同期: ${runs}回` : result;
}

export const logCommand: LineCommand = {
	name: "log",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.send([
				"!log <検索語>",
				"  このトークの直近30日から検索語を含む発言を表示します。",
				"!log <検索語> <メンバー名>",
				"  その人の直近30日の発言から検索語を含むものだけ表示します。",
				"!log <検索語> all",
				"  全期間から検索します。重いので連打しないでください。",
				"!log get",
				"  このOpenChatの過去履歴をゆっくり保存します。",
				"!log sync",
				"  保存済みログをGitHubへ手動同期します。",
				"!log member update",
				"  現在のOCメンバー名をmembers.jsonへ再取得します。管理者のみ。",
				"!log name <メンバー名>",
				"  保存済みの過去の名前を表示します。",
			].join("\n"));
			return;
		}

		if (["member", "members"].includes(args[0]?.toLowerCase() ?? "")) {
			if (!["update", "sync", "refresh"].includes(args[1]?.toLowerCase() ?? "")) {
				await message.send("使い方: !log member update\n現在のOCメンバー名をmembers.jsonへ再取得します。");
				return;
			}
			const target = targetFromDestination(message.destination);
			if (!permissionStore.hasAtLeast(target, message.destination.senderMid, "admin")) {
				await message.send(permissionDeniedText("admin"));
				return;
			}
			if (message.destination.kind !== "square") {
				await message.send("メンバーJSON更新はOpenChatでのみ使用できます。");
				return;
			}
			await message.send(`メンバーJSON更新を開始しました。\n現在メンバーと退会済みを含む直近${MEMBER_UPDATE_HISTORY_LOOKBACK_DAYS}日分の履歴を確認します。`);
			try {
				const result = await refreshSquareMemberJson(message.client, message.destination);
				const lines = [
					"メンバーJSON更新が完了しました。",
					`現在チャット取得: ${result.chatMembers}人`,
					`OC全体取得: ${result.directoryMembers}人`,
					`履歴取得: ${result.historyMembers}人 / ${result.historyPages}ページ`,
					`半年地点到達: ${result.historyReachedCutoff ? "はい" : "いいえ"}`,
					`個別名前取得: ${result.directResolved}人`,
					`保存/更新: ${result.updated}人`,
					`名前未取得: ${result.unnamed}人`,
					`ローカル保存: ${result.localFiles}ファイル`,
					result.syncStarted ? "GitHub同期: 開始しました" : "GitHub同期: 実行中の同期に追加しました",
				];
				if (result.errors.length > 0) {
					lines.push("", "一部エラー:", ...result.errors.slice(0, 3));
				}
				await message.send(lines.join("\n"));
			} catch (error) {
				await message.send(`メンバーJSON更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (args[0]?.toLowerCase() === "get") {
			const target = targetFromDestination(message.destination);
			if (!permissionStore.hasAtLeast(target, message.destination.senderMid, "admin")) {
				await message.send(permissionDeniedText("admin"));
				return;
			}
			await startBackfill(message);
			return;
		}

		if (args[0]?.toLowerCase() === "sync") {
			const target = targetFromDestination(message.destination);
			if (!permissionStore.hasAtLeast(target, message.destination.senderMid, "admin")) {
				await message.send(permissionDeniedText("admin"));
				return;
			}
			await message.send("ログのGitHub同期を開始しました。");
			const sync = queueMessageLogSync();
			if (!sync.started) await message.send("すでにログのGitHub同期が実行中です。完了時に通知します。");
			void sync.promise
				.then((text) => message.send(text))
				.catch((error) => message.send(`ログのGitHub同期に失敗しました: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}

		const mode = args[0]?.toLowerCase() === "name" ? "name" : "message";
		const targetArgs = mode === "name" ? args.slice(1) : args;
		const mentionedMid = message.mentionMids[0];
		let target: MemberInfo | undefined;
		let ambiguous: MemberInfo[] | undefined;

		if (mode === "name") {
			if (message.destination.kind !== "square") {
				await message.send("!log nameはOpenChatでのみ使用できます。");
				return;
			}
			if (targetArgs.length === 0 && !mentionedMid) {
				target = {
					mid: message.destination.senderMid,
					name: message.destination.senderName || message.destination.senderMid,
				};
				memberNameHistoryStore.record("square", message.destination.scopeMid, target.mid, target.name);
			} else {
				const resolved = await resolveTarget(message.client, message.destination, targetArgs, mentionedMid);
				target = resolved?.member;
				ambiguous = resolved?.ambiguous;
			}
			if (ambiguous && ambiguous.length > 1) {
				await sendSearchResults(
					message,
					"対象候補",
					ambiguous.map((member) => `${displayNameOrMid(member.name, member.mid)}\nMID: ${member.mid}`),
					LOG_PAGE_SIZE,
				);
				return;
			}
			if (!target) {
				await message.send("対象メンバーが見つかりませんでした。");
				return;
			}
			await scanNamesFromHistory(message.client, message.destination, target.mid);
			await memberNameHistoryStore.flush();
			const entries = memberNameHistoryStore.get("square", message.destination.scopeMid, target.mid);
			if (entries.length === 0) {
				await message.send(`${displayNameOrMid(target.name, target.mid)}\n過去の名前はまだ保存されていません。`);
				return;
			}
			await sendSearchResults(
				message,
				`${displayNameOrMid(target.name, target.mid)} 名前履歴`,
				formatNameHistoryRows(entries),
				LOG_PAGE_SIZE,
			);
			return;
		}

		const parsedSearch = splitLogSearchArgs(args);
		const query = parsedSearch.args[0]?.trim();
		if (!query) {
			await message.send("検索語を指定してください。\n使い方: !log <検索語> [メンバー名]");
			return;
		}

		const targetNameArgs = parsedSearch.args.slice(1);
		if ((mentionedMid || targetNameArgs.length > 0) && message.destination.kind !== "square") {
			await message.send("名前指定の!log検索はOpenChatでのみ使用できます。");
			return;
		}

		const progressMessageId = await sendLogSearchProgress(message, parsedSearch.all);
		try {
			if (mentionedMid || targetNameArgs.length > 0) {
				if (message.destination.kind !== "square") {
					await dismissProgressMessage(message, progressMessageId);
					await message.send("名前指定の!log検索はOpenChatでのみ使用できます。");
					return;
				}
				const resolved = await resolveTarget(message.client, message.destination, targetNameArgs, mentionedMid);
				target = resolved?.member;
				ambiguous = resolved?.ambiguous;
				if (ambiguous && ambiguous.length > 1) {
					await dismissProgressMessage(message, progressMessageId);
					await sendTargetSelection(message, query, parsedSearch.all, ambiguous);
					return;
				}
				if (!target) {
					await dismissProgressMessage(message, progressMessageId);
					await message.send("対象メンバーが見つかりませんでした。");
					return;
				}
			}

			await runLogSearch(message, query, parsedSearch.all, target, progressMessageId);
		} catch (error) {
			await dismissProgressMessage(message, progressMessageId);
			await message.send(`ログ検索に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
