import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { memberNameHistoryStore } from "../nameHistory/store.js";
import {
	messageLogStore,
	type MessageLogChatSummary,
	type MessageLogAutoHistoryState,
	type StoredMemberState,
	type StoredMessageLog,
} from "./store.js";
import { getActiveHistoryJob, tryStartHistoryJob, finishHistoryJob } from "./historyJobs.js";

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSquareChatEvents(
	client: Client,
	options: FetchSquareChatEventsOptions,
) {
	return await client.base.square.fetchSquareChatEvents(options as never);
}

function compactError(error: unknown): string {
	const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	try {
		return `${detail} ${JSON.stringify(error)}`;
	} catch {
		return detail;
	}
}

function isRejectedCursorError(error: unknown): boolean {
	return /ILLEGAL_ARGUMENT|INVALID_ARGUMENT/i.test(compactError(error));
}

async function clearRejectedCursor(
	chat: MessageLogChatSummary,
	lastMode: MessageLogAutoHistoryState["lastMode"],
): Promise<void> {
	messageLogStore.updateAutoHistoryState(chat, {
		...(chat.autoHistory ?? {}),
		syncToken: undefined,
		continuationToken: undefined,
		lastMode,
	});
	await messageLogStore.checkpointLocal().catch((error) => {
		console.warn("[message-log:auto-history] failed to save cursor reset", {
			chatMid: chat.chatMid,
			error: compactError(error),
		});
	});
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

function looksLikeSquareMemberMid(value: string): boolean {
	return /^p[0-9a-f]{8,}$/i.test(value.trim());
}

function cleanDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || looksLikeSquareMemberMid(trimmed)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(trimmed)) return undefined;
	if (/^[\p{C}\s]+$/u.test(trimmed)) return undefined;
	return trimmed;
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

function messageLogFromEvent(chat: MessageLogChatSummary, event: SquareHistoryEvent): StoredMessageLog | undefined {
	const payload = eventMessagePayload(event);
	if (!payload) return undefined;
	const message = payload.squareMessage?.message;
	if (!message?.from) return undefined;
	const createdAt = Number(message.createdTime ?? event.createdTime);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
	return {
		id: message.id || `${message.from}:${createdAt}:${formatContent(payload)}`,
		kind: "square",
		chatMid: payload.squareChatMid || chat.chatMid,
		scopeMid: chat.scopeMid,
		chatType: "SQUARE",
		senderMid: message.from,
		senderName: payload.senderDisplayName,
		createdAt,
		content: formatContent(payload),
		contentType: message.contentType === undefined ? undefined : String(message.contentType),
		metadata: {
			source: "auto-history-square",
			squareChatMid: payload.squareChatMid,
			squareMid: payload.squareMid,
			hasContent: message.hasContent,
			eventType: event.type,
			eventCreatedTime: event.createdTime === undefined ? undefined : String(event.createdTime),
		},
	};
}

function eventMembers(event: SquareHistoryEvent): Array<{
	mid: string;
	name?: string;
	state: StoredMemberState;
	role?: string;
	seenAt?: number;
	source: string;
	extra?: Record<string, unknown>;
}> {
	const members: Array<{
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
	const add = (member: SquareHistoryMember | undefined, state: StoredMemberState, source: string) => {
		if (!member?.squareMemberMid?.startsWith("p")) return;
		members.push({
			mid: member.squareMemberMid,
			name: cleanDisplayName(member.displayName),
			state,
			role: member.role === undefined ? undefined : String(member.role),
			seenAt: Number(member.createdAt) > 0 ? Number(member.createdAt) : seenAt,
			source,
			extra: {
				...(member.membershipState === undefined ? {} : { membershipState: String(member.membershipState) }),
				...(member.squareMid ? { squareMid: member.squareMid } : {}),
			},
		});
	};
	add(event.payload?.notifiedCreateSquareMember?.squareMember, "JOINED", "autoCreateSquareMember");
	add(event.payload?.notifiedCreateSquareChatMember?.peerSquareMember, "JOINED", "autoCreateSquareChatMember");
	add(event.payload?.notifiedJoinSquareChat?.joinedMember, "JOINED", "autoJoinSquareChat");
	add(event.payload?.notifiedLeaveSquareChat?.squareMember, "LEFT", "autoLeaveSquareChat");
	add(event.payload?.notifiedUpdateSquareMemberProfile?.squareMember, "UNKNOWN", "autoUpdateProfile");
	add(event.payload?.notifiedUpdateSquareMember?.squareMember, "UNKNOWN", "autoUpdateMember");
	for (const member of event.payload?.notifiedKickoutFromSquare?.kickees ?? []) add(member, "KICK_OUT", "autoKickoutFromSquare");

	const leftMemberMid = event.payload?.notifiedLeaveSquareChat?.squareMemberMid;
	if (leftMemberMid?.startsWith("p")) {
		members.push({
			mid: leftMemberMid,
			name: nameFromLeaveNotification(event),
			state: "LEFT",
			seenAt,
			source: "autoLeaveSquareChatNotification",
			extra: { notificationText: notificationTextFromEvent(event) },
		});
	}

	const messagePayload = eventMessagePayload(event);
	const message = messagePayload?.squareMessage?.message;
	if (message?.from?.startsWith("p")) {
		members.push({
			mid: message.from,
			name: cleanDisplayName(messagePayload?.senderDisplayName),
			state: "JOINED",
			seenAt: Number(message.createdTime) > 0 ? Number(message.createdTime) : seenAt,
			source: "autoMessage",
			extra: messagePayload?.squareMid ? { squareMid: messagePayload.squareMid } : undefined,
		});
	}
	return members;
}

function recordEvents(chat: MessageLogChatSummary, events: SquareHistoryEvent[]): { read: number; added: number; oldestAt?: number } {
	for (const event of events) {
		for (const member of eventMembers(event)) {
			memberNameHistoryStore.record("square", chat.scopeMid, member.mid, member.name, member.seenAt);
			messageLogStore.recordMember({
				kind: "square",
				chatMid: chat.chatMid,
				scopeMid: chat.scopeMid,
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
	const messages = events.flatMap((event) => {
		const message = messageLogFromEvent(chat, event);
		return message ? [message] : [];
	});
	return {
		read: messages.length,
		added: messageLogStore.recordMany(messages),
		oldestAt: messages.reduce<number | undefined>((oldest, message) => {
			if (oldest === undefined || message.createdAt < oldest) return message.createdAt;
			return oldest;
		}, undefined),
	};
}

function isQuietHour(): boolean {
	const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
	const hour = now.getUTCHours();
	const start = appConfig.messageLogAutoHistoryQuietStartHour;
	const end = appConfig.messageLogAutoHistoryQuietEndHour;
	if (start === end) return true;
	if (start < end) return hour >= start && hour < end;
	return hour >= start || hour < end;
}

function isIdleEnough(): boolean {
	const lastActivityAt = messageLogStore.getLastActivityAt();
	if (lastActivityAt === 0) return true;
	return Date.now() - lastActivityAt >= appConfig.messageLogAutoHistoryIdleMs;
}

function autoHistorySortTime(chat: MessageLogChatSummary): number {
	const parsed = Date.parse(chat.autoHistory?.updatedAt ?? chat.backfillCompletedAt ?? "1970-01-01");
	return Number.isFinite(parsed) ? parsed : 0;
}

async function primeRecent(client: Client, chat: MessageLogChatSummary, pages: number): Promise<string | undefined> {
	let syncToken = chat.autoHistory?.syncToken;
	for (let page = 0; page < pages; page++) {
		const options: FetchSquareChatEventsOptions = {
			squareChatMid: chat.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		};
		let response: Awaited<ReturnType<typeof fetchSquareChatEvents>>;
		try {
			response = await fetchSquareChatEvents(client, options);
		} catch (error) {
			if (!syncToken || !isRejectedCursorError(error)) throw error;
			console.warn("[message-log:auto-history] saved sync token rejected; retrying without token", {
				chatMid: chat.chatMid,
				error: compactError(error),
			});
			await clearRejectedCursor(chat, "recent");
			syncToken = undefined;
			response = await fetchSquareChatEvents(client, {
				...options,
				syncToken: undefined,
			});
		}
		syncToken = response.syncToken;
		recordEvents(chat, response.events as SquareHistoryEvent[]);
		if (response.events.length === 0) break;
		await sleep(appConfig.messageLogBackfillDelayMs);
	}
	return syncToken;
}

async function catchUpRecent(client: Client, chat: MessageLogChatSummary): Promise<void> {
	const syncToken = await primeRecent(client, chat, appConfig.messageLogAutoHistoryRecentPages);
	messageLogStore.updateAutoHistoryState(chat, {
		...(chat.autoHistory ?? {}),
		syncToken,
		continuationToken: undefined,
		lastMode: "recent",
	});
	await messageLogStore.checkpointLocal();
	await messageLogStore.flush();
}

async function incrementalBackfill(client: Client, chat: MessageLogChatSummary): Promise<void> {
	let state: MessageLogAutoHistoryState = chat.autoHistory ?? {};
	let syncToken = state.syncToken;
	let continuationToken = state.continuationToken;
	let oldestAt = chat.oldestMessageAt;
	if (!syncToken || !continuationToken) {
		syncToken = await primeRecent(client, chat, appConfig.messageLogAutoHistoryRecentPages);
		continuationToken = undefined;
	}
	if (!syncToken) return;

	let finishedAt = state.finishedAt;
	for (let page = 0; page < appConfig.messageLogAutoHistoryBackfillPages; page++) {
		const options: FetchSquareChatEventsOptions = {
			squareChatMid: chat.chatMid,
			syncToken,
			direction: "BACKWARD",
			inclusive: page === 0 && !continuationToken ? "ON" : "OFF",
			fetchType: "DEFAULT",
			limit: 100,
			...(continuationToken ? { continuationToken } : {}),
		};
		let response: Awaited<ReturnType<typeof fetchSquareChatEvents>>;
		try {
			response = await fetchSquareChatEvents(client, options);
		} catch (error) {
			if (!isRejectedCursorError(error)) throw error;
			console.warn("[message-log:auto-history] backfill cursor rejected; cursor will be rebuilt later", {
				chatMid: chat.chatMid,
				hasSyncToken: Boolean(syncToken),
				hasContinuationToken: Boolean(continuationToken),
				error: compactError(error),
			});
			await clearRejectedCursor(chat, "backfill");
			return;
		}
		syncToken = response.syncToken;
		continuationToken = response.continuationToken || undefined;
		const stats = recordEvents(chat, response.events as SquareHistoryEvent[]);
		if (stats.oldestAt !== undefined && (!oldestAt || stats.oldestAt < oldestAt)) {
			oldestAt = stats.oldestAt;
		}
		if (!continuationToken) {
			finishedAt = new Date().toISOString();
		}
		state = {
			syncToken,
			continuationToken,
			finishedAt,
			lastMode: "backfill",
		};
		messageLogStore.updateAutoHistoryState(chat, state, { oldestMessageAt: oldestAt });
		await messageLogStore.checkpointLocal();
		if (finishedAt && !continuationToken) {
			break;
		}
		await sleep(appConfig.messageLogBackfillDelayMs);
	}
	state = {
		syncToken,
		continuationToken,
		finishedAt,
		lastMode: "backfill",
	};
	if (finishedAt && !continuationToken) {
		messageLogStore.markBackfillComplete(chat, oldestAt);
	} else {
		messageLogStore.updateAutoHistoryState(chat, state, { oldestMessageAt: oldestAt });
	}
	await messageLogStore.checkpointLocal();
	await messageLogStore.flush();
}

async function runAutoHistoryOnce(client: Client): Promise<void> {
	if (getActiveHistoryJob()) return;
	const chats = messageLogStore.listSquareChats();
	if (chats.length === 0) return;
	const quiet = isQuietHour();
	const idle = isIdleEnough();
	const completed = chats
		.filter((chat) => chat.backfillCompletedAt)
		.sort((left, right) => autoHistorySortTime(left) - autoHistorySortTime(right));
	const incomplete = chats
		.filter((chat) => !chat.backfillCompletedAt && !chat.autoHistory?.finishedAt)
		.sort((left, right) => autoHistorySortTime(left) - autoHistorySortTime(right));
	const target = (quiet || idle) && incomplete.length > 0
		? incomplete[0]
		: completed[0];
	if (!target) return;
	const jobId = `auto:${target.chatMid}:${Date.now()}`;
	if (!tryStartHistoryJob({
		id: jobId,
		key: `square:${target.chatMid}`,
		requester: "auto-history",
		startedAt: Date.now(),
		type: "auto",
	})) return;
	try {
		if (target.backfillCompletedAt) {
			await catchUpRecent(client, target);
		} else {
			await incrementalBackfill(client, target);
		}
	} finally {
		finishHistoryJob(jobId);
	}
}

export function startMessageLogAutoHistoryScheduler(
	getClient: () => Client | null,
	signal: AbortSignal,
): void {
	if (!appConfig.messageLogAutoHistoryEnabled) return;
	let running = false;
	const run = () => {
		if (running || signal.aborted) return;
		const client = getClient();
		if (!client) return;
		running = true;
		void runAutoHistoryOnce(client)
			.catch((error) => {
				console.warn("[message-log:auto-history] failed", error);
			})
			.finally(() => {
				running = false;
			});
	};
	const timer = setInterval(run, appConfig.messageLogAutoHistoryIntervalMs);
	setTimeout(run, Math.min(60_000, appConfig.messageLogAutoHistoryIntervalMs));
	signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
