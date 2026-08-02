import type { Client } from "@evex/linejs";
import type { SyncedLineStorage } from "../storage/lineStorage.js";
import { lineHealth } from "../runtime/lineHealth.js";
import { ocPollingActivity, type OcPollingMode } from "../runtime/ocPollingPolicy.js";
import { ocProfileStatusManager } from "../runtime/ocProfileStatus.js";
import {
	isSquareChatAccessPaused,
	markSquareChatAccessible,
	pauseSquareChatAccess,
} from "../runtime/squareChatAccess.js";
import { resolveMainSquareChatMid } from "./ocMainChat.js";
import { ocMemberSignalDispatcher } from "./ocMemberSignals.js";
import { ocModerationSettingsStore, type OcMemberMessageSetting } from "./ocModerationSettings.js";
import {
	isSquareChatMembershipJoined,
	isSquareChatMembershipLeft,
} from "./squareMembership.js";

interface RawSquareEvent {
	createdTime?: number | bigint;
	type?: string | number;
	payload?: Record<string, unknown>;
}

interface ChatPollingState {
	syncToken?: string;
	ignoreBefore: number;
	retryAfter: number;
	nextPollAt: number;
	mode?: OcPollingMode;
	intervalMs?: number;
}

interface WatchedMemberMessageChat {
	squareMid: string;
	squareChatMid: string;
	updatedAt: string;
	featuresEnabled: boolean;
}

const ERROR_RETRY_MS = 30_000;
const WATCH_SETTINGS_REFRESH_MS = 60_000;
const LOOP_MAX_SLEEP_MS = 1_000;
const LOOP_MIN_SLEEP_MS = 100;

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
	const join = rawObject(event.payload?.notifiedJoinSquareChat);
	const member = rawObject(join?.joinedMember);
	const squareChatMid = rawString(join?.squareChatMid);
	const memberMid = rawString(member?.squareMemberMid);
	const squareMid = rawString(member?.squareMid) ?? setting.squareMid;
	const joinedAt = rawNumber(event.createdTime);
	const memberCreatedAt = rawNumber(member?.createdAt);
	if (squareChatMid !== setting.squareChatMid || !memberMid || joinedAt === undefined) {
		console.warn("[oc-member-message:chat-poll] failed to parse join event", {
			configuredChatMid: setting.squareChatMid,
			eventChatMid: squareChatMid,
			memberMid,
			joinedAt,
		});
		return;
	}
	console.log("[oc-left-soon] chat poll join forwarded", {
		squareMid,
		squareChatMid,
		memberMid,
		joinedAt,
		memberCreatedAt,
		replayed: joinedAt < ignoreBefore,
	});
	void ocMemberSignalDispatcher.publish({
		type: "join",
		origin: "chat-poll",
		ignoreBefore,
		event: {
			client,
			squareMid,
			squareChatMid,
			memberMid,
			displayName: rawString(member?.displayName),
			joinedAt,
			memberCreatedAt,
			source: "chat-member",
		},
	}).catch((error) => {
		console.error("[oc-member-message:chat-poll] join signal failed", { squareChatMid, memberMid, error });
	});
}

async function handleLeaveEvent(
	client: Client,
	setting: WatchedMemberMessageChat,
	event: RawSquareEvent,
	ignoreBefore: number,
): Promise<void> {
	if (!isLeaveEvent(event)) return;
	const leave = rawObject(event.payload?.notifiedLeaveSquareChat);
	const member = rawObject(leave?.squareMember);
	const squareChatMid = rawString(leave?.squareChatMid);
	const memberMid = rawString(leave?.squareMemberMid) ?? rawString(member?.squareMemberMid);
	const squareMid = rawString(member?.squareMid) ?? setting.squareMid;
	const leftAt = rawNumber(event.createdTime);
	const memberCreatedAt = rawNumber(member?.createdAt);
	if (squareChatMid !== setting.squareChatMid || !memberMid || leftAt === undefined) {
		console.warn("[oc-member-message:chat-poll] failed to parse leave event", {
			configuredChatMid: setting.squareChatMid,
			eventChatMid: squareChatMid,
			memberMid,
			leftAt,
		});
		return;
	}
	console.log("[oc-left-soon] chat poll leave forwarded", {
		squareMid,
		squareChatMid,
		memberMid,
		leftAt,
		memberCreatedAt,
		replayed: leftAt < ignoreBefore,
		leftSoonMonitoringEnabled: ocModerationSettingsStore.snapshot(squareMid).leftSoonMonitoringEnabled,
	});
	void ocMemberSignalDispatcher.publish({
		type: "leave",
		origin: "chat-poll",
		ignoreBefore,
		event: {
			client,
			squareMid,
			squareChatMid,
			memberMid,
			displayName: rawString(member?.displayName),
			leftAt,
			memberCreatedAt,
			source: "chat-member",
		},
	}).catch((error) => {
		console.error("[oc-member-message:chat-poll] leave signal failed", { squareChatMid, memberMid, error });
	});
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
	const memberCreatedAt = rawNumber(peer?.createdAt);
	if (squareChatMid !== setting.squareChatMid || !memberMid || eventAt === undefined) return;
	if (isSquareChatMembershipJoined(membershipState)) {
		void ocMemberSignalDispatcher.publish({
			type: "join",
			origin: "chat-poll",
			ignoreBefore,
			event: {
				client,
				squareMid,
				squareChatMid,
				memberMid,
				displayName: rawString(peer?.displayName),
				joinedAt: eventAt,
				memberCreatedAt,
				source: "chat-member",
			},
		}).catch((error) => {
			console.error("[oc-member-message:chat-poll] member update join signal failed", {
				squareChatMid,
				memberMid,
				error,
			});
		});
	}
	if (isSquareChatMembershipLeft(membershipState)) {
		void ocMemberSignalDispatcher.publish({
			type: "leave",
			origin: "chat-poll",
			ignoreBefore,
			event: {
				client,
				squareMid,
				squareChatMid,
				memberMid,
				displayName: rawString(peer?.displayName),
				leftAt: eventAt,
				memberCreatedAt,
				source: "chat-member",
			},
		}).catch((error) => {
			console.error("[oc-member-message:chat-poll] member update leave signal failed", {
				squareChatMid,
				memberMid,
				error,
			});
		});
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
		markSquareChatAccessible(client, setting.squareChatMid);
		lineHealth.markSuccess("member-message", events.length);
		for (const event of events) {
			await handleMemberMessageEvent(client, setting, event, state.ignoreBefore);
		}
		if (state.syncToken && state.syncToken !== previousSyncToken) {
			storage.scheduleSquareChatSyncToken(setting.squareChatMid, state.syncToken);
		}
	} catch (error) {
		lineHealth.markError("member-message", error);
		if (pauseSquareChatAccess(
			client,
			setting.squareChatMid,
			error,
			"oc-member-message:poll",
		)) {
			state.retryAfter = Date.now() + 6 * 60 * 60_000;
			return;
		}
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
	}
}

function mergeWatchedChats(settings: WatchedMemberMessageChat[]): WatchedMemberMessageChat[] {
	const byChatMid = new Map<string, WatchedMemberMessageChat>();
	for (const setting of settings) {
		const current = byChatMid.get(setting.squareChatMid);
		const currentAt = current ? Date.parse(current.updatedAt) : Number.NEGATIVE_INFINITY;
		const nextAt = Date.parse(setting.updatedAt);
		if (!current) {
			byChatMid.set(setting.squareChatMid, setting);
			continue;
		}
		if (Number.isFinite(nextAt) && nextAt > currentAt) {
			byChatMid.set(setting.squareChatMid, {
				...setting,
				featuresEnabled: current.featuresEnabled || setting.featuresEnabled,
			});
			continue;
		}
		current.featuresEnabled = current.featuresEnabled || setting.featuresEnabled;
	}
	return [...byChatMid.values()];
}

function configuredMemberMessageChats(): WatchedMemberMessageChat[] {
	const settings: OcMemberMessageSetting[] = [
		...ocModerationSettingsStore.joinMessageSettings(),
		...ocModerationSettingsStore.leaveMessageSettings(),
	];
	return mergeWatchedChats(
		settings.map((setting) => ({
			squareMid: setting.squareMid,
			squareChatMid: setting.squareChatMid,
			updatedAt: setting.updatedAt,
			featuresEnabled: true,
		})),
	);
}

async function confirmConfiguredChats(
	client: Client,
	settings: WatchedMemberMessageChat[],
): Promise<WatchedMemberMessageChat[]> {
	const joined: WatchedMemberMessageChat[] = [];
	for (const setting of settings) {
		if (isSquareChatAccessPaused(client, setting.squareChatMid)) continue;
		try {
			const response = await client.base.square.getSquareChat({
				squareChatMid: setting.squareChatMid,
			});
			if (response.squareChat.squareChatMid !== setting.squareChatMid) {
				throw new Error("getSquareChat returned a different squareChatMid");
			}
			markSquareChatAccessible(client, setting.squareChatMid);
			joined.push(setting);
		} catch (error) {
			const detail = compactError(error);
			if (pauseSquareChatAccess(
				client,
				setting.squareChatMid,
				error,
				"oc-member-message:confirm",
			)) {
				continue;
			}
			console.warn("[oc-member-message:chat-poll] configured chat confirmation failed; skipping this target", {
				squareChatMid: setting.squareChatMid,
				error: detail,
			});
		}
	}
	return joined;
}

function leftSoonSourceChatMids(
	setting: ReturnType<typeof ocModerationSettingsStore.snapshot>,
	configured: WatchedMemberMessageChat[],
): string[] {
	const mids = new Set<string>();
	if (setting.leftSoonSourceChatMid) mids.add(setting.leftSoonSourceChatMid);
	if (setting.modRoomChatMid) mids.add(setting.modRoomChatMid);
	for (const chat of configured) {
		if (chat.squareMid === setting.squareMid) mids.add(chat.squareChatMid);
	}
	return [...mids];
}

async function discoverModerationMonitoringChats(
	client: Client,
	configured: WatchedMemberMessageChat[],
): Promise<WatchedMemberMessageChat[]> {
	const monitoringSettings = ocModerationSettingsStore.memberPollingSettings();
	if (monitoringSettings.length === 0) return [];
	const found: WatchedMemberMessageChat[] = [];
	for (const setting of monitoringSettings) {
		const sourceChatMids = leftSoonSourceChatMids(setting, configured);
		let squareChatMid: string | undefined;
		for (const sourceChatMid of sourceChatMids) {
			squareChatMid = await resolveMainSquareChatMid(client, setting.squareMid, sourceChatMid);
			if (squareChatMid) break;
		}
		if (squareChatMid) {
			found.push({
				squareMid: setting.squareMid,
				squareChatMid,
				updatedAt: setting.updatedAt,
				featuresEnabled: setting.leftSoonMonitoringEnabled || Boolean(setting.modRoomChatMid),
			});
			continue;
		}
		if (
			sourceChatMids.length > 0 &&
			sourceChatMids.every((chatMid) => isSquareChatAccessPaused(client, chatMid))
		) {
			continue;
		}
		console.warn("[oc-member-message:chat-poll] left-soon main chat could not be resolved", {
			squareMid: setting.squareMid,
			sourceChatCount: sourceChatMids.length,
		});
	}
	return found;
}

async function resolveWatchedChats(client: Client): Promise<WatchedMemberMessageChat[]> {
	const configured = configuredMemberMessageChats();
	const confirmed = await confirmConfiguredChats(client, configured);
	const monitoring = await discoverModerationMonitoringChats(client, confirmed);
	const watched = mergeWatchedChats([...confirmed, ...monitoring]);
	console.log("[oc-member-message:chat-poll] watch targets refreshed", {
		configuredChatCount: configured.length,
		confirmedChatCount: confirmed.length,
		leftSoonMainChatCount: monitoring.length,
		watchedChatCount: watched.length,
	});
	return watched;
}

export async function listenOpenChatJoinMessageEvents(
	client: Client,
	storage: SyncedLineStorage,
	signal: AbortSignal,
	sessionStartedAt: number,
): Promise<void> {
	const states = new Map<string, ChatPollingState>();
	let settings = await resolveWatchedChats(client);
	let refreshAt = Date.now() + WATCH_SETTINGS_REFRESH_MS;
	while (!signal.aborted) {
		lineHealth.markHeartbeat("member-message");
		if (Date.now() >= refreshAt) {
			try {
				settings = await resolveWatchedChats(client);
			} catch (error) {
				console.warn("[oc-member-message:chat-poll] watch target refresh failed; keeping current targets", {
					error: compactError(error),
					watchedChatCount: settings.length,
				});
			}
			refreshAt = Date.now() + WATCH_SETTINGS_REFRESH_MS;
		}
		const activeChatMids = new Set(settings.map((setting) => setting.squareChatMid));
		for (const [squareChatMid] of states) {
			if (activeChatMids.has(squareChatMid)) continue;
			states.delete(squareChatMid);
			await storage.clearSquareChatSyncToken(squareChatMid).catch(() => {});
		}
		const energyBySquare = new Map<string, boolean>();
		for (const setting of settings) {
			const decision = ocPollingActivity.decision(setting.squareMid, setting.featuresEnabled);
			const current = energyBySquare.get(setting.squareMid);
			energyBySquare.set(
				setting.squareMid,
				current === undefined ? decision.energySaving : current && decision.energySaving,
			);
		}
		for (const [squareMid, energySaving] of energyBySquare) {
			ocProfileStatusManager.setEnergySaving(squareMid, energySaving);
		}
		for (const setting of settings) {
			let state = states.get(setting.squareChatMid);
			if (!state) {
				const updatedAt = Date.parse(setting.updatedAt);
				state = {
					syncToken: await storage.getSquareChatSyncToken(setting.squareChatMid),
					ignoreBefore: Math.max(sessionStartedAt, Number.isFinite(updatedAt) ? updatedAt : sessionStartedAt),
					retryAfter: 0,
					nextPollAt: 0,
				};
				states.set(setting.squareChatMid, state);
				console.log("[oc-member-message:chat-poll] watching", {
					squareChatMid: setting.squareChatMid,
					persistedSyncToken: Boolean(state.syncToken),
				});
			}
			const decision = ocPollingActivity.decision(
				setting.squareMid,
				setting.featuresEnabled,
			);
			if (state.mode !== decision.mode) {
				if (state.intervalMs === undefined || decision.intervalMs < state.intervalMs) {
					state.nextPollAt = 0;
				}
				console.log("[oc-member-message:chat-poll] mode changed", {
					squareMid: setting.squareMid,
					squareChatMid: setting.squareChatMid,
					mode: decision.mode,
					intervalMs: decision.intervalMs,
					recentMessageCount: decision.recentMessageCount,
				});
				state.mode = decision.mode;
				state.intervalMs = decision.intervalMs;
			}
			if (Date.now() >= state.nextPollAt) {
				await pollChat(client, storage, setting, state);
				state.nextPollAt = Date.now() + decision.intervalMs;
			}
			if (signal.aborted) break;
		}
		const now = Date.now();
		const nextDueAt = [...states.values()]
			.reduce((nearest, state) => Math.min(nearest, state.nextPollAt), now + LOOP_MAX_SLEEP_MS);
		const sleepMs = Math.max(
			LOOP_MIN_SLEEP_MS,
			Math.min(LOOP_MAX_SLEEP_MS, nextDueAt - now),
		);
		await wait(sleepMs, signal);
	}
}
