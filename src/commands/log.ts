import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { getActiveHistoryJob, tryStartHistoryJob, finishHistoryJob } from "../messageLog/historyJobs.js";
import { messageLogStore, type MessageLogFlushResult, type StoredMemberState, type StoredMessageLog } from "../messageLog/store.js";
import { memberNameHistoryStore } from "../nameHistory/store.js";
import { permissionDeniedText, permissionStore, targetFromDestination } from "../permissions/store.js";
import { sendSearchResults } from "./searchPages.js";
import type { LineCommand, LineDestination } from "./shared.js";

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

const MAX_LOG_ROWS = 1000;
const LOG_PAGE_SIZE = 20;
let activeMessageLogSync: Promise<string> | undefined;
let messageLogSyncRequested = false;

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

function logEntryFromEvent(event: SquareHistoryEvent, targetMid: string, filter: string): LogEntry | undefined {
	const payload = event.payload?.receiveMessage ?? event.payload?.sendMessage;
	const message = payload?.squareMessage?.message;
	if (!message || message.from !== targetMid) return undefined;
	const content = formatContent(payload);
	if (filter && !normalizeText(content).includes(normalizeText(filter))) return undefined;
	const createdAt = Number(message.createdTime ?? event.createdTime);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
	return { id: message.id || `${targetMid}:${createdAt}:${content}`, createdAt, content };
}

function messageLogFromEvent(destination: LineDestination, event: SquareHistoryEvent): StoredMessageLog | undefined {
	const payload = event.payload?.receiveMessage ?? event.payload?.sendMessage;
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
		if (member?.squareMemberMid?.startsWith("p") && member.displayName) {
			members.push({ mid: member.squareMemberMid, name: member.displayName });
		}
	};
	add(event.payload?.notifiedCreateSquareMember?.squareMember);
	add(event.payload?.notifiedCreateSquareChatMember?.peerSquareMember);
	add(event.payload?.notifiedJoinSquareChat?.joinedMember);
	add(event.payload?.notifiedLeaveSquareChat?.squareMember);
	add(event.payload?.notifiedUpdateSquareMemberProfile?.squareMember);
	add(event.payload?.notifiedUpdateSquareMember?.squareMember);
	for (const member of event.payload?.notifiedKickoutFromSquare?.kickees ?? []) add(member);

	const messagePayload = event.payload?.receiveMessage ?? event.payload?.sendMessage;
	const messageMid = messagePayload?.squareMessage?.message?.from;
	if (messageMid?.startsWith("p") && messagePayload?.senderDisplayName) {
		members.push({ mid: messageMid, name: messagePayload.senderDisplayName });
	}

	return members;
}

function eventMemberProfiles(event: SquareHistoryEvent): Array<MemberInfo & {
	state: StoredMemberState;
	role?: string;
	seenAt?: number;
	source: string;
	extra?: Record<string, unknown>;
}> {
	const profiles: Array<MemberInfo & {
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
			name: member.displayName || "(名前なし)",
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

	const messagePayload = event.payload?.receiveMessage ?? event.payload?.sendMessage;
	const message = messagePayload?.squareMessage?.message;
	if (message?.from?.startsWith("p")) {
		profiles.push({
			mid: message.from,
			name: messagePayload?.senderDisplayName || "(名前なし)",
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
						name: member.displayName || "(名前なし)",
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
	const name = response.squareMember.displayName || "(名前なし)";
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

function formatStoredRows(rows: StoredMessageLog[], includeSender: boolean): string[] {
	return rows.map((row) => {
		const sender = row.senderName || row.senderMid;
		return includeSender
			? `${formatLogTime(row.createdAt)}:${sender}:${row.content}`
			: `${formatLogTime(row.createdAt)}:${row.content}`;
	});
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
				"  このトーク全体から検索語を含む発言を表示します。",
				"!log <検索語> <メンバー名>",
				"  その人の発言から検索語を含むものだけ表示します。",
				"!log get",
				"  このOpenChatの過去履歴をゆっくり保存します。",
				"!log sync",
				"  保存済みログをGitHubへ手動同期します。",
				"!log name <メンバー名>",
				"  保存済みの過去の名前を表示します。",
			].join("\n"));
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
					ambiguous.map((member) => `${member.name}\nMID: ${member.mid}`),
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
				await message.send(`${target.name}\n過去の名前はまだ保存されていません。`);
				return;
			}
			await sendSearchResults(
				message,
				`${target.name} 名前履歴`,
				formatNameHistoryRows(entries),
				LOG_PAGE_SIZE,
			);
			return;
		}

		const query = args[0]?.trim();
		if (!query) {
			await message.send("検索語を指定してください。\n使い方: !log <検索語> [メンバー名]");
			return;
		}

		const targetNameArgs = args.slice(1);
		if (mentionedMid || targetNameArgs.length > 0) {
			if (message.destination.kind !== "square") {
				await message.send("名前指定の!log検索はOpenChatでのみ使用できます。");
				return;
			}
			const resolved = await resolveTarget(message.client, message.destination, targetNameArgs, mentionedMid);
			target = resolved?.member;
			ambiguous = resolved?.ambiguous;
			if (ambiguous && ambiguous.length > 1) {
				await sendSearchResults(
					message,
					"対象候補",
					ambiguous.map((member) => `${member.name}\nMID: ${member.mid}`),
					LOG_PAGE_SIZE,
				);
				return;
			}
			if (!target) {
				await message.send("対象メンバーが見つかりませんでした。");
				return;
			}
		}

		const rows = await messageLogStore.search(message.destination, query, target?.mid, MAX_LOG_ROWS);
		if (rows.length === 0) {
			await message.send(target
				? `${target.name} の「${query}」を含む発言は保存済みログに見つかりませんでした。`
				: `このトークで「${query}」を含む発言は保存済みログに見つかりませんでした。`);
			return;
		}

		await sendSearchResults(
			message,
			target ? `${target.name} log "${query}"` : `talk log "${query}"`,
			formatStoredRows(rows, !target),
			LOG_PAGE_SIZE,
		);
	},
};
