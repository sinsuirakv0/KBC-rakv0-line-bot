import { SquareMessage, type Client } from "@evex/linejs";
import { appConfig } from "./config.js";
import { handleLineCommand } from "./commands/index.js";
import { handleOcSetupReply } from "./commands/oc.js";
import type { OutgoingImage, OutgoingMention, ReplyableLineMessage } from "./commands/shared.js";
import { handleSearchPageReply } from "./commands/searchPages.js";
import { handleLogTargetSelectionReply } from "./commands/log.js";
import { handlePing } from "./handlers/ping.js";
import { createLineClient, isAuthenticationError } from "./lineClient.js";
import { startEventPushScheduler } from "./eventPush/scheduler.js";
import { eventPushStore } from "./eventPush/store.js";
import { startPushReminderScheduler } from "./reminders/scheduler.js";
import { pushReminderStore } from "./reminders/store.js";
import { startEventUpdateServer } from "./server/eventUpdateServer.js";
import { initializeLineStorage, type SyncedLineStorage } from "./storage/lineStorage.js";
import { pushSubscriptionStore } from "./subscriptions/store.js";
import { rankingStore } from "./ranking/store.js";
import { runtimeStore } from "./runtime/store.js";
import { ocIdentitySnapshotsStore } from "./moderation/ocIdentitySnapshots.js";
import { ocKickHistoryStore } from "./moderation/ocKickHistory.js";
import { ocMemberActivityStore } from "./moderation/ocMemberActivity.js";
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
import { ocModerationSettingsStore } from "./moderation/ocModerationSettings.js";
import { botStopTargetFromDestination, permissionStore } from "./permissions/store.js";
import { memberNameHistoryStore } from "./nameHistory/store.js";
import { startMessageLogAutoHistoryScheduler } from "./messageLog/autoHistory.js";
import { messageLogStore, type StoredMessageLog } from "./messageLog/store.js";

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

interface RawTalkSyncResponse {
	fullSyncResponse?: {
		nextRevision?: number | bigint;
	};
	operationResponse?: {
		globalEvents?: { lastRevision?: number | bigint };
		individualEvents?: { lastRevision?: number | bigint };
		operations?: RawTalkEvent[];
	};
}

interface ParsedTalkText {
	text: string;
	mentionMids: string[];
}

interface RawSquareEvent {
	type: string | number;
	payload?: {
		notificationMessage?: {
			squareMessage: unknown;
		};
		receiveMessage?: {
			squareMessage: unknown;
		};
		sendMessage?: {
			squareMessage: unknown;
		};
		mutateMessage?: {
			squareMessage: unknown;
			threadMid?: string;
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
}

let warnedEncryptedTalk = false;
let activeHandlers = 0;
const senderNames = new Map<string, string>();
const senderNameRequests = new Map<string, Promise<string | undefined>>();
const squareScopeRequests = new Map<string, Promise<string>>();

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
		console.error(`[${channel}:message] handler failed`, error);
	} finally {
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= 1_000 || messageText === `${appConfig.commandPrefix}ping`) {
			const command = messageText.slice(appConfig.commandPrefix.length).trim().split(/\s+/, 1)[0] || "unknown";
			console.log(`[perf] ${channel} !${command} handler=${elapsedMs}ms concurrent=${activeHandlers}`);
		}
		activeHandlers -= 1;
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

function squareMessagesFromEvent(event: RawSquareEvent): unknown[] {
	const payload = event.payload;
	if (!payload) return [];
	const messages: unknown[] = [];
	if (isSquareEventType(event, "NOTIFICATION_MESSAGE", 29) && payload.notificationMessage?.squareMessage) {
		messages.push(payload.notificationMessage.squareMessage);
	}
	if (isSquareEventType(event, "RECEIVE_MESSAGE", 0) && payload.receiveMessage?.squareMessage) {
		messages.push(payload.receiveMessage.squareMessage);
	}
	if (isSquareEventType(event, "SEND_MESSAGE", 1) && payload.sendMessage?.squareMessage) {
		messages.push(payload.sendMessage.squareMessage);
	}
	if (
		isSquareEventType(event, "MUTATE_MESSAGE", 41) &&
		payload.mutateMessage?.squareMessage &&
		!payload.mutateMessage.threadMid
	) {
		messages.push(payload.mutateMessage.squareMessage);
	}
	return messages;
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

function rawMember(value: unknown): {
	memberMid?: string;
	squareMid?: string;
	displayName?: string;
	membershipState?: string | number;
} {
	const raw = rawObject(value);
	return {
		memberMid: rawString(raw?.squareMemberMid),
		squareMid: rawString(raw?.squareMid),
		displayName: rawString(raw?.displayName),
		membershipState: raw?.membershipState as string | number | undefined,
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
	membershipState?: string | number;
} {
	const raw = rawObject(value);
	return {
		memberMid: rawString(raw?.squareMemberMid),
		squareChatMid: rawString(raw?.squareChatMid),
		membershipState: raw?.membershipState as string | number | undefined,
	};
}

function isJoinedState(value: string | number | undefined): boolean {
	return value === 1 || value === "JOINED";
}

function isLeftState(value: string | number | undefined): boolean {
	return value === 4 || value === "LEFT";
}

async function memberActivityEventsFromSquareEvent(
	client: Client,
	event: RawSquareEvent,
): Promise<{ joins: OpenChatMemberJoinEvent[]; leaves: OpenChatMemberLeaveEvent[] }> {
	const payload = event.payload;
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
				joinedAt: rawNumber(raw?.joinedAt),
				source: "chat-member",
			});
		}
	}

	if (isSquareEventType(event, "NOTIFIED_JOIN_SQUARE_CHAT", 2)) {
		const raw = rawObject(payload.notifiedJoinSquareChat);
		const member = rawMember(raw?.joinedMember);
		const squareChatMid = rawString(raw?.squareChatMid);
		if (member.squareMid && squareChatMid && member.memberMid) {
			joins.push({
				client,
				squareMid: member.squareMid,
				squareChatMid,
				memberMid: member.memberMid,
				displayName: member.displayName,
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
		if (squareMid && squareChatMid && memberMid && isJoinedState(chatMember.membershipState)) {
			joins.push({
				client,
				squareMid,
				squareChatMid,
				memberMid,
				source: "chat-member",
			});
		}
		if (squareMid && squareChatMid && memberMid && isLeftState(chatMember.membershipState)) {
			leaves.push({
				client,
				squareMid,
				squareChatMid,
				memberMid,
				source: "chat-member",
			});
		}
	}

	if (isSquareEventType(event, "NOTIFIED_UPDATE_SQUARE_MEMBER", 11)) {
		const raw = rawObject(payload.notifiedUpdateSquareMember);
		const member = rawMember(raw?.squareMember);
		const squareMid = rawString(raw?.squareMid) ?? member.squareMid;
		const memberMid = rawString(raw?.squareMemberMid) ?? member.memberMid;
		if (squareMid && memberMid && isLeftState(member.membershipState)) {
			leaves.push({
				client,
				squareMid,
				memberMid,
				displayName: member.displayName,
				clearAllChats: false,
				source: "square-member",
			});
		}
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

async function handleSquareMessage(client: Client, message: SquareMessage): Promise<void> {
	if (await message.isMyMessage()) return;
	const scopeMid = await resolveSquareScope(client, message.to.id, message.from.id);
	const target = new SquareReplyTarget(
		client,
		message,
		scopeMid,
		senderNames.get(`square:${message.from.id}`),
	);
	recordSquareMessage(message, target.destination);
	const rawMessage = (message.raw as RawSquareMessage).message;
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
	if (typeof message.text !== "string") return;
	if (shouldIgnoreStoppedText(message.text, target)) return;
	if (!message.text.startsWith(appConfig.commandPrefix)) {
		if (await handleOcSetupReply(message.text, target)) return;
		if (await handleOpenChatModerationCaseReply(message.text, target)) return;
		if (await handleLogTargetSelectionReply(message.text, target)) return;
		await handleSearchPageReply(message.text, target);
		return;
	}
	await dispatchText("square", message.text, target);
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
					senderNames.set(`square:${senderMid}`, member.displayName);
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

function resolveSenderName(
	client: Client,
	kind: "talk" | "square",
	mid: string,
): Promise<string | undefined> {
	const key = `${kind}:${mid}`;
	const cached = senderNames.get(key);
	if (cached) return Promise.resolve(cached);
	let request = senderNameRequests.get(key);
	if (!request) {
		request = (kind === "square"
			? client.base.square.getSquareMember({ squareMemberMid: mid })
				.then((response) => response.squareMember.displayName)
			: client.getUser(mid).then((user) => user.raw.targetProfileDetail.profileName)
		).then((name) => {
			if (name) senderNames.set(key, name);
			return name || undefined;
		}).catch((error) => {
			console.warn(`[ranking] failed to resolve ${kind} name for ${mid}`, error);
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

	constructor(
		readonly client: Client,
		private readonly message: SquareMessage,
		scopeMid: string,
		senderName?: string,
	) {
		this.mentionMids = squareMentionMids(message);
		this.replyToMessageId = message.getReplyTarget()?.id;
		this.destination = {
			kind: "square" as const,
			chatMid: message.to.id,
			scopeMid,
			chatType: "SQUARE" as const,
			senderMid: message.from.id,
			senderName,
			encrypted: false,
		};
	}

	async reply(text: string): Promise<string | undefined> {
		return await this.send(text);
	}

	async send(text: string): Promise<string | undefined> {
		const sent = await this.client.base.square.sendMessage({
			squareChatMid: this.destination.chatMid,
			text,
		});
		return messageIdFromSquareSendResult(sent);
	}

	async sendMention(text: string, mentions: OutgoingMention[]): Promise<string | undefined> {
		const sent = await this.client.base.square.sendMessage({
			squareChatMid: this.destination.chatMid,
			text,
			contentMetadata: mentionMetadata(mentions),
		});
		return messageIdFromSquareSendResult(sent);
	}

	async sendImage(image: OutgoingImage): Promise<void> {
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
	}

	async deleteMessage(messageId: string): Promise<void> {
		try {
			await this.client.base.square.destroyMessage({
				squareChatMid: this.destination.chatMid,
				messageId,
			});
			return;
		} catch (destroyError) {
			try {
				await this.client.base.square.unsendMessage({
					squareChatMid: this.destination.chatMid,
					messageId,
				});
			} catch (unsendError) {
				console.warn("[square] progress message deletion failed", { destroyError, unsendError });
				throw unsendError;
			}
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
	}

	async deleteMessage(messageId: string): Promise<void> {
		await this.client.base.talk.unsendMessage({ messageId });
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
		const sent = await this.client.base.talk.sendMessage({
			to: this.sendTo(),
			text,
			relatedMessageId,
			contentMetadata,
			e2ee: this.isEncrypted(),
		});
		return sent.id;
	}

	private isEncrypted(): boolean {
		return Boolean(this.raw.chunks || this.raw.contentMetadata?.e2eeVersion);
	}
}

function messageIdFromSquareSendResult(value: unknown): string | undefined {
	const result = value as {
		createdSquareMessage?: { message?: { id?: string } };
		squareMessage?: { message?: { id?: string } };
		message?: { id?: string };
		id?: string;
	};
	return result.createdSquareMessage?.message?.id ??
		result.squareMessage?.message?.id ??
		result.message?.id ??
		result.id;
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

function handlePollingError(
	channel: "talk" | "square",
	error: unknown,
	onFatal: (error: unknown) => void,
): void {
	if (isAuthenticationError(error)) {
		onFatal(error);
		return;
	}
	console.error(`[${channel}:event] polling error`, error);
}

function isTimeoutError(error: unknown): boolean {
	const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /timeout|timed out|aborted due to timeout/i.test(detail);
}

async function listenRawTalkEvents(
	client: Client,
	ownMid: string,
	signal: AbortSignal,
	onFatal: (error: unknown) => void,
): Promise<void> {
	let revision: number | bigint = 0;
	let globalRev: number | bigint = 0;
	let individualRev: number | bigint = 0;
	// Keep the wait bounded: LINEJS defaults sync() to a 180-second long poll.
	while (!signal.aborted) {
		try {
			const pollStartedAt = Date.now();
			const response = await client.base.talk.sync({
				revision,
				globalRev,
				individualRev,
				limit: 100,
				timeout: appConfig.talkPollTimeoutMs,
			}) as RawTalkSyncResponse;
			const nextRevision = response.fullSyncResponse?.nextRevision;
			if (nextRevision !== undefined) revision = nextRevision;
			const nextGlobalRev = response.operationResponse?.globalEvents?.lastRevision;
			if (nextGlobalRev !== undefined) globalRev = nextGlobalRev;
			const nextIndividualRev = response.operationResponse?.individualEvents?.lastRevision;
			if (nextIndividualRev !== undefined) individualRev = nextIndividualRev;

			const operations = response.operationResponse?.operations ?? [];
			if (operations.length > 0) {
				console.log(`[perf] talk poll=${Date.now() - pollStartedAt}ms events=${operations.length}`);
			}
			for (const event of operations) {
				if (event.revision !== undefined) revision = event.revision;
				void handleRawTalkEvent(client, ownMid, event)
					.catch((error) => handlePollingError("talk", error, onFatal));
			}
		} catch (error) {
			if (!signal.aborted && !isTimeoutError(error)) {
				handlePollingError("talk", error, onFatal);
			}
		}
		await sleepUntilRetry(appConfig.talkPollIntervalMs, signal);
	}
}

async function listenRawSquareEvents(
	client: Client,
	signal: AbortSignal,
	onFatal: (error: unknown) => void,
): Promise<void> {
	const polling = client.base.createPolling();
	for await (const event of polling._listenSquareEvents({
		signal,
		pollingInterval: 1_000,
		onError: (error) => handlePollingError("square", error, onFatal),
	}) as AsyncIterable<RawSquareEvent>) {
		if (signal.aborted) break;
		const memberEvents = await memberActivityEventsFromSquareEvent(client, event);
		for (const joinEvent of memberEvents.joins) {
			void handleOpenChatMemberJoin(joinEvent)
				.catch((error) => handlePollingError("square", error, onFatal));
		}
		for (const leaveEvent of memberEvents.leaves) {
			void handleOpenChatMemberLeave(leaveEvent)
				.catch((error) => handlePollingError("square", error, onFatal));
		}
		const postModerationEvent = postModerationEventFromSquareEvent(client, event);
		if (postModerationEvent) {
			void handleOpenChatPostModeration(postModerationEvent)
				.catch((error) => handlePollingError("square", error, onFatal));
		}
		const noteStatusModerationEvent = noteStatusModerationEventFromSquareEvent(client, event);
		if (noteStatusModerationEvent) {
			void handleOpenChatNoteStatusModeration(noteStatusModerationEvent)
				.catch((error) => handlePollingError("square", error, onFatal));
		}
		for (const rawMessage of squareMessagesFromEvent(event)) {
			void handleSquareMessage(client, new SquareMessage({
				client,
				raw: rawMessage as never,
			})).catch((error) => handlePollingError("square", error, onFatal));
		}
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
	await runtimeStore.startSession();
	try {
		await client.base.e2ee.getE2EESelfKeyData(profile.mid);
		console.log("[line] E2EE self key is available");
	} catch {
		console.warn("[line] E2EE self key is not available; encrypted Talk messages cannot be read yet");
	}

	await storage.flushBackup();
	const controller = new AbortController();
	const relayShutdown = () => controller.abort();
	shutdownSignal.addEventListener("abort", relayShutdown, { once: true });
	let rejectSession!: (error: unknown) => void;
	let failed = false;
	const sessionFailure = new Promise<never>((_resolve, reject) => {
		rejectSession = reject;
	});
	const onFatal = (error: unknown) => {
		if (failed || controller.signal.aborted) return;
		failed = true;
		controller.abort();
		rejectSession(error);
	};

	if (appConfig.enableTalk) {
		void listenRawTalkEvents(client, profile.mid, controller.signal, onFatal)
			.catch(onFatal);
	}
	if (appConfig.enableSquare) {
		void listenRawSquareEvents(client, controller.signal, onFatal)
			.catch(onFatal);
	}

	console.log("[app] bot is listening");
	let eventLoopCheckedAt = Date.now();
	const eventLoopMonitor = setInterval(() => {
		const now = Date.now();
		const lagMs = Math.max(0, now - eventLoopCheckedAt - 10_000);
		if (lagMs >= 1_000) console.warn(`[perf] event-loop lag=${lagMs}ms`);
		eventLoopCheckedAt = now;
	}, 10_000);
	let watchdogRunning = false;
	const watchdog = setInterval(() => {
		if (watchdogRunning || controller.signal.aborted) return;
		watchdogRunning = true;
		void client.getMyProfile()
			.catch((error) => {
				if (isAuthenticationError(error)) onFatal(error);
				else console.warn("[line] authentication watchdog request failed", error);
			})
			.finally(() => {
				watchdogRunning = false;
			});
	}, appConfig.authWatchdogMs);
	const runtimeCheckpoint = setInterval(() => {
		void runtimeStore.checkpoint().catch((error) => {
			console.warn("[runtime] checkpoint failed", error);
		});
	}, 5 * 60_000);
	let nameScanRunning = false;
	const nameScan = setInterval(() => {
		if (nameScanRunning || controller.signal.aborted) return;
		nameScanRunning = true;
		void memberNameHistoryStore.scanKnownSquareNames(client)
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
		controller.abort();
		shutdownSignal.removeEventListener("abort", relayShutdown);
		await runtimeStore.endSession().catch((error) => {
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

	await Promise.all([
		pushSubscriptionStore.initialize(),
		eventPushStore.initialize(),
		pushReminderStore.initialize(),
		rankingStore.initialize(),
		runtimeStore.initialize(),
		permissionStore.initialize(),
		ocIdentitySnapshotsStore.initialize(),
		ocKickHistoryStore.initialize(),
		ocMemberActivityStore.initialize(),
		ocModerationCasesStore.initialize(),
		ocModerationSettingsStore.initialize(),
		memberNameHistoryStore.initialize(),
		messageLogStore.initialize(),
	]);
	startEventPushScheduler(() => activeClient, shutdownController.signal);
	startPushReminderScheduler(() => activeClient, shutdownController.signal);
	startMessageLogAutoHistoryScheduler(() => activeClient, shutdownController.signal);
	const storage = await initializeLineStorage();
	while (!shutdownController.signal.aborted) {
		try {
			const client = await createLineClient(storage);
			activeClient = client;
			await runSession(client, storage, shutdownController.signal);
		} catch (error) {
			activeClient = null;
			if (shutdownController.signal.aborted) break;
			console.error("[line] session stopped; automatic login will retry", error);
			await storage.flushBackup().catch(() => {});
			await sleepUntilRetry(appConfig.loginRetryMs, shutdownController.signal);
		} finally {
			activeClient = null;
		}
	}

	await storage.flushBackup().catch(() => {});
	await rankingStore.flush().catch(() => {});
	await runtimeStore.flush().catch(() => {});
	await permissionStore.flush().catch(() => {});
	await ocIdentitySnapshotsStore.flush().catch(() => {});
	await ocKickHistoryStore.flush().catch(() => {});
	await ocMemberActivityStore.flush().catch(() => {});
	await ocModerationCasesStore.flush().catch(() => {});
	await ocModerationSettingsStore.flush().catch(() => {});
	await memberNameHistoryStore.flush().catch(() => {});
	await messageLogStore.flush().catch(() => {});
	await new Promise<void>((resolve) => eventUpdateServer.close(() => resolve()));
}

main().catch((error) => {
	console.error("[app] fatal error", error);
	process.exitCode = 1;
});
