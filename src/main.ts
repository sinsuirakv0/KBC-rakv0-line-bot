import { SquareMessage, type Client } from "@evex/linejs";
import { appConfig } from "./config.js";
import { getLineCommandPolicy, handleLineCommand } from "./commands/index.js";
import { handleOcSetupReply } from "./commands/oc.js";
import {
	THREAD_OUTPUT_NOTICE,
	type OutgoingImage,
	type OutgoingMention,
	type ReplyableLineMessage,
} from "./commands/shared.js";
import { handleSearchPageReply } from "./commands/searchPages.js";
import { handleLogTargetSelectionReply } from "./commands/log.js";
import { handlePing } from "./handlers/ping.js";
import {
	createLineClient,
	isAuthenticationError,
	isExpiredAuthenticationError,
} from "./lineClient.js";
import { startEventPushScheduler } from "./eventPush/scheduler.js";
import { eventPushStore } from "./eventPush/store.js";
import { startPushReminderScheduler } from "./reminders/scheduler.js";
import { pushReminderStore } from "./reminders/store.js";
import { startEventUpdateServer } from "./server/eventUpdateServer.js";
import { initializeLineStorage, type SyncedLineStorage } from "./storage/lineStorage.js";
import { pushSubscriptionStore } from "./subscriptions/store.js";
import { rankingStore } from "./ranking/store.js";
import { runtimeStore } from "./runtime/store.js";
import { lineHealth } from "./runtime/lineHealth.js";
import {
	compactLineError,
	isUnsupportedLineError,
	LoginRetryPolicy,
} from "./runtime/lineErrorPolicy.js";
import { ReceiverSupervisor } from "./runtime/receiverSupervisor.js";
import { SessionManager } from "./runtime/sessionManager.js";
import { runStartupStages } from "./runtime/startupStages.js";
import {
	listenTalkPushEvents,
	type TalkPushTransport,
} from "./runtime/talkPushReceiver.js";
import {
	applyTalkSyncResponse,
	classifyTalkSyncGone,
	requestTalkSyncV3,
	type TalkSyncCursor,
	type TalkSyncResponse,
} from "./runtime/talkSync.js";
import { lineApiQueue } from "./runtime/lineApiQueue.js";
import { ForegroundQueueFullError, runtimeWorkload } from "./runtime/workload.js";
import { recordSquareEventDebug, recordSquareHandlerDebug } from "./runtime/squareEventDebug.js";
import { ocIdentitySnapshotsStore } from "./moderation/ocIdentitySnapshots.js";
import { ocKickHistoryStore } from "./moderation/ocKickHistory.js";
import { ocMemberActivityStore } from "./moderation/ocMemberActivity.js";
import { ocRecentPresenceStore } from "./moderation/ocRecentPresence.js";
import { ocModerationCasesStore } from "./moderation/ocModerationCases.js";
import {
	handleOpenChatMemberJoin,
	handleOpenChatMemberLeave,
	handleOpenChatModerationCaseReply,
	handleOpenChatNoteStatusModeration,
	handleOpenChatModeration,
	handleOpenChatPostModeration,
	type OpenChatMemberJoinEvent,
	type OpenChatMemberLeaveEvent,
	type OpenChatNoteStatusModerationEvent,
	type OpenChatPostModerationEvent,
} from "./moderation/ocModeration.js";
import {
	handleOpenChatJoinEventMessage,
	handleOpenChatLeaveEventMessage,
	handleOpenChatJoinSystemMessage,
	nameFromJoinNotificationText,
} from "./moderation/ocJoinMessage.js";
import { listenOpenChatJoinMessageEvents } from "./moderation/ocJoinMessagePolling.js";
import { ocModerationSettingsStore } from "./moderation/ocModerationSettings.js";
import {
	isSquareChatMembershipJoined,
	isSquareChatMembershipLeft,
	isSquareMembershipJoined,
	isSquareMembershipLeft,
} from "./moderation/squareMembership.js";
import { botStopTargetFromDestination, permissionStore } from "./permissions/store.js";
import { memberNameHistoryStore } from "./nameHistory/store.js";
import { startMessageLogAutoHistoryScheduler } from "./messageLog/autoHistory.js";
import { startMessageLogRemoteSyncScheduler } from "./messageLog/remoteSync.js";
import { messageLogStore, type StoredMessageLog } from "./messageLog/store.js";
import { memberEventLogStore } from "./memberEventLog/store.js";
import { startMemberEventLogRemoteSyncScheduler } from "./memberEventLog/remoteSync.js";

interface RawTalkMessage {
	id: string;
	from: string;
	to: string;
	toType: string;
	createdTime?: number | bigint;
	text?: string;
	chunks?: unknown;
	contentMetadata?: Record<string, string>;
	relatedMessageId?: string;
	messageRelationType?: string | number;
}

interface RawTalkEvent {
	type: string;
	revision?: number | bigint;
	message?: RawTalkMessage;
}

interface ParsedTalkText {
	text: string;
	mentionMids: string[];
}

interface RawSquareEvent {
	createdTime?: number | bigint;
	type: string | number;
	payload?: {
		notificationMessage?: {
			squareMessage: unknown;
			threadMid?: string;
		};
		receiveMessage?: {
			squareMessage: unknown;
			threadMid?: string;
		};
		sendMessage?: {
			squareMessage: unknown;
			threadMid?: string;
		};
		mutateMessage?: {
			squareMessage: unknown;
			threadMid?: string;
		};
		notificationThreadMessage?: {
			threadMid?: string;
			chatMid?: string;
			squareMessage?: unknown;
			senderDisplayName?: string;
			threadRootMessageId?: string;
		};
		notificationPost?: {
			squareMid?: string;
			notificationPostType?: string | number;
			text?: string;
			actionUri?: string;
		};
		notifiedUpdateSquareNoteStatus?: {
			squareMid?: string;
			noteStatus?: unknown;
		};
		notifiedCreateSquareMember?: unknown;
		notifiedCreateSquareChatMember?: unknown;
		notifiedJoinSquareChat?: unknown;
		notifiedLeaveSquareChat?: unknown;
		notifiedUpdateSquareMember?: unknown;
		notifiedUpdateSquareChatMember?: unknown;
	} & Record<string, unknown>;
}

interface RawSquareMessage {
	message?: {
		id?: string;
		from?: string;
		to?: string;
		toType?: string;
		createdTime?: number | bigint;
		text?: string;
		contentType?: string | number;
		hasContent?: boolean;
		contentMetadata?: Record<string, string>;
	};
	threadInfo?: {
		chatThreadMid?: string;
		threadRoot?: boolean;
	};
}

interface SquareEventMessage {
	raw: unknown;
	threadMid?: string;
	chatMid?: string;
}

let warnedEncryptedTalk = false;
let activeHandlers = 0;
const senderNames = new Map<string, string>();
const senderNameRequests = new Map<string, Promise<string | undefined>>();
const senderNameFailureUntil = new Map<string, number>();
const squareScopeRequests = new Map<string, Promise<string>>();
const squareSelfMemberRequests = new Map<string, Promise<string | undefined>>();
const SENDER_NAME_CACHE_MAX = 5_000;
const SENDER_NAME_CACHE_RETAIN = 4_000;
const SENDER_NAME_FAILURE_CACHE_MAX = 2_000;
const SENDER_NAME_FAILURE_RETRY_MS = 10 * 60_000;
const SENDER_NAME_UNSUPPORTED_RETRY_MS = 6 * 60 * 60_000;

function rememberSenderName(key: string, name: string): void {
	senderNames.set(key, name);
	senderNameFailureUntil.delete(key);
	if (senderNames.size <= SENDER_NAME_CACHE_MAX) return;
	while (senderNames.size > SENDER_NAME_CACHE_RETAIN) {
		const oldestKey = senderNames.keys().next().value as string | undefined;
		if (!oldestKey) break;
		senderNames.delete(oldestKey);
	}
}

function rememberSenderNameFailure(key: string, retryAt: number): void {
	senderNameFailureUntil.set(key, retryAt);
	while (senderNameFailureUntil.size > SENDER_NAME_FAILURE_CACHE_MAX) {
		const oldestKey = senderNameFailureUntil.keys().next().value as string | undefined;
		if (!oldestKey) break;
		senderNameFailureUntil.delete(oldestKey);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function messageContent(text: string | undefined, contentType: string | number | undefined, hasContent: boolean | undefined): string {
	const normalizedText = (text ?? "").replace(/\s+/g, " ").trim();
	const label = contentTypeLabel(contentType, hasContent);
	if (label && normalizedText) return `${label} ${normalizedText}`;
	if (label) return label;
	return normalizedText || "(本文なし)";
}

function cleanSquareDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || /^p[0-9a-f]{8,}$/i.test(trimmed)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(trimmed)) return undefined;
	if (/^[\p{C}\s]+$/u.test(trimmed)) return undefined;
	return trimmed;
}

function nameFromLeaveNotificationText(text: string | undefined): string | undefined {
	const normalized = text?.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	for (const pattern of [
		/^(.+?)(?:さん)?が(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?)(?:さん)?が(?:トーク|OpenChat|オープンチャット)から(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?) left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
		/^(.+?) has left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
	]) {
		const name = cleanSquareDisplayName(normalized.match(pattern)?.[1]);
		if (name) return name;
	}
	return undefined;
}

async function handleOpenChatMemberSystemMessage(
	client: Client,
	rawMessage: NonNullable<RawSquareMessage["message"]>,
	destination: SquareReplyTarget["destination"],
	threadMid?: string,
): Promise<void> {
	if (threadMid || !rawMessage.from?.startsWith("p")) return;
	const createdAt = rawMessage.createdTime === undefined
		? undefined
		: Number(rawMessage.createdTime);
	const joinedName = nameFromJoinNotificationText(rawMessage.text);
	if (joinedName) {
		console.log("[oc-left-soon] join system message detected", {
			squareMid: destination.scopeMid,
			squareChatMid: destination.chatMid,
			memberMid: rawMessage.from,
			createdAt,
		});
		await handleOpenChatMemberJoin({
			client,
			squareMid: destination.scopeMid,
			squareChatMid: destination.chatMid,
			memberMid: rawMessage.from,
			displayName: joinedName,
			joinedAt: createdAt,
			source: "chat-member",
		});
		return;
	}

	const leftName = nameFromLeaveNotificationText(rawMessage.text);
	if (!leftName) return;
	try {
		const response = await client.base.square.getSquareChatMember({
			request: {
				squareMemberMid: rawMessage.from,
				squareChatMid: destination.chatMid,
			},
		});
		if (!isSquareChatMembershipLeft(response.squareChatMember.membershipState)) {
			console.log("[oc-left-soon] leave-like text ignored because member is still in main chat", {
				squareMid: destination.scopeMid,
				squareChatMid: destination.chatMid,
				memberMid: rawMessage.from,
				membershipState: String(response.squareChatMember.membershipState),
			});
			return;
		}
	} catch (error) {
		console.warn("[oc-left-soon] leave system message verification failed", {
			squareMid: destination.scopeMid,
			squareChatMid: destination.chatMid,
			memberMid: rawMessage.from,
			error,
		});
		return;
	}
	console.log("[oc-left-soon] leave system message detected", {
		squareMid: destination.scopeMid,
		squareChatMid: destination.chatMid,
		memberMid: rawMessage.from,
		createdAt,
	});
	await handleOpenChatMemberLeave({
		client,
		squareMid: destination.scopeMid,
		squareChatMid: destination.chatMid,
		memberMid: rawMessage.from,
		displayName: leftName,
		leftAt: createdAt,
		source: "chat-member",
	});
}

function mentionMetadata(mentions: OutgoingMention[]): Record<string, string> {
	return {
		MENTION: JSON.stringify({
			MENTIONEES: mentions.map((mention) => ({
				S: String(mention.start),
				E: String(mention.end),
				M: mention.mid,
			})),
		}),
	};
}

async function dispatchText(
	channel: "talk" | "square",
	messageText: string,
	message: ReplyableLineMessage,
): Promise<void> {
	try {
		const command = messageText.slice(appConfig.commandPrefix.length).trim().split(/\s+/, 1)[0] || "unknown";
		const commandPolicy = getLineCommandPolicy(messageText);
		const highPriority = command === "ping" || commandPolicy?.priority === "high";
		await runtimeWorkload.runForeground(
			`${channel}:!${command}`,
			() => lineApiQueue.withPriority(highPriority ? "high" : "normal", async () => {
				const startedAt = Date.now();
				activeHandlers += 1;
				try {
					if (
						messageText.startsWith(appConfig.commandPrefix) &&
						!isBotPermissionBypassCommand(messageText) &&
						!permissionStore.canExecute(message.destination)
					) {
						await message.send("実行権限がありません。");
						return;
					}
					if (messageText === `${appConfig.commandPrefix}ping` || messageText === `${appConfig.commandPrefix}ping help`) {
						rankingStore.record(message.destination);
						if (await handlePing(messageText, message)) return;
					}
					if (await handleLineCommand(messageText, message)) return;
				} catch (error) {
					if (channel === "square") {
						recordSquareHandlerDebug(`dispatch error text=${shortDebugText(messageText)} error=${compactError(error)}`);
					}
					console.error(`[${channel}:message] handler failed`, error);
				} finally {
					const elapsedMs = Date.now() - startedAt;
					if (elapsedMs >= 1_000 || messageText === `${appConfig.commandPrefix}ping`) {
						console.log(`[perf] ${channel} !${command} handler=${elapsedMs}ms concurrent=${activeHandlers}`);
					}
					activeHandlers -= 1;
				}
			}),
			highPriority ? "high" : "normal",
		);
	} catch (error) {
		if (error instanceof ForegroundQueueFullError) {
			console.warn(`[workload] command queue full channel=${channel} queue=${error.queueLength}`);
			await message.send("現在BOTが混み合っています。少し待ってからもう一度実行してください。");
			return;
		}
		throw error;
	}
}

function isBotPermissionBypassCommand(messageText: string): boolean {
	const body = messageText.slice(appConfig.commandPrefix.length).trim().toLowerCase();
	return /^bot\s+setting\s+status(?:\s|$)/.test(body) ||
		/^bot\s+(?:start|stop)(?:\s|$)/.test(body);
}

function isBotStartCommand(messageText: string): boolean {
	const body = messageText.slice(appConfig.commandPrefix.length).trim().toLowerCase();
	return /^bot\s+start(?:\s|$)/.test(body);
}

function shouldIgnoreStoppedText(messageText: string, message: ReplyableLineMessage): boolean {
	const target = botStopTargetFromDestination(message.destination);
	return permissionStore.isBotStopped(target) && !isBotStartCommand(messageText);
}

function isSquareEventType(event: RawSquareEvent, name: string, value: number): boolean {
	return event.type === name || event.type === value;
}

function squareMessagesFromEvent(event: RawSquareEvent): SquareEventMessage[] {
	const payload = event.payload;
	if (!payload) return [];
	const messages: SquareEventMessage[] = [];
	if (isSquareEventType(event, "NOTIFICATION_MESSAGE", 29) && payload.notificationMessage?.squareMessage) {
		messages.push({
			raw: payload.notificationMessage.squareMessage,
			threadMid: payload.notificationMessage.threadMid ?? squareThreadMidFromRaw(payload.notificationMessage.squareMessage),
		});
	}
	if (isSquareEventType(event, "RECEIVE_MESSAGE", 0) && payload.receiveMessage?.squareMessage) {
		messages.push({
			raw: payload.receiveMessage.squareMessage,
			threadMid: payload.receiveMessage.threadMid ?? squareThreadMidFromRaw(payload.receiveMessage.squareMessage),
		});
	}
	if (isSquareEventType(event, "SEND_MESSAGE", 1) && payload.sendMessage?.squareMessage) {
		messages.push({
			raw: payload.sendMessage.squareMessage,
			threadMid: payload.sendMessage.threadMid ?? squareThreadMidFromRaw(payload.sendMessage.squareMessage),
		});
	}
	if (
		isSquareEventType(event, "MUTATE_MESSAGE", 41) &&
		payload.mutateMessage?.squareMessage
	) {
		messages.push({
			raw: payload.mutateMessage.squareMessage,
			threadMid: payload.mutateMessage.threadMid ?? squareThreadMidFromRaw(payload.mutateMessage.squareMessage),
		});
	}
	if (
		isSquareEventType(event, "NOTIFICATION_THREAD_MESSAGE", 54) &&
		payload.notificationThreadMessage?.squareMessage
	) {
		messages.push({
			raw: payload.notificationThreadMessage.squareMessage,
			chatMid: payload.notificationThreadMessage.chatMid,
			threadMid: payload.notificationThreadMessage.threadMid ??
				squareThreadMidFromRaw(payload.notificationThreadMessage.squareMessage),
		});
	}
	return messages;
}

function squareThreadMidFromRaw(value: unknown): string | undefined {
	return rawString(rawObject(rawObject(value)?.threadInfo)?.chatThreadMid);
}

function squareEventCreatedAt(event: RawSquareEvent): number | undefined {
	const timestamps = [rawNumber(event.createdTime)];
	for (const eventMessage of squareMessagesFromEvent(event)) {
		const rawMessage = rawObject(rawObject(eventMessage.raw)?.message);
		timestamps.push(rawNumber(rawMessage?.createdTime));
	}
	const valid = timestamps.filter((value): value is number => value !== undefined);
	return valid.length > 0 ? Math.max(...valid) : undefined;
}

function postModerationEventFromSquareEvent(
	client: Client,
	event: RawSquareEvent,
): OpenChatPostModerationEvent | undefined {
	const post = event.payload?.notificationPost;
	if (!isSquareEventType(event, "NOTIFICATION_POST", 40) || !post?.squareMid) return undefined;
	return {
		client,
		squareMid: post.squareMid,
		notificationPostType: post.notificationPostType,
		text: post.text,
		actionUri: post.actionUri,
	};
}

function noteStatusModerationEventFromSquareEvent(
	client: Client,
	event: RawSquareEvent,
): OpenChatNoteStatusModerationEvent | undefined {
	const noteStatus = event.payload?.notifiedUpdateSquareNoteStatus;
	if (!isSquareEventType(event, "NOTIFIED_UPDATE_SQUARE_NOTE_STATUS", 36) || !noteStatus?.squareMid) {
		return undefined;
	}
	return {
		client,
		squareMid: noteStatus.squareMid,
	};
}

function rawObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawNumber(value: unknown): number | undefined {
	const numeric = typeof value === "bigint" ? Number(value) : Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function compactError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function shortDebugText(value: string | undefined, maxLength = 80): string {
	const text = (value ?? "(none)").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function rawMember(value: unknown): {
	memberMid?: string;
	squareMid?: string;
	displayName?: string;
	membershipState?: unknown;
	createdAt?: number;
} {
	const raw = rawObject(value);
	return {
		memberMid: rawString(raw?.squareMemberMid),
		squareMid: rawString(raw?.squareMid),
		displayName: rawString(raw?.displayName),
		membershipState: raw?.membershipState,
		createdAt: rawNumber(raw?.createdAt),
	};
}

function rawChat(value: unknown): { squareChatMid?: string; squareMid?: string } {
	const raw = rawObject(value);
	return {
		squareChatMid: rawString(raw?.squareChatMid),
		squareMid: rawString(raw?.squareMid),
	};
}

function rawChatMember(value: unknown): {
	memberMid?: string;
	squareChatMid?: string;
	membershipState?: unknown;
} {
	const raw = rawObject(value);
	return {
		memberMid: rawString(raw?.squareMemberMid),
		squareChatMid: rawString(raw?.squareChatMid),
		membershipState: raw?.membershipState,
	};
}

async function memberActivityEventsFromSquareEvent(
	client: Client,
	event: RawSquareEvent,
): Promise<{ joins: OpenChatMemberJoinEvent[]; leaves: OpenChatMemberLeaveEvent[] }> {
	const payload = event.payload;
	const eventCreatedAt = rawNumber(event.createdTime);
	const joins: OpenChatMemberJoinEvent[] = [];
	const leaves: OpenChatMemberLeaveEvent[] = [];
	if (!payload) return { joins, leaves };

	if (isSquareEventType(event, "NOTIFIED_CREATE_SQUARE_MEMBER", 15)) {
		const raw = rawObject(payload.notifiedCreateSquareMember);
		const member = rawMember(raw?.squareMember);
		if (member.squareMid && member.memberMid) {
			joins.push({
				client,
				squareMid: member.squareMid,
				memberMid: member.memberMid,
				displayName: member.displayName,
				joinedAt: member.createdAt ?? eventCreatedAt,
				memberCreatedAt: member.createdAt,
				source: "square-member",
			});
		}
	}

	if (isSquareEventType(event, "NOTIFIED_CREATE_SQUARE_CHAT_MEMBER", 16)) {
		const raw = rawObject(payload.notifiedCreateSquareChatMember);
		const chat = rawChat(raw?.chat);
		const chatMember = rawChatMember(raw?.chatMember);
		const peer = rawMember(raw?.peerSquareMember);
		const squareMid = chat.squareMid ?? peer.squareMid;
		const squareChatMid = chat.squareChatMid ?? chatMember.squareChatMid;
		const memberMid = chatMember.memberMid ?? peer.memberMid;
		if (squareMid && squareChatMid && memberMid) {
			joins.push({
				client,
				squareMid,
				squareChatMid,
				memberMid,
				displayName: peer.displayName,
				joinedAt: rawNumber(raw?.joinedAt) ?? peer.createdAt ?? eventCreatedAt,
				memberCreatedAt: peer.createdAt,
				source: "chat-member",
			});
		}
	}

	if (isSquareEventType(event, "NOTIFIED_JOIN_SQUARE_CHAT", 2)) {
		const raw = rawObject(payload.notifiedJoinSquareChat);
		const member = rawMember(raw?.joinedMember);
		const squareChatMid = rawString(raw?.squareChatMid);
		console.log("[oc-join-message] raw join event", {
			squareChatMid,
			squareMid: member.squareMid,
			memberMid: member.memberMid,
			displayName: member.displayName,
			parsed: Boolean(member.squareMid && squareChatMid && member.memberMid),
		});
		if (member.squareMid && squareChatMid && member.memberMid) {
			joins.push({
				client,
				squareMid: member.squareMid,
				squareChatMid,
				memberMid: member.memberMid,
				displayName: member.displayName,
				joinedAt: eventCreatedAt ?? member.createdAt,
				memberCreatedAt: member.createdAt,
				source: "chat-member",
			});
		}
	}

	if (isSquareEventType(event, "NOTIFIED_LEAVE_SQUARE_CHAT", 4)) {
		const raw = rawObject(payload.notifiedLeaveSquareChat);
		const member = rawMember(raw?.squareMember);
		const squareChatMid = rawString(raw?.squareChatMid);
		const memberMid = rawString(raw?.squareMemberMid) ?? member.memberMid;
		const squareMid = member.squareMid ?? (squareChatMid && memberMid
			? await resolveSquareScope(client, squareChatMid, memberMid)
			: undefined);
		if (squareMid && squareChatMid && memberMid) {
			leaves.push({
				client,
				squareMid,
				squareChatMid,
				memberMid,
				displayName: member.displayName,
				leftAt: eventCreatedAt,
				memberCreatedAt: member.createdAt,
				source: "chat-member",
			});
		}
	}

	if (isSquareEventType(event, "NOTIFIED_UPDATE_SQUARE_CHAT_MEMBER", 14)) {
		const raw = rawObject(payload.notifiedUpdateSquareChatMember);
		const chatMember = rawChatMember(raw?.squareChatMember);
		const squareChatMid = rawString(raw?.squareChatMid) ?? chatMember.squareChatMid;
		const memberMid = chatMember.memberMid;
		const squareMid = squareChatMid && memberMid
			? await resolveSquareScope(client, squareChatMid, memberMid)
			: undefined;
		if (squareMid && squareChatMid && memberMid && isSquareChatMembershipJoined(chatMember.membershipState)) {
			joins.push({
				client,
				squareMid,
				squareChatMid,
				memberMid,
				joinedAt: eventCreatedAt,
				source: "chat-member",
			});
		}
		if (squareMid && squareChatMid && memberMid && isSquareChatMembershipLeft(chatMember.membershipState)) {
			leaves.push({
				client,
				squareMid,
				squareChatMid,
				memberMid,
				leftAt: eventCreatedAt,
				source: "chat-member",
			});
		}
	}

	if (isSquareEventType(event, "NOTIFIED_UPDATE_SQUARE_MEMBER", 11)) {
		const raw = rawObject(payload.notifiedUpdateSquareMember);
		const member = rawMember(raw?.squareMember);
		const squareMid = rawString(raw?.squareMid) ?? member.squareMid;
		const memberMid = rawString(raw?.squareMemberMid) ?? member.memberMid;
		if (squareMid && memberMid && isSquareMembershipJoined(member.membershipState)) {
			joins.push({
				client,
				squareMid,
				memberMid,
				displayName: member.displayName,
				joinedAt: member.createdAt ?? eventCreatedAt,
				memberCreatedAt: member.createdAt,
				source: "square-member",
			});
		}
		if (squareMid && memberMid && isSquareMembershipLeft(member.membershipState)) {
			leaves.push({
				client,
				squareMid,
				memberMid,
				displayName: member.displayName,
				leftAt: eventCreatedAt,
				memberCreatedAt: member.createdAt,
				clearAllChats: true,
				source: "square-member",
			});
		}
	}

	if (joins.length > 0 || leaves.length > 0) {
		console.log("[oc-member-event] parsed", {
			type: String(event.type),
			createdAt: eventCreatedAt,
			joins: joins.map((join) => ({
				source: join.source,
				squareMid: join.squareMid,
				squareChatMid: join.squareChatMid,
				memberMid: join.memberMid,
				joinedAt: join.joinedAt,
				memberCreatedAt: join.memberCreatedAt,
			})),
			leaves: leaves.map((leave) => ({
				source: leave.source,
				squareMid: leave.squareMid,
				squareChatMid: leave.squareChatMid,
				memberMid: leave.memberMid,
				leftAt: leave.leftAt,
				memberCreatedAt: leave.memberCreatedAt,
				clearAllChats: leave.clearAllChats,
			})),
		});
	}

	return { joins, leaves };
}

function squareMentionMids(message: SquareMessage): string[] {
	try {
		return message.getMentions()
			.flatMap((mention) => mention.all ? [] : [mention.mid]);
	} catch {
		return [];
	}
}

async function handleSquareMessage(
	client: Client,
	message: SquareMessage,
	threadMid?: string,
	chatMidOverride?: string,
): Promise<void> {
	const chatMid = chatMidOverride ?? message.to.id;
	const rawMessage = (message.raw as RawSquareMessage).message;
	const senderMid = rawMessage?.from ?? message.from.id;
	if (threadMid || rawMessage?.text?.startsWith(appConfig.commandPrefix)) {
		recordSquareHandlerDebug(
			`square message received id=${rawMessage?.id ?? "(none)"} chatMid=${chatMid} threadMid=${threadMid ?? "(none)"} ` +
				`rawTo=${rawMessage?.to ?? "(none)"} toType=${String(rawMessage?.toType ?? "(none)")} ` +
				`from=${senderMid ?? "(none)"} text=${shortDebugText(rawMessage?.text)}`,
		);
	}
	if (await isOwnSquareMessage(client, chatMid, senderMid)) {
		if (threadMid || rawMessage?.text?.startsWith(appConfig.commandPrefix)) {
			recordSquareHandlerDebug(`square message skipped self id=${rawMessage?.id ?? "(none)"} chatMid=${chatMid}`);
		}
		return;
	}
	const scopeMid = await resolveSquareScope(client, chatMid, message.from.id);
	const target = new SquareReplyTarget(
		client,
		message,
		scopeMid,
		senderNames.get(`square:${message.from.id}`),
		threadMid,
		chatMid,
	);
	recordSquareMessage(message, target.destination);
	if (rawMessage) {
		await handleOpenChatMemberSystemMessage(client, rawMessage, target.destination, threadMid)
			.catch((error) => {
				console.warn("[oc-left-soon] system message processing failed", error);
			});
	}
	if (
		rawMessage?.id &&
		!permissionStore.isBotStopped(botStopTargetFromDestination(target.destination)) &&
		await handleOpenChatModeration({
			client,
			squareChatMid: target.destination.chatMid,
			squareMid: target.destination.scopeMid,
			senderMid: target.destination.senderMid,
			messageId: rawMessage.id,
			text: rawMessage.text,
			contentType: rawMessage.contentType,
			contentMetadata: rawMessage.contentMetadata,
			createdAt: rawMessage.createdTime === undefined ? undefined : Number(rawMessage.createdTime),
		})
	) return;
	const squareText = typeof message.text === "string" ? message.text : rawMessage?.text;
	if (typeof squareText !== "string") {
		if (!threadMid && ocModerationSettingsStore.joinMessage(target.destination.chatMid)) {
			console.log("[oc-join-message] configured chat message skipped no text", {
				squareMid: target.destination.scopeMid,
				squareChatMid: target.destination.chatMid,
				messageId: rawMessage?.id,
				senderMid: target.destination.senderMid,
				contentType: rawMessage?.contentType,
				metadataKeys: Object.keys(rawMessage?.contentMetadata ?? {}).sort(),
			});
		}
		if (threadMid) recordSquareHandlerDebug(`square message skipped no text id=${rawMessage?.id ?? "(none)"}`);
		return;
	}
	if (shouldIgnoreStoppedText(squareText, target)) {
		if (threadMid || squareText.startsWith(appConfig.commandPrefix)) {
			recordSquareHandlerDebug(`square command skipped bot stopped id=${rawMessage?.id ?? "(none)"}`);
		}
		return;
	}
	if (!squareText.startsWith(appConfig.commandPrefix)) {
		if (!threadMid && await handleOpenChatJoinSystemMessage({
			client,
			squareMid: target.destination.scopeMid,
			squareChatMid: target.destination.chatMid,
			senderMid: target.destination.senderMid,
			senderName: target.destination.senderName,
			messageId: rawMessage?.id,
			text: squareText,
			contentType: rawMessage?.contentType,
			contentMetadata: rawMessage?.contentMetadata,
			mentionMids: target.mentionMids,
		})) return;
		if (await handleOcSetupReply(squareText, target)) return;
		if (await handleOpenChatModerationCaseReply(squareText, target)) return;
		if (await handleLogTargetSelectionReply(squareText, target)) return;
		await handleSearchPageReply(squareText, target);
		return;
	}
	if (threadMid) recordSquareHandlerDebug(`square command dispatch id=${rawMessage?.id ?? "(none)"} text=${shortDebugText(squareText)}`);
	await dispatchText("square", squareText, target);
	void resolveSenderName(client, "square", message.from.id)
		.then((name) => {
			if (name) rankingStore.updateName("square", message.from.id, name);
			if (name) memberNameHistoryStore.record("square", scopeMid, message.from.id, name);
			if (name) {
				messageLogStore.recordMember({
					kind: "square",
					chatMid: target.destination.chatMid,
					scopeMid,
					chatType: "SQUARE",
					mid: message.from.id,
					name,
					state: "JOINED",
					source: "liveNameResolve",
				});
				recordSquareMessage(message, { ...target.destination, senderName: name });
			}
		})
		.catch((error) => {
			console.warn("[ranking] square name post-processing failed", compactLineError(error));
		});
}

function recordSquareMessage(message: SquareMessage, destination: SquareReplyTarget["destination"]): void {
	const raw = message.raw as RawSquareMessage;
	const rawMessage = raw.message;
	if (!rawMessage?.id || !rawMessage.from) return;
	const createdAt = Number(rawMessage.createdTime);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return;
	const record: StoredMessageLog = {
		id: rawMessage.id,
		kind: "square",
		chatMid: destination.chatMid,
		scopeMid: destination.scopeMid,
		chatType: "SQUARE",
		senderMid: rawMessage.from,
		senderName: destination.senderName,
		createdAt,
		content: messageContent(rawMessage.text, rawMessage.contentType, rawMessage.hasContent),
		contentType: rawMessage.contentType === undefined ? undefined : String(rawMessage.contentType),
		metadata: {
			source: "live-square",
			to: rawMessage.to,
			toType: rawMessage.toType,
			hasContent: rawMessage.hasContent,
			contentMetadataKeys: Object.keys(rawMessage.contentMetadata ?? {}).sort(),
		},
	};
	messageLogStore.record(record);
	const leftName = rawMessage.from.startsWith("p") ? nameFromLeaveNotificationText(rawMessage.text) : undefined;
	if (leftName) {
		memberNameHistoryStore.record("square", destination.scopeMid, rawMessage.from, leftName, createdAt);
		messageLogStore.recordMember({
			kind: "square",
			chatMid: destination.chatMid,
			scopeMid: destination.scopeMid,
			chatType: "SQUARE",
			mid: rawMessage.from,
			name: leftName,
			state: "LEFT",
			seenAt: createdAt,
			source: "liveLeaveNotification",
			extra: { notificationText: rawMessage.text },
		});
	}
}

function resolveSquareScope(client: Client, squareChatMid: string, senderMid: string): Promise<string> {
	let request = squareScopeRequests.get(squareChatMid);
	if (!request) {
		request = client.base.square.getSquareMember({ squareMemberMid: senderMid })
			.then((response) => {
				const member = response.squareMember;
				if (member.displayName) {
					rememberSenderName(`square:${senderMid}`, member.displayName);
					memberNameHistoryStore.record("square", member.squareMid, senderMid, member.displayName);
					messageLogStore.recordMember({
						kind: "square",
						chatMid: squareChatMid,
						scopeMid: member.squareMid,
						chatType: "SQUARE",
						mid: senderMid,
						name: member.displayName,
						state: "JOINED",
						role: member.role === undefined ? undefined : String(member.role),
						source: "resolveSquareScope",
						extra: {
							...(member.membershipState === undefined ? {} : { membershipState: String(member.membershipState) }),
						},
					});
				}
				return member.squareMid;
			})
			.catch((error) => {
				console.warn(`[ranking] member lookup failed for ${senderMid}; falling back to chat lookup`, error);
				return client.base.square.getSquareChat({ squareChatMid })
					.then((response) => response.squareChat.squareMid)
					.catch((fallbackError) => {
						squareScopeRequests.delete(squareChatMid);
						console.warn(`[ranking] failed to resolve parent OpenChat for ${squareChatMid}`, fallbackError);
						return squareChatMid;
					});
			});
		squareScopeRequests.set(squareChatMid, request);
	}
	return request;
}

function resolveSquareSelfMemberMid(client: Client, squareChatMid: string): Promise<string | undefined> {
	let request = squareSelfMemberRequests.get(squareChatMid);
	if (!request) {
		request = client.base.square.getSquareChat({ squareChatMid })
			.then((response) => response.squareChatMember.squareMemberMid || undefined)
			.catch((error) => {
				squareSelfMemberRequests.delete(squareChatMid);
				console.warn(`[square] failed to resolve self member for ${squareChatMid}`, error);
				return undefined;
			});
		squareSelfMemberRequests.set(squareChatMid, request);
	}
	return request;
}

async function isOwnSquareMessage(client: Client, squareChatMid: string, senderMid?: string): Promise<boolean> {
	if (!senderMid) return false;
	const selfMid = await resolveSquareSelfMemberMid(client, squareChatMid);
	return Boolean(selfMid && senderMid === selfMid);
}

function resolveSenderName(
	client: Client,
	kind: "talk" | "square",
	mid: string,
): Promise<string | undefined> {
	const key = `${kind}:${mid}`;
	const cached = senderNames.get(key);
	if (cached) return Promise.resolve(cached);
	const failureUntil = senderNameFailureUntil.get(key);
	if (failureUntil !== undefined) {
		if (failureUntil > Date.now()) return Promise.resolve(undefined);
		senderNameFailureUntil.delete(key);
	}
	let request = senderNameRequests.get(key);
	if (!request) {
		request = (kind === "square"
			? client.base.square.getSquareMember({ squareMemberMid: mid })
				.then((response) => response.squareMember.displayName)
			: client.getUser(mid).then((user) => user.raw.targetProfileDetail.profileName)
		).then((name) => {
			if (name) rememberSenderName(key, name);
			return name || undefined;
		}).catch((error) => {
			const retryMs = isUnsupportedLineError(error)
				? SENDER_NAME_UNSUPPORTED_RETRY_MS
				: SENDER_NAME_FAILURE_RETRY_MS;
			rememberSenderNameFailure(key, Date.now() + retryMs);
			console.warn(`[ranking] failed to resolve ${kind} name for ${mid}; retry is deferred`, {
				retryMs,
				error: compactLineError(error),
			});
			return undefined;
		}).finally(() => {
			senderNameRequests.delete(key);
		});
		senderNameRequests.set(key, request);
	}
	return request;
}

class SquareReplyTarget implements ReplyableLineMessage {
	readonly destination;
	readonly mentionMids: string[];
	readonly replyToMessageId?: string;
	private threadMid?: string;
	readonly isThreadSource: boolean;
	private pendingThreadRoot = false;
	private threadJoinAttempted = false;
	private rootNoticeSent = false;

	constructor(
		readonly client: Client,
		private readonly message: SquareMessage,
		scopeMid: string,
		senderName?: string,
		threadMid?: string,
		chatMid?: string,
	) {
		this.mentionMids = squareMentionMids(message);
		this.replyToMessageId = message.getReplyTarget()?.id;
		this.threadMid = threadMid ?? (message.raw as RawSquareMessage).threadInfo?.chatThreadMid;
		this.isThreadSource = Boolean(this.threadMid);
		this.destination = {
			kind: "square" as const,
			chatMid: chatMid ?? message.to.id,
			scopeMid,
			chatType: "SQUARE" as const,
			senderMid: message.from.id,
			senderName,
			encrypted: false,
		};
	}

	threadNoticeSent(): boolean {
		return this.rootNoticeSent;
	}

	async reply(text: string): Promise<string | undefined> {
		if (this.isThreadSource) return await this.sendThread(text);
		return await this.send(text);
	}

	async send(text: string): Promise<string | undefined> {
		if (this.isThreadSource) return await this.sendThread(text);
		const sent = await lineApiQueue.run(
			"square:send-text",
			() => this.client.base.square.sendMessage({
				squareChatMid: this.destination.chatMid,
				text,
			}),
			{ scope: this.lineApiScope() },
		);
		return messageIdFromSquareSendResult(sent);
	}

	async sendThread(text: string): Promise<string | undefined> {
		const threadMid = await this.resolveThreadMid(undefined, { allowCreate: true });
		return await this.sendThreadText(threadMid, text);
	}

	async debugThread(text = `thread debug ${new Date().toISOString()}`): Promise<string[]> {
		const rawMessage = (this.message.raw as RawSquareMessage).message;
		const sourceMessageId = rawMessage?.id;
		const lines = [
			`kind=${this.destination.kind}`,
			`chatMid=${this.destination.chatMid}`,
			`sourceMessageId=${sourceMessageId ?? "(none)"}`,
			`sourceTo=${rawMessage?.to ?? "(none)"}`,
			`sourceToType=${String(rawMessage?.toType ?? "(none)")}`,
			`isThreadSource=${this.isThreadSource}`,
			`initialThreadMid=${this.threadMid ?? "(none)"}`,
		];
		if (sourceMessageId && !this.isThreadSource) {
			const sourceThreadMid = await this.debugThreadMidFromMessage("source", sourceMessageId, lines);
			if (sourceThreadMid) {
				await this.debugSquareThread("source", sourceThreadMid, lines);
				await this.debugThreadEvents("source", sourceThreadMid, lines);
			}
		}
		let threadMid: string;
		try {
			threadMid = await this.resolveThreadMid(lines, { allowCreate: true });
			lines.push(`resolvedThreadMid=${threadMid}`);
		} catch (error) {
			lines.push(`resolveThreadMid=ERROR ${compactError(error)}`);
			return lines;
		}
		await this.debugSquareThread("resolved", threadMid, lines);
		await this.debugThreadEvents("resolved", threadMid, lines);
		try {
			const messageId = await this.sendThreadText(threadMid, text);
			lines.push(`sendSquareThreadMessage=OK id=${messageId ?? "(unknown)"}`);
			await this.debugSquareThread("after-send", threadMid, lines);
			await this.debugThreadEvents("after-send", threadMid, lines);
		} catch (error) {
			lines.push(`sendSquareThreadMessage=ERROR ${compactError(error)}`);
		}
		return lines;
	}

	private async sendThreadText(threadMid: string, text: string): Promise<string | undefined> {
		const sent = await lineApiQueue.run(
			"square:send-thread-text",
			async () => this.client.base.square.sendSquareThreadMessage({
				request: {
					reqSeq: await this.client.base.getReqseq("sq"),
					chatMid: this.destination.chatMid,
					threadMid,
					threadMessage: {
						message: {
							to: threadMid,
							text,
							contentType: "NONE",
							toType: "SQUARE_THREAD",
						},
					},
				},
			}),
			{ scope: this.lineApiScope() },
		);
		this.pendingThreadRoot = false;
		return messageIdFromSquareSendResult(sent);
	}

	async sendMention(text: string, mentions: OutgoingMention[]): Promise<string | undefined> {
		if (this.isThreadSource) return await this.sendThread(text);
		const sent = await lineApiQueue.run(
			"square:send-mention",
			() => this.client.base.square.sendMessage({
				squareChatMid: this.destination.chatMid,
				text,
				contentMetadata: mentionMetadata(mentions),
			}),
			{ scope: this.lineApiScope() },
		);
		return messageIdFromSquareSendResult(sent);
	}

	async sendImage(image: OutgoingImage): Promise<void> {
		await lineApiQueue.run("square:send-image", async () => {
			const sent = await this.client.base.square.sendMessage({
				squareChatMid: this.destination.chatMid,
				contentType: "IMAGE" as never,
			});
			const messageId = messageIdFromSquareSendResult(sent);
			if (!messageId) throw new Error("画像メッセージIDを取得できませんでした");
			await this.client.base.obs.uploadObjTalk(
				this.destination.chatMid,
				"image",
				image.blob,
				messageId,
				image.filename,
			);
		}, { scope: this.lineApiScope() });
	}

	async deleteMessage(messageId: string): Promise<void> {
		const threadMid = this.isThreadSource ? this.threadMid : undefined;
		await lineApiQueue.run("square:delete-message", async () => {
			try {
				await this.client.base.square.destroyMessage({
					squareChatMid: this.destination.chatMid,
					messageId,
					threadMid,
				});
				return;
			} catch (destroyError) {
				try {
					await this.client.base.square.unsendMessage({
						squareChatMid: this.destination.chatMid,
						messageId,
						threadMid,
					});
				} catch (unsendError) {
					console.warn("[square] progress message deletion failed", { destroyError, unsendError });
					throw unsendError;
				}
			}
		}, { scope: this.lineApiScope() });
	}

	private async resolveThreadMid(
		debugLines?: string[],
		options: { allowCreate?: boolean } = {},
	): Promise<string> {
		if (!this.threadMid) {
			if (!options.allowCreate) {
				throw new Error("LINE APIからスレッドを自動作成できません");
			}
			this.threadMid = await this.createThreadRoot(debugLines);
		}
		if (!this.pendingThreadRoot) await this.joinThread(this.threadMid, debugLines);
		return this.threadMid;
	}

	private async createThreadRoot(debugLines?: string[]): Promise<string> {
		if (this.isThreadSource) {
			const messageId = (this.message.raw as RawSquareMessage).message?.id;
			if (!messageId) throw new Error("スレッド親メッセージIDを取得できませんでした");
			const threadMid = await this.debugThreadMidFromMessage("thread-source", messageId, debugLines);
			if (!threadMid) throw new Error("スレッドMIDを取得できませんでした");
			return threadMid;
		}

		debugLines?.push("create thread root by normal bot message, then getSquareThreadMid(root)");
		const sent = await this.sendThreadRootNotice();
		this.rootNoticeSent = true;
		const rootMessageId = messageIdFromSquareSendResult(sent);
		debugLines?.push(`thread root send=OK id=${rootMessageId ?? "(unknown)"}`);
		if (!rootMessageId) throw new Error("スレッド親メッセージIDを取得できませんでした");
		const resolvedThreadMid = await this.debugThreadMidFromMessage("root", rootMessageId, debugLines);
		if (!resolvedThreadMid) throw new Error("スレッドMIDを取得できませんでした");
		this.pendingThreadRoot = true;
		return resolvedThreadMid;
	}

	private async sendThreadRootNotice(): Promise<unknown> {
		return await lineApiQueue.run("square:send-thread-root", () =>
			this.client.base.square.sendMessage({
				squareChatMid: this.destination.chatMid,
				text: THREAD_OUTPUT_NOTICE,
			})
		, { scope: this.lineApiScope() });
	}

	private lineApiScope(): string {
		return `square:${this.destination.chatMid}`;
	}

	private async debugThreadMidFromMessage(
		label: string,
		messageId: string,
		debugLines?: string[],
	): Promise<string | undefined> {
		debugLines?.push(`getSquareThreadMid(${label}) request chatMid=${this.destination.chatMid} messageId=${messageId}`);
		try {
			const response = await this.client.base.square.getSquareThreadMid({
				request: {
					chatMid: this.destination.chatMid,
					messageId,
				},
			});
			debugLines?.push(`getSquareThreadMid(${label}) response threadMid=${response.threadMid}`);
			return response.threadMid;
		} catch (error) {
			debugLines?.push(`getSquareThreadMid(${label})=ERROR ${compactError(error)}`);
			return undefined;
		}
	}

	private async debugSquareThread(label: string, threadMid: string, debugLines: string[]): Promise<void> {
		debugLines.push(`getSquareThread(${label}) request threadMid=${threadMid}`);
		try {
			const response = await this.client.base.square.getSquareThread({
				request: {
					threadMid,
					includeRootMessage: true,
				},
			});
			debugLines.push(`getSquareThread(${label}) response ${squareThreadSummary(response)}`);
		} catch (error) {
			debugLines.push(`getSquareThread(${label})=ERROR ${compactError(error)}`);
		}
	}

	private async debugThreadEvents(label: string, threadMid: string, debugLines: string[]): Promise<void> {
		debugLines.push(`fetchSquareChatEvents(${label}) request chatMid=${this.destination.chatMid} threadMid=${threadMid}`);
		try {
			const response = await this.client.base.square.fetchSquareChatEvents({
				squareChatMid: this.destination.chatMid,
				threadMid,
				limit: 5,
			});
			const raw = rawObject(response);
			const events = Array.isArray(raw?.events) ? raw.events : [];
			debugLines.push(
				`fetchSquareChatEvents(${label}) response events=${events.length} syncToken=${rawString(raw?.syncToken) ?? "(none)"}`,
			);
			for (const event of events.slice(-3)) {
				const eventRaw = rawObject(event);
				const payload = rawObject(eventRaw?.payload);
				debugLines.push(
					`event(${label}) type=${String(eventRaw?.type ?? "(none)")} payload=${Object.keys(payload ?? {}).join(",") || "(none)"}`,
				);
			}
		} catch (error) {
			debugLines.push(`fetchSquareChatEvents(${label})=ERROR ${compactError(error)}`);
		}
	}

	private async joinThread(threadMid: string, debugLines?: string[]): Promise<void> {
		if (this.threadJoinAttempted) return;
		this.threadJoinAttempted = true;
		try {
			debugLines?.push(`joinSquareThread request chatMid=${this.destination.chatMid} threadMid=${threadMid}`);
			await this.client.base.square.joinSquareThread({
				request: {
					chatMid: this.destination.chatMid,
					threadMid,
				},
			});
			debugLines?.push("joinSquareThread=OK");
		} catch (error) {
			debugLines?.push(`joinSquareThread=ERROR ${compactError(error)}`);
			console.warn("[square] joinSquareThread failed; trying thread send anyway", error);
		}
	}
}

class RawTalkReplyTarget implements ReplyableLineMessage {
	readonly destination;
	readonly mentionMids: string[];
	readonly replyToMessageId?: string;

	constructor(
		readonly client: Client,
		private readonly raw: RawTalkMessage,
		private readonly ownMid: string,
		mentionMids: string[],
	) {
		this.mentionMids = mentionMids;
		this.replyToMessageId = raw.relatedMessageId &&
				(raw.messageRelationType === 3 || raw.messageRelationType === "REPLY")
			? raw.relatedMessageId
			: undefined;
		this.destination = {
			kind: "talk" as const,
			chatMid: this.sendTo(),
			scopeMid: this.sendTo(),
			chatType: this.chatType(),
			senderMid: raw.from,
			senderName: senderNames.get(`talk:${raw.from}`),
			encrypted: this.isEncrypted(),
		};
	}

	async reply(text: string): Promise<string | undefined> {
		return await this.sendTalk(text);
	}

	async send(text: string): Promise<string | undefined> {
		return await this.sendTalk(text);
	}

	async sendMention(text: string, mentions: OutgoingMention[]): Promise<string | undefined> {
		return await this.sendTalk(text, undefined, mentionMetadata(mentions));
	}

	async sendImage(image: OutgoingImage): Promise<void> {
		const to = this.sendTo();
		await lineApiQueue.run("talk:send-image", async () => {
			if (this.isEncrypted() && (to.startsWith("u") || to.startsWith("c"))) {
				await this.client.base.obs.uploadMediaByE2EE({
					to,
					oType: "image",
					data: image.blob,
					filename: image.filename,
				});
				return;
			}
			const sent = await this.client.base.talk.sendMessage({
				to,
				contentType: "IMAGE" as never,
			});
			if (!sent.id) throw new Error("画像メッセージIDを取得できませんでした");
			await this.client.base.obs.uploadObjTalk(to, "image", image.blob, sent.id, image.filename);
		}, { scope: this.lineApiScope() });
	}

	async deleteMessage(messageId: string): Promise<void> {
		await lineApiQueue.run(
			"talk:delete-message",
			() => this.client.base.talk.unsendMessage({ messageId }),
			{ scope: this.lineApiScope() },
		);
	}

	private sendTo(): string {
		if (
			this.raw.toType === "GROUP" ||
			this.raw.toType === "ROOM" ||
			this.raw.to.startsWith("c") ||
			this.raw.to.startsWith("r")
		) {
			return this.raw.to;
		}
		return this.raw.from === this.ownMid ? this.raw.to : this.raw.from;
	}

	private chatType(): "USER" | "GROUP" | "ROOM" {
		if (this.raw.toType === "GROUP" || this.raw.to.startsWith("c")) return "GROUP";
		if (this.raw.toType === "ROOM" || this.raw.to.startsWith("r")) return "ROOM";
		return "USER";
	}

	private async sendTalk(
		text: string,
		relatedMessageId?: string,
		contentMetadata?: Record<string, string>,
	): Promise<string | undefined> {
		const sent = await lineApiQueue.run(
			"talk:send-text",
			() => this.client.base.talk.sendMessage({
				to: this.sendTo(),
				text,
				relatedMessageId,
				contentMetadata,
				e2ee: this.isEncrypted(),
			}),
			{ scope: this.lineApiScope() },
		);
		return sent.id;
	}

	private lineApiScope(): string {
		return `talk:${this.sendTo()}`;
	}

	private isEncrypted(): boolean {
		return Boolean(this.raw.chunks || this.raw.contentMetadata?.e2eeVersion);
	}
}

function messageIdFromSquareSendResult(value: unknown): string | undefined {
	const result = value as {
		createdSquareMessage?: { message?: { id?: string } };
		createdThreadMessage?: { message?: { id?: string } };
		squareMessage?: { message?: { id?: string } };
		message?: { id?: string };
		id?: string;
	};
	return result.createdSquareMessage?.message?.id ??
		result.createdThreadMessage?.message?.id ??
		result.squareMessage?.message?.id ??
		result.message?.id ??
		result.id;
}

function squareThreadSummary(value: unknown): string {
	const raw = rawObject(value);
	const thread = rawObject(raw?.squareThread) ?? rawObject(raw?.thread);
	const rootSquareMessage = rawObject(raw?.threadRootMessage) ??
		rawObject(raw?.rootMessage) ??
		rawObject(raw?.squareMessage);
	const rootMessage = rawObject(rootSquareMessage?.message) ?? rawObject(raw?.message);
	const parts = [
		`keys=${raw ? Object.keys(raw).join(",") || "(none)" : "(none)"}`,
		`threadMid=${rawString(thread?.threadMid) ?? "(none)"}`,
		`chatMid=${rawString(thread?.chatMid) ?? "(none)"}`,
		`squareMid=${rawString(thread?.squareMid) ?? "(none)"}`,
		`rootMessageId=${rawString(thread?.messageId) ?? rawString(rootMessage?.id) ?? "(none)"}`,
		`state=${thread?.state === undefined ? "(none)" : String(thread.state)}`,
		`expiresAt=${thread?.expiresAt === undefined ? "(none)" : String(thread.expiresAt)}`,
		`readOnlyAt=${thread?.readOnlyAt === undefined ? "(none)" : String(thread.readOnlyAt)}`,
	];
	const rootText = rawString(rootMessage?.text);
	if (rootText) parts.push(`rootText=${rootText.length > 40 ? `${rootText.slice(0, 39)}...` : rootText}`);
	return parts.join(" ");
}

function talkMentionMids(raw: RawTalkMessage): string[] {
	const value = raw.contentMetadata?.MENTION;
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as {
			MENTIONEES?: Array<{ M?: unknown }>;
		};
		return [...new Set(
			(parsed.MENTIONEES ?? []).flatMap((mention) =>
				typeof mention.M === "string" ? [mention.M] : []
			),
		)];
	} catch {
		return [];
	}
}

async function readTalkText(client: Client, raw: RawTalkMessage): Promise<ParsedTalkText | null> {
	if (typeof raw.text === "string") {
		return { text: raw.text, mentionMids: talkMentionMids(raw) };
	}
	if (!raw.chunks && !raw.contentMetadata?.e2eeVersion) return null;

	try {
		const decrypted = await client.base.e2ee.decryptE2EEMessage(raw as never) as RawTalkMessage;
		if (typeof decrypted.text === "string") {
			return { text: decrypted.text, mentionMids: talkMentionMids(decrypted) };
		}
	} catch (error) {
		if (!warnedEncryptedTalk) {
			warnedEncryptedTalk = true;
			console.warn(
				"[talk:message] encrypted Talk message received, but E2EE keys are not available or decryption failed. " +
					"Run an E2EE-capable login to save keys before Talk commands can be read.",
			);
			console.warn(error);
		}
	}
	return null;
}

async function handleRawTalkEvent(client: Client, ownMid: string, event: RawTalkEvent): Promise<void> {
	if (event.type !== "SEND_MESSAGE" && event.type !== "RECEIVE_MESSAGE") {
		console.log(`[talk:event] ${event.type}`);
		return;
	}

	const raw = event.message;
	if (!raw) return;
	if (raw.from === ownMid) return;

	const parsed = await readTalkText(client, raw);
	if (parsed === null) return;
	const target = new RawTalkReplyTarget(client, raw, ownMid, parsed.mentionMids);
	recordTalkMessage(raw, target.destination, parsed);
	if (shouldIgnoreStoppedText(parsed.text, target)) return;
	if (!parsed.text.startsWith(appConfig.commandPrefix)) {
		if (await handleLogTargetSelectionReply(parsed.text, target)) return;
		await handleSearchPageReply(parsed.text, target);
		return;
	}
	const createdAt = Number(raw.createdTime);
	if (Number.isFinite(createdAt) && createdAt > 1_500_000_000_000) {
		const receiveLagMs = Math.max(0, Date.now() - createdAt);
		if (receiveLagMs >= 1_000 || parsed.text === `${appConfig.commandPrefix}ping`) {
			console.log(`[perf] talk receiveLag=${receiveLagMs}ms`);
		}
	}
	await dispatchText(
		"talk",
		parsed.text,
		target,
	);
	void resolveSenderName(client, "talk", raw.from)
		.then((name) => {
			if (name) rankingStore.updateName("talk", raw.from, name);
			if (name) memberNameHistoryStore.record("talk", target.destination.scopeMid, raw.from, name);
			if (name) {
				messageLogStore.recordMember({
					kind: "talk",
					chatMid: target.destination.chatMid,
					scopeMid: target.destination.scopeMid,
					chatType: target.destination.chatType,
					mid: raw.from,
					name,
					state: "JOINED",
					source: "liveNameResolve",
				});
				recordTalkMessage(raw, { ...target.destination, senderName: name }, parsed);
			}
		})
		.catch((error) => {
			console.warn("[ranking] talk name post-processing failed", compactLineError(error));
		});
}

function recordTalkMessage(
	raw: RawTalkMessage,
	destination: RawTalkReplyTarget["destination"],
	parsed?: ParsedTalkText,
): void {
	if (!raw.id || !raw.from) return;
	const createdAt = Number(raw.createdTime);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return;
	const record: StoredMessageLog = {
		id: raw.id,
		kind: "talk",
		chatMid: destination.chatMid,
		scopeMid: destination.scopeMid,
		chatType: destination.chatType,
		senderMid: raw.from,
		senderName: destination.senderName,
		createdAt,
		content: messageContent(parsed?.text ?? raw.text, undefined, false),
		metadata: {
			source: "live-talk",
			to: raw.to,
			toType: raw.toType,
			chunks: raw.chunks,
			contentMetadata: raw.contentMetadata,
			relatedMessageId: raw.relatedMessageId,
			messageRelationType: raw.messageRelationType,
			mentionMids: parsed?.mentionMids,
		},
	};
	messageLogStore.record(record);
}

type ReceiverChannel = "talk" | "square";
type AuthenticationErrorReporter = (channel: ReceiverChannel, error: unknown) => void;

function handleReceiverPollingError(
	channel: ReceiverChannel,
	error: unknown,
	onAuthenticationError: AuthenticationErrorReporter,
): void {
	if (isAuthenticationError(error)) {
		onAuthenticationError(channel, error);
		return;
	}
	console.error(`[${channel}:event] polling error`, error);
}

function handleEventProcessingError(
	channel: ReceiverChannel,
	context: string,
	error: unknown,
): void {
	// 権限不足など個別イベントの失敗でLINEセッション全体を巻き込まない。
	console.error(`[${channel}:event] ${context} failed`, error);
}

function isTimeoutError(error: unknown): boolean {
	const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /timeout|timed out|aborted due to timeout/i.test(detail);
}

function isTalkSyncGoneError(error: unknown): boolean {
	return /status=410\b/i.test(compactError(error));
}

async function listenRawTalkSyncEvents(
	client: Client,
	ownMid: string,
	signal: AbortSignal,
	onAuthenticationError: AuthenticationErrorReporter,
	protocol: "sync3" | "sync4",
): Promise<void> {
	const storedCursor = client.base.poll.sync.talk;
	const cursor: TalkSyncCursor = {
		revision: storedCursor.revision ?? 0,
		globalRev: storedCursor.globalRev ?? 0,
		individualRev: storedCursor.individualRev ?? 0,
	};
	let immediateGoneCount = 0;
	console.log(`[talk:event] ${protocol.toUpperCase()} receiver started`, {
		persistedCursor: cursor.revision !== 0,
		timeoutMs: appConfig.talkPollTimeoutMs,
	});
	while (!signal.aborted) {
		const pollStartedAt = Date.now();
		try {
			const response = protocol === "sync3"
				? await requestTalkSyncV3<RawTalkEvent>(
					client.base,
					cursor,
					appConfig.talkPollTimeoutMs,
				)
				: await client.base.talk.sync({
					revision: cursor.revision,
					globalRev: cursor.globalRev,
					individualRev: cursor.individualRev,
					limit: 100,
					timeout: appConfig.talkPollTimeoutMs,
				}) as TalkSyncResponse<RawTalkEvent>;
			const operations = applyTalkSyncResponse(cursor, response);
			storedCursor.revision = cursor.revision;
			storedCursor.globalRev = cursor.globalRev;
			storedCursor.individualRev = cursor.individualRev;
			immediateGoneCount = 0;
			lineHealth.markSuccess("talk", operations.length);
			if (operations.length > 0) {
				console.log(
					`[perf] talk ${protocol} poll=${Date.now() - pollStartedAt}ms events=${operations.length}`,
				);
			}
			for (const event of operations) {
				void handleRawTalkEvent(client, ownMid, event)
					.catch((error) => handleEventProcessingError("talk", "message handler", error));
			}
		} catch (error) {
			if (!signal.aborted && isTimeoutError(error)) {
				// Talk syncは新着がない場合も待機期限で終了する。受信障害として数えない。
				lineHealth.markHeartbeat("talk", Date.now(), true);
				await sleepUntilRetry(appConfig.talkPollIntervalMs, signal);
				continue;
			}
			if (!signal.aborted && isTalkSyncGoneError(error)) {
				const elapsedMs = Date.now() - pollStartedAt;
				const disposition = classifyTalkSyncGone(
					elapsedMs,
					appConfig.talkPollTimeoutMs,
					appConfig.talkPollGoneLeaseMs,
				);
				if (disposition === "stalled") {
					const leaseError = new Error(
						`Talk sync exceeded its poll lease: elapsed=${elapsedMs}ms timeout=${appConfig.talkPollTimeoutMs}ms`,
						{ cause: error },
					);
					lineHealth.markError("talk", leaseError);
					console.error("[talk:event] sync exceeded poll lease; restarting receiver", {
						elapsedMs,
						timeoutMs: appConfig.talkPollTimeoutMs,
						leaseMs: appConfig.talkPollGoneLeaseMs,
					});
					throw leaseError;
				}
				if (disposition === "poll-expired") {
					immediateGoneCount = 0;
					lineHealth.markHeartbeat("talk", Date.now(), true);
					await sleepUntilRetry(appConfig.talkPollIntervalMs, signal);
					continue;
				}
				immediateGoneCount += 1;
				console.warn(`[talk:event] ${protocol} cursor was rejected with an immediate HTTP 410`, {
					elapsedMs,
					consecutive: immediateGoneCount,
				});
				if (immediateGoneCount >= 3) {
					console.warn("[talk:event] repeated immediate HTTP 410; resetting revisions");
					cursor.revision = 0;
					cursor.globalRev = 0;
					cursor.individualRev = 0;
					storedCursor.revision = 0;
					storedCursor.globalRev = 0;
					storedCursor.individualRev = 0;
					immediateGoneCount = 0;
				}
				lineHealth.markHeartbeat("talk", Date.now(), true);
				await sleepUntilRetry(1_000, signal);
				continue;
			}
			lineHealth.markError("talk", error);
			if (!signal.aborted) {
				handleReceiverPollingError("talk", error, onAuthenticationError);
			}
		}
		await sleepUntilRetry(appConfig.talkPollIntervalMs, signal);
	}
}

async function listenRawTalkPushEvents(
	client: Client,
	ownMid: string,
	signal: AbortSignal,
	onAuthenticationError: AuthenticationErrorReporter,
): Promise<void> {
	try {
		await listenTalkPushEvents({
			push: client.base.push as unknown as TalkPushTransport<RawTalkEvent>,
			signal,
			staleMs: appConfig.talkPushStaleMs,
			onHeartbeat(eventCount) {
				if (eventCount > 0) {
					lineHealth.markSuccess("talk", eventCount);
					return;
				}
				lineHealth.markHeartbeat("talk", Date.now(), true);
			},
			onEvent(event) {
				void handleRawTalkEvent(client, ownMid, event as RawTalkEvent)
					.catch((error) => handleEventProcessingError("talk", "message handler", error));
			},
		});
	} catch (error) {
		if (signal.aborted) return;
		lineHealth.markError("talk", error);
		if (isAuthenticationError(error)) {
			onAuthenticationError("talk", error);
		}
		throw error;
	}
}

async function listenRawTalkEvents(
	client: Client,
	ownMid: string,
	signal: AbortSignal,
	onAuthenticationError: AuthenticationErrorReporter,
): Promise<void> {
	if (appConfig.talkReceiverMode === "sync3" || appConfig.talkReceiverMode === "sync4") {
		await listenRawTalkSyncEvents(
			client,
			ownMid,
			signal,
			onAuthenticationError,
			appConfig.talkReceiverMode,
		);
		return;
	}
	await listenRawTalkPushEvents(client, ownMid, signal, onAuthenticationError);
}

async function handleRawSquareEvent(
	client: Client,
	event: RawSquareEvent,
	sessionStartedAt: number,
): Promise<void> {
	const memberEvents = await memberActivityEventsFromSquareEvent(client, event);
	const memberEventContext = memberEvents.joins[0] ?? memberEvents.leaves[0];
	void memberEventLogStore.recordHistoryEvents([event], {
		chatMid: memberEventContext?.squareChatMid ?? memberEventContext?.squareMid,
		scopeMid: memberEventContext?.squareMid,
	}).catch((error) => {
		handleEventProcessingError("square", "member event log", error);
	});
	for (const joinEvent of memberEvents.joins) {
		try {
			await handleOpenChatMemberJoin(joinEvent);
		} catch (error) {
			handleEventProcessingError("square", "member join handler", error);
		}
		if (
			joinEvent.squareChatMid &&
			ocModerationSettingsStore.joinMessage(joinEvent.squareChatMid) &&
			!permissionStore.isBotStopped(botStopTargetFromDestination({
				kind: "square",
				chatMid: joinEvent.squareChatMid,
				scopeMid: joinEvent.squareMid,
				chatType: "SQUARE",
				senderMid: joinEvent.memberMid,
				senderName: joinEvent.displayName,
				encrypted: false,
			}))
		) {
			void handleOpenChatJoinEventMessage(joinEvent, { ignoreBefore: sessionStartedAt })
				.catch((error) => handleEventProcessingError("square", "join message handler", error));
		}
	}
	for (const leaveEvent of memberEvents.leaves) {
		try {
			await handleOpenChatMemberLeave(leaveEvent);
		} catch (error) {
			handleEventProcessingError("square", "member leave handler", error);
		}
		if (
			leaveEvent.squareChatMid &&
			ocModerationSettingsStore.leaveMessage(leaveEvent.squareChatMid) &&
			!permissionStore.isBotStopped(botStopTargetFromDestination({
				kind: "square",
				chatMid: leaveEvent.squareChatMid,
				scopeMid: leaveEvent.squareMid,
				chatType: "SQUARE",
				senderMid: leaveEvent.memberMid,
				senderName: leaveEvent.displayName,
				encrypted: false,
			}))
		) {
			void handleOpenChatLeaveEventMessage(leaveEvent, { ignoreBefore: sessionStartedAt })
				.catch((error) => handleEventProcessingError("square", "leave message handler", error));
		}
	}
	const postModerationEvent = postModerationEventFromSquareEvent(client, event);
	if (postModerationEvent) {
		void handleOpenChatPostModeration(postModerationEvent)
			.catch((error) => handleEventProcessingError("square", "post moderation handler", error));
	}
	const noteStatusModerationEvent = noteStatusModerationEventFromSquareEvent(client, event);
	if (noteStatusModerationEvent) {
		void handleOpenChatNoteStatusModeration(noteStatusModerationEvent)
			.catch((error) => handleEventProcessingError("square", "note moderation handler", error));
	}
	for (const eventMessage of squareMessagesFromEvent(event)) {
		void handleSquareMessage(client, new SquareMessage({
			client,
			raw: eventMessage.raw as never,
		}), eventMessage.threadMid, eventMessage.chatMid)
			.catch((error) => handleEventProcessingError("square", "message handler", error));
	}
}

async function restoreReplayedSquareMemberActivity(
	client: Client,
	event: RawSquareEvent,
): Promise<number> {
	const memberEvents = await memberActivityEventsFromSquareEvent(client, event);
	const memberEventContext = memberEvents.joins[0] ?? memberEvents.leaves[0];
	void memberEventLogStore.recordHistoryEvents([event], {
		chatMid: memberEventContext?.squareChatMid ?? memberEventContext?.squareMid,
		scopeMid: memberEventContext?.squareMid,
	}).catch((error) => {
		handleEventProcessingError("square", "replayed member event log", error);
	});
	for (const joinEvent of memberEvents.joins) {
		try {
			await handleOpenChatMemberJoin(joinEvent, { suppressActions: true });
		} catch (error) {
			handleEventProcessingError("square", "replayed member join restore", error);
		}
	}
	for (const leaveEvent of memberEvents.leaves) {
		try {
			await handleOpenChatMemberLeave(leaveEvent, { suppressActions: true });
		} catch (error) {
			handleEventProcessingError("square", "replayed member leave restore", error);
		}
	}
	return memberEvents.joins.length + memberEvents.leaves.length;
}

async function listenRawSquareEvents(
	client: Client,
	storage: SyncedLineStorage,
	signal: AbortSignal,
	onAuthenticationError: AuthenticationErrorReporter,
	sessionStartedAt: number,
): Promise<void> {
	let syncToken = await storage.getSquareSyncToken();
	let loadedPersistedToken = Boolean(syncToken);
	let continuationToken: string | undefined;
	console.log(`[square:event] persisted sync token ${syncToken ? "loaded" : "not found"}`);
	while (!signal.aborted) {
		try {
			const previousContinuationToken = continuationToken;
			const response = await client.base.square.fetchMyEvents({
				syncToken,
				continuationToken,
				limit: 100,
			});
			syncToken = response.syncToken || syncToken;
			continuationToken = response.continuationToken || undefined;
			loadedPersistedToken = false;
			const events = (response.events ?? []) as unknown as RawSquareEvent[];
			let replayedCount = 0;
			let restoredMemberEventCount = 0;
			for (const event of events) {
				try {
					recordSquareEventDebug(event);
					const createdAt = squareEventCreatedAt(event);
					if (createdAt !== undefined && createdAt < sessionStartedAt) {
						replayedCount++;
						restoredMemberEventCount += await restoreReplayedSquareMemberActivity(client, event);
						continue;
					}
					await handleRawSquareEvent(client, event, sessionStartedAt);
				} catch (error) {
					handleEventProcessingError("square", "event handler", error);
				}
			}
			if (replayedCount > 0) {
				console.log("[square:event] skipped replayed events", {
					count: replayedCount,
					total: events.length,
					continuation: Boolean(continuationToken),
					restoredMemberEvents: restoredMemberEventCount,
				});
			}
			if (
				continuationToken &&
				continuationToken === previousContinuationToken &&
				events.length === 0
			) {
				console.warn("[square:event] continuation token made no progress; resetting continuation");
				continuationToken = undefined;
			}
			if (!continuationToken && syncToken) storage.scheduleSquareSyncToken(syncToken);
			lineHealth.markSuccess("square", events.length);
		} catch (error) {
			lineHealth.markError("square", error);
			if (syncToken && /ILLEGAL_ARGUMENT|INVALID_ARGUMENT/i.test(compactError(error))) {
				console.warn("[square:event] sync token was rejected; restarting initial sync", {
					persistedOnStartup: loadedPersistedToken,
				});
				await storage.clearSquareSyncToken().catch((clearError) => {
					console.warn("[square:event] failed to clear rejected sync token", clearError);
				});
				syncToken = undefined;
				continuationToken = undefined;
				loadedPersistedToken = false;
				continue;
			}
			if (!signal.aborted) {
				handleReceiverPollingError("square", error, onAuthenticationError);
			}
			await sleepUntilRetry(1_000, signal);
			continue;
		}
		await sleepUntilRetry(continuationToken ? 25 : 1_000, signal);
	}
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function sleepUntilRetry(ms: number, signal: AbortSignal): Promise<void> {
	await Promise.race([sleep(ms), waitForAbort(signal)]);
}

async function runSession(
	client: Client,
	storage: SyncedLineStorage,
	shutdownSignal: AbortSignal,
): Promise<void> {
	const profile = await client.getMyProfile();
	console.log(`[line] logged in as ${profile.displayName} (${profile.mid})`);
	const sessionStartedAt = Date.now();
	const storedRefreshToken = await storage.get("refreshToken");
	const refreshTokenAvailable = typeof storedRefreshToken === "string" &&
		Boolean(storedRefreshToken.trim());
	lineHealth.startSession(sessionStartedAt, refreshTokenAvailable);
	console.log(`[line] refresh token: ${refreshTokenAvailable ? "available" : "not available"}`);
	void runtimeStore.startSession(sessionStartedAt).catch((error) => {
		console.warn("[runtime] session start save failed", error);
	});
	try {
		await client.base.e2ee.getE2EESelfKeyData(profile.mid);
		console.log("[line] E2EE self key is available");
	} catch {
		console.warn("[line] E2EE self key is not available; encrypted Talk messages cannot be read yet");
	}

	await storage.flushBackup().catch((error) => {
		console.warn("[line-storage] session-start backup failed; receivers will still start", error);
	});
	const controller = new AbortController();
	const relayShutdown = () => controller.abort();
	shutdownSignal.addEventListener("abort", relayShutdown, { once: true });
	let rejectSession!: (error: unknown) => void;
	let failed = false;
	let sessionStop: { source: string; error?: unknown } | undefined;
	const sessionFailure = new Promise<never>((_resolve, reject) => {
		rejectSession = reject;
	});
	const onFatal = (source: string, error: unknown) => {
		if (failed || controller.signal.aborted) return;
		failed = true;
		sessionStop = { source, error };
		controller.abort();
		const sessionError = new Error(`[${source}] ${compactError(error)}`);
		sessionError.name = "LineSessionRestartError";
		rejectSession(sessionError);
	};

	let authCheckRunning = false;
	let authFailureCount = 0;
	let authRetryTimer: NodeJS.Timeout | undefined;
	let lastAuthCheckAt = 0;
	let refreshAttemptedForFailure = false;
	let missingRefreshTokenLogged = false;
	const requestAuthenticationVerification = (
		trigger: string,
		triggerError?: unknown,
		force = false,
	): void => {
		if (controller.signal.aborted || authCheckRunning) return;
		const now = Date.now();
		if (!force && now - lastAuthCheckAt < appConfig.authFailureRetryMs) return;
		lastAuthCheckAt = now;
		authCheckRunning = true;
		if (triggerError !== undefined) {
			console.warn("[line] receiver reported a possible authentication error; verifying session", {
				trigger,
				error: compactError(triggerError),
			});
		}
		void (async () => {
			if (
				triggerError !== undefined &&
				isExpiredAuthenticationError(triggerError) &&
				!refreshAttemptedForFailure
			) {
				const refreshToken = await storage.get("refreshToken");
				if (typeof refreshToken === "string" && refreshToken) {
					refreshAttemptedForFailure = true;
					console.warn("[line] access token expired; attempting refresh token recovery", { trigger });
					try {
						await client.base.auth.tryRefreshToken();
						lineHealth.markTokenRefresh(true);
						console.log("[line] access token refresh succeeded");
					} catch (refreshError) {
						lineHealth.markTokenRefresh(false, refreshError);
						console.warn("[line] access token refresh failed", {
							error: compactError(refreshError),
						});
					}
				} else if (!missingRefreshTokenLogged) {
					missingRefreshTokenLogged = true;
					console.warn("[line] access token expired, but no refresh token is stored");
				}
			}
			try {
				await client.getMyProfile();
				if (authFailureCount > 0 || triggerError !== undefined) {
					console.log("[line] authentication verification succeeded; session restart was skipped", {
						trigger,
						previousFailures: authFailureCount,
					});
				}
				authFailureCount = 0;
				refreshAttemptedForFailure = false;
				missingRefreshTokenLogged = false;
			} catch (error) {
				if (!isAuthenticationError(error)) {
					authFailureCount = 0;
					console.warn("[line] authentication verification request failed without an auth error", {
						trigger,
						error: compactError(error),
					});
					return;
				}
				authFailureCount += 1;
				console.warn("[line] authentication verification failed", {
					trigger,
					failures: authFailureCount,
					threshold: appConfig.authFailureThreshold,
					error: compactError(error),
				});
				if (authFailureCount >= appConfig.authFailureThreshold) {
					onFatal("authentication-verification", error);
					return;
				}
				authRetryTimer = setTimeout(() => {
					authRetryTimer = undefined;
					requestAuthenticationVerification("authentication-retry", error, true);
				}, appConfig.authFailureRetryMs);
			}
		})()
			.catch((error) => {
				console.error("[line] authentication verification task crashed", error);
			})
			.finally(() => {
				authCheckRunning = false;
			});
	};
	const onAuthenticationError: AuthenticationErrorReporter = (channel, error) => {
		requestAuthenticationVerification(`${channel}-poll`, error);
	};

	const receiverSupervisors = new Map<ReceiverChannel | "member-message", ReceiverSupervisor>();
	const startReceiver = (
		channel: ReceiverChannel | "member-message",
		retryDelayMs: number,
		run: (signal: AbortSignal) => Promise<void>,
	): ReceiverSupervisor => {
		const supervisor = new ReceiverSupervisor({
			name: channel,
			parentSignal: controller.signal,
			retryDelayMs,
			run,
			onRestart(detail) {
				lineHealth.markRestart(channel, detail.reason);
				console.error(`[${channel}:event] receiver restarting locally`, {
					restartCount: detail.restartCount,
					requested: detail.requested,
					error: compactLineError(detail.reason),
				});
			},
		});
		receiverSupervisors.set(channel, supervisor);
		void supervisor.run().catch((error) => {
			// Supervisor自体の障害は記録するが、別受信系や認証セッションは巻き込まない。
			lineHealth.markError(channel, error);
			console.error(`[${channel}:event] supervisor crashed`, error);
		});
		return supervisor;
	};

	if (appConfig.enableTalk) {
		startReceiver(
			"talk",
			1_000,
			(signal) => listenRawTalkEvents(
				client,
				profile.mid,
				signal,
				onAuthenticationError,
			),
		);
	}
	if (appConfig.enableSquare) {
		startReceiver(
			"square",
			1_000,
			(signal) => listenRawSquareEvents(
				client,
				storage,
				signal,
				onAuthenticationError,
				sessionStartedAt,
			),
		);
		startReceiver(
			"member-message",
			appConfig.ocMemberMessageRetryMs,
			async (signal) => {
				lineHealth.markHeartbeat("member-message");
				await listenOpenChatJoinMessageEvents(client, storage, signal, sessionStartedAt);
			},
		);
	}

	console.log("[app] bot is listening");
	let eventLoopCheckedAt = Date.now();
	const eventLoopMonitor = setInterval(() => {
		const now = Date.now();
		const lagMs = Math.max(0, now - eventLoopCheckedAt - 10_000);
		runtimeWorkload.observeEventLoopLag(lagMs, now);
		if (lagMs >= 1_000) console.warn(`[perf] event-loop lag=${lagMs}ms`);
		eventLoopCheckedAt = now;
	}, 10_000);
	const staleWatchdogFailures: Record<ReceiverChannel, number> = {
		talk: 0,
		square: 0,
	};
	const watchdog = setInterval(() => {
		if (controller.signal.aborted) return;
		const channels: Array<{ channel: ReceiverChannel; enabled: boolean; staleMs: number }> = [
			{ channel: "talk", enabled: appConfig.enableTalk, staleMs: appConfig.talkPollStaleMs },
			{ channel: "square", enabled: appConfig.enableSquare, staleMs: appConfig.squarePollStaleMs },
		];
		for (const { channel, enabled, staleMs } of channels) {
			if (!enabled || !lineHealth.isStale(channel, staleMs)) {
				staleWatchdogFailures[channel] = 0;
				continue;
			}
			staleWatchdogFailures[channel] += 1;
			const error = new Error(`LINE event polling became stale: ${channel}`);
			console.warn("[line] event polling watchdog detected stale receiver", {
				channel,
				failures: staleWatchdogFailures[channel],
				threshold: appConfig.staleRestartThreshold,
				staleMs,
			});
			if (staleWatchdogFailures[channel] >= appConfig.staleRestartThreshold) {
				if (receiverSupervisors.get(channel)?.restart(error)) {
					staleWatchdogFailures[channel] = 0;
				}
			}
		}
	}, appConfig.authWatchdogMs);
	const runtimeCheckpoint = setInterval(() => {
		void runtimeStore.checkpoint().catch((error) => {
			console.warn("[runtime] checkpoint failed", error);
		});
	}, 5 * 60_000);
	let nameScanRunning = false;
	const nameScan = setInterval(() => {
		if (nameScanRunning || controller.signal.aborted) return;
		if (!runtimeWorkload.canRunBackground()) {
			console.log("[name-history] periodic scan deferred for foreground activity");
			return;
		}
		nameScanRunning = true;
		void runtimeWorkload.runBackground("member-name-scan", async () => {
			if (controller.signal.aborted) return;
			await memberNameHistoryStore.scanKnownSquareNames(client);
		})
			.catch((error) => {
				console.warn("[name-history] periodic scan failed", error);
			})
			.finally(() => {
				nameScanRunning = false;
			});
	}, appConfig.memberNameScanIntervalMs);

	try {
		await Promise.race([waitForAbort(shutdownSignal), sessionFailure]);
	} finally {
		clearInterval(watchdog);
		clearInterval(runtimeCheckpoint);
		clearInterval(nameScan);
		clearInterval(eventLoopMonitor);
		if (authRetryTimer) clearTimeout(authRetryTimer);
		controller.abort();
		const endedAt = Date.now();
		const finalStop = sessionStop ?? {
			source: shutdownSignal.aborted ? "shutdown" : "session-ended",
			error: undefined,
		};
		const finalReason = finalStop.error === undefined ? "正常終了" : compactError(finalStop.error);
		lineHealth.endSession(finalStop.source, finalStop.error, endedAt);
		shutdownSignal.removeEventListener("abort", relayShutdown);
		void runtimeStore.endSession({
			source: finalStop.source,
			reason: finalReason,
		}, endedAt).catch((error) => {
			console.warn("[runtime] session uptime save failed", error);
		});
	}
}

async function main(): Promise<void> {
	let activeClient: Client | null = null;
	const shutdownController = new AbortController();
	const eventUpdateServer = startEventUpdateServer(() => activeClient);
	const shutdown = () => {
		if (shutdownController.signal.aborted) return;
		console.log("[app] shutting down");
		shutdownController.abort();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	await runStartupStages([
		{
			name: "core",
			tasks: [
				{ name: "permissions", initialize: () => permissionStore.initialize() },
				{ name: "runtime", initialize: () => runtimeStore.initialize() },
				{ name: "oc-settings", initialize: () => ocModerationSettingsStore.initialize() },
				{ name: "oc-recent-presence", initialize: () => ocRecentPresenceStore.initialize() },
			],
		},
		{
			name: "moderation",
			tasks: [
				{ name: "oc-member-activity", initialize: () => ocMemberActivityStore.initialize() },
				{ name: "oc-moderation-cases", initialize: () => ocModerationCasesStore.initialize() },
				{ name: "oc-identity-snapshots", initialize: () => ocIdentitySnapshotsStore.initialize() },
				{ name: "oc-kick-history", initialize: () => ocKickHistoryStore.initialize() },
			],
		},
		{
			name: "notifications",
			tasks: [
				{ name: "push-subscriptions", initialize: () => pushSubscriptionStore.initialize() },
				{ name: "event-push", initialize: () => eventPushStore.initialize() },
				{ name: "push-reminders", initialize: () => pushReminderStore.initialize() },
			],
		},
		{
			name: "user-data",
			tasks: [
				{ name: "ranking", initialize: () => rankingStore.initialize() },
				{ name: "member-name-history", initialize: () => memberNameHistoryStore.initialize() },
			],
		},
		{
			name: "logs",
			tasks: [
				{ name: "message-log", initialize: () => messageLogStore.initialize() },
				{ name: "member-event-log", initialize: () => memberEventLogStore.initialize() },
			],
		},
	], {
		concurrency: 2,
		pauseMs: 250,
		signal: shutdownController.signal,
		onStage(name, state) {
			console.log(`[startup] ${name} ${state}`);
		},
	});
	startEventPushScheduler(() => activeClient, shutdownController.signal);
	startPushReminderScheduler(() => activeClient, shutdownController.signal);
	startMessageLogAutoHistoryScheduler(() => activeClient, shutdownController.signal);
	startMessageLogRemoteSyncScheduler(shutdownController.signal);
	startMemberEventLogRemoteSyncScheduler(shutdownController.signal);
	const storage = await initializeLineStorage();
	const loginRetryPolicy = new LoginRetryPolicy(
		appConfig.loginRetryMs,
		appConfig.loginRetryMaxMs,
		appConfig.loginInvalidCredentialRetryMs,
		appConfig.loginRestrictedRetryMs,
		appConfig.loginRateLimitRetryMs,
	);
	const sessionManager = new SessionManager<Client>({
		signal: shutdownController.signal,
		retryPolicy: loginRetryPolicy,
		stableResetMs: appConfig.sessionStableResetMs,
		create: () => createLineClient(storage),
		run: (client, signal) => runSession(client, storage, signal),
		onActiveChange(client) {
			activeClient = client;
		},
		onRetry(retry) {
			console.error("[line] session stopped; automatic login will retry", {
				kind: retry.kind,
				attempt: retry.attempt,
				delayMs: retry.delayMs,
				error: retry.detail,
			});
		},
		beforeRetry: () => storage.flushBackup(),
	});
	await sessionManager.run();

	await storage.flushBackup().catch(() => {});
	await rankingStore.flush().catch(() => {});
	await runtimeStore.flush().catch(() => {});
	await permissionStore.flush().catch(() => {});
	await ocIdentitySnapshotsStore.flush().catch(() => {});
	await ocKickHistoryStore.flush().catch(() => {});
	await ocMemberActivityStore.flush().catch(() => {});
	await ocRecentPresenceStore.flush().catch(() => {});
	await ocModerationCasesStore.flush().catch(() => {});
	await ocModerationSettingsStore.flush().catch(() => {});
	await memberNameHistoryStore.flush().catch(() => {});
	await messageLogStore.flush().catch(() => {});
	await memberEventLogStore.flush().catch(() => {});
	await new Promise<void>((resolve) => eventUpdateServer.close(() => resolve()));
}

main().catch((error) => {
	console.error("[app] fatal error", error);
	process.exitCode = 1;
});
