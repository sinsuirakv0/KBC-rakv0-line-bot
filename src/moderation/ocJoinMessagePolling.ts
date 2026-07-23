import type { Client } from "@evex/linejs";
import type { SyncedLineStorage } from "../storage/lineStorage.js";
import { permissionStore } from "../permissions/store.js";
import { handleOpenChatJoinEventMessage, handleOpenChatLeaveEventMessage } from "./ocJoinMessage.js";
import { ocModerationSettingsStore, type OcMemberMessageSetting } from "./ocModerationSettings.js";

interface RawSquareEvent {
	createdTime?: number | bigint;
	type?: string | number;
	payload?: Record<string, unknown>;
}

interface ChatPollingState {
	syncToken?: string;
	ignoreBefore: number;
	retryAfter: number;
}

interface WatchedMemberMessageChat {
	squareMid: string;
	squareChatMid: string;
	updatedAt: string;
}

const POLLING_INTERVAL_MS = 1_000;
const ERROR_RETRY_MS = 30_000;
const MAX_CATCH_UP_PAGES = 100;

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

function isJoinEvent(event: RawSquareEvent): boolean {
	return event.type === 2 || event.type === "NOTIFIED_JOIN_SQUARE_CHAT";
}

function isLeaveEvent(event: RawSquareEvent): boolean {
	return event.type === 4 || event.type === "NOTIFIED_LEAVE_SQUARE_CHAT";
}

function isChatMemberUpdateEvent(event: RawSquareEvent): boolean {
	return event.type === 14 || event.type === "NOTIFIED_UPDATE_SQUARE_CHAT_MEMBER";
}

function isJoinedState(value: unknown): boolean {
	return value === 1 || value === "JOINED";
}

function isLeftState(value: unknown): boolean {
	return value === 4 || value === "LEFT";
}

function compactError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

async function handleJoinEvent(
	client: Client,
	setting: WatchedMemberMessageChat,
	event: RawSquareEvent,
	ignoreBefore: number,
): Promise<void> {
	if (!isJoinEvent(event)) return;
	if (!ocModerationSettingsStore.joinMessage(setting.squareChatMid)) return;
	const join = rawObject(event.payload?.notifiedJoinSquareChat);
	const member = rawObject(join?.joinedMember);
	const squareChatMid = rawString(join?.squareChatMid);
	const memberMid = rawString(member?.squareMemberMid);
	const squareMid = rawString(member?.squareMid) ?? setting.squareMid;
	const joinedAt = rawNumber(event.createdTime);
	if (squareChatMid !== setting.squareChatMid || !memberMid) {
		console.warn("[oc-member-message:chat-poll] failed to parse join event", {
			configuredChatMid: setting.squareChatMid,
			eventChatMid: squareChatMid,
			memberMid,
		});
		return;
	}
	if (permissionStore.isBotStopped({ kind: "square", chatMid: squareChatMid, chatType: "SQUARE" })) return;
	await handleOpenChatJoinEventMessage({
		client,
		squareMid,
		squareChatMid,
		memberMid,
		displayName: rawString(member?.displayName),
		joinedAt,
		source: "chat-member",
	}, { ignoreBefore });
}

async function handleLeaveEvent(
	client: Client,
	setting: WatchedMemberMessageChat,
	event: RawSquareEvent,
	ignoreBefore: number,
): Promise<void> {
	if (!isLeaveEvent(event)) return;
	if (!ocModerationSettingsStore.leaveMessage(setting.squareChatMid)) return;
	const leave = rawObject(event.payload?.notifiedLeaveSquareChat);
	const member = rawObject(leave?.squareMember);
	const squareChatMid = rawString(leave?.squareChatMid);
	const memberMid = rawString(leave?.squareMemberMid) ?? rawString(member?.squareMemberMid);
	const squareMid = rawString(member?.squareMid) ?? setting.squareMid;
	const leftAt = rawNumber(event.createdTime);
	if (squareChatMid !== setting.squareChatMid || !memberMid) {
		console.warn("[oc-member-message:chat-poll] failed to parse leave event", {
			configuredChatMid: setting.squareChatMid,
			eventChatMid: squareChatMid,
			memberMid,
		});
		return;
	}
	if (permissionStore.isBotStopped({ kind: "square", chatMid: squareChatMid, chatType: "SQUARE" })) return;
	await handleOpenChatLeaveEventMessage({
		client,
		squareMid,
		squareChatMid,
		memberMid,
		displayName: rawString(member?.displayName),
		leftAt,
		source: "chat-member",
	}, { ignoreBefore });
}

async function handleChatMemberUpdateEvent(
	client: Client,
	setting: WatchedMemberMessageChat,
	event: RawSquareEvent,
	ignoreBefore: number,
): Promise<void> {
	if (!isChatMemberUpdateEvent(event)) return;
	const update = rawObject(event.payload?.notifiedUpdateSquareChatMember);
	const chatMember = rawObject(update?.squareChatMember);
	const peer = rawObject(update?.peerSquareMember);
	const squareChatMid = rawString(update?.squareChatMid) ?? rawString(chatMember?.squareChatMid);
	const memberMid = rawString(chatMember?.squareMemberMid) ?? rawString(peer?.squareMemberMid);
	const squareMid = rawString(peer?.squareMid) ?? setting.squareMid;
	const membershipState = chatMember?.membershipState;
	const eventAt = rawNumber(event.createdTime);
	if (squareChatMid !== setting.squareChatMid || !memberMid) return;
	if (permissionStore.isBotStopped({ kind: "square", chatMid: squareChatMid, chatType: "SQUARE" })) return;
	if (isJoinedState(membershipState) && ocModerationSettingsStore.joinMessage(setting.squareChatMid)) {
		await handleOpenChatJoinEventMessage({
			client,
			squareMid,
			squareChatMid,
			memberMid,
			displayName: rawString(peer?.displayName),
			joinedAt: eventAt,
			source: "chat-member",
		}, { ignoreBefore });
	}
	if (isLeftState(membershipState) && ocModerationSettingsStore.leaveMessage(setting.squareChatMid)) {
		await handleOpenChatLeaveEventMessage({
			client,
			squareMid,
			squareChatMid,
			memberMid,
			displayName: rawString(peer?.displayName),
			leftAt: eventAt,
			source: "chat-member",
		}, { ignoreBefore });
	}
}

async function handleMemberMessageEvent(
	client: Client,
	setting: WatchedMemberMessageChat,
	event: RawSquareEvent,
	ignoreBefore: number,
): Promise<void> {
	await handleJoinEvent(client, setting, event, ignoreBefore);
	await handleLeaveEvent(client, setting, event, ignoreBefore);
	await handleChatMemberUpdateEvent(client, setting, event, ignoreBefore);
}

async function pollChat(
	client: Client,
	storage: SyncedLineStorage,
	setting: WatchedMemberMessageChat,
	state: ChatPollingState,
): Promise<void> {
	if (Date.now() < state.retryAfter) return;
	for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
		const previousSyncToken = state.syncToken;
		try {
			const response = await client.base.square.fetchSquareChatEvents({
				squareChatMid: setting.squareChatMid,
				syncToken: state.syncToken,
				limit: 100,
				direction: "FORWARD",
				fetchType: "DEFAULT",
			} as never);
			state.syncToken = response.syncToken || state.syncToken;
			const events = (response.events ?? []) as unknown as RawSquareEvent[];
			for (const event of events) {
				await handleMemberMessageEvent(client, setting, event, state.ignoreBefore);
			}
			if (events.length === 0 || !state.syncToken || state.syncToken === previousSyncToken) {
				if (state.syncToken) storage.scheduleSquareChatSyncToken(setting.squareChatMid, state.syncToken);
				return;
			}
		} catch (error) {
			const detail = compactError(error);
			if (state.syncToken && /ILLEGAL_ARGUMENT|INVALID_ARGUMENT/i.test(detail)) {
				console.warn("[oc-member-message:chat-poll] saved sync token rejected", {
					squareChatMid: setting.squareChatMid,
				});
				state.syncToken = undefined;
				await storage.clearSquareChatSyncToken(setting.squareChatMid).catch(() => {});
			} else {
				console.warn("[oc-member-message:chat-poll] failed", {
					squareChatMid: setting.squareChatMid,
					error: detail,
				});
			}
			state.retryAfter = Date.now() + ERROR_RETRY_MS;
			return;
		}
	}
	console.warn("[oc-member-message:chat-poll] catch-up page limit reached", {
		squareChatMid: setting.squareChatMid,
	});
}

function mergeMemberMessageSettings(): WatchedMemberMessageChat[] {
	const byChatMid = new Map<string, WatchedMemberMessageChat>();
	const settings: OcMemberMessageSetting[] = [
		...ocModerationSettingsStore.joinMessageSettings(),
		...ocModerationSettingsStore.leaveMessageSettings(),
	];
	for (const setting of settings) {
		const current = byChatMid.get(setting.squareChatMid);
		const currentAt = current ? Date.parse(current.updatedAt) : Number.NEGATIVE_INFINITY;
		const nextAt = Date.parse(setting.updatedAt);
		if (!current || (Number.isFinite(nextAt) && nextAt > currentAt)) {
			byChatMid.set(setting.squareChatMid, {
				squareMid: setting.squareMid,
				squareChatMid: setting.squareChatMid,
				updatedAt: setting.updatedAt,
			});
		}
	}
	return [...byChatMid.values()];
}

export async function listenOpenChatJoinMessageEvents(
	client: Client,
	storage: SyncedLineStorage,
	signal: AbortSignal,
	sessionStartedAt: number,
): Promise<void> {
	const states = new Map<string, ChatPollingState>();
	while (!signal.aborted) {
		const settings = mergeMemberMessageSettings();
		const activeChatMids = new Set(settings.map((setting) => setting.squareChatMid));
		for (const [squareChatMid] of states) {
			if (activeChatMids.has(squareChatMid)) continue;
			states.delete(squareChatMid);
			await storage.clearSquareChatSyncToken(squareChatMid).catch(() => {});
		}
		for (const setting of settings) {
			let state = states.get(setting.squareChatMid);
			if (!state) {
				const updatedAt = Date.parse(setting.updatedAt);
				state = {
					syncToken: await storage.getSquareChatSyncToken(setting.squareChatMid),
					ignoreBefore: Math.max(sessionStartedAt, Number.isFinite(updatedAt) ? updatedAt : sessionStartedAt),
					retryAfter: 0,
				};
				states.set(setting.squareChatMid, state);
				console.log("[oc-member-message:chat-poll] watching", {
					squareChatMid: setting.squareChatMid,
					persistedSyncToken: Boolean(state.syncToken),
				});
			}
			await pollChat(client, storage, setting, state);
			if (signal.aborted) break;
		}
		await wait(POLLING_INTERVAL_MS, signal);
	}
}
