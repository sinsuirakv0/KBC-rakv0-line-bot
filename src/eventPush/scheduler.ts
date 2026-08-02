import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { permissionStore } from "../permissions/store.js";
import { lineApiQueue } from "../runtime/lineApiQueue.js";
import {
	isSquareChatAccessPaused,
	markSquareChatAccessible,
	pauseSquareChatAccess,
} from "../runtime/squareChatAccess.js";
import { loadEventCatalog } from "./catalog.js";
import {
	dailyDeliveryInWindow,
	dailyRootText,
	formatDailyScheduleBody,
} from "./daily.js";
import {
	collectEventNotifications,
	formatEventDuration,
	type EventNotificationPhase,
} from "./schedule.js";
import { targetWantsNotification } from "./policy.js";
import { sendSquareThreadWithRoot } from "./squareThread.js";
import { eventPushStore, type EventPushSubscription } from "./store.js";

const preparedSquareTargets = new WeakMap<Client, Map<string, Promise<void>>>();

async function prepareSquareTarget(client: Client, squareChatMid: string): Promise<void> {
	let targets = preparedSquareTargets.get(client);
	if (!targets) {
		targets = new Map();
		preparedSquareTargets.set(client, targets);
	}
	const current = targets.get(squareChatMid);
	if (current) return await current;

	const pending = client.base.square.getSquareChat({ squareChatMid })
		.then(() => {
			markSquareChatAccessible(client, squareChatMid);
		})
		.catch((error) => {
			targets?.delete(squareChatMid);
			throw error;
		});
	targets.set(squareChatMid, pending);
	await pending;
}

async function prepareSquareTargetBestEffort(client: Client, squareChatMid: string): Promise<boolean> {
	if (isSquareChatAccessPaused(client, squareChatMid)) return false;
	try {
		await prepareSquareTarget(client, squareChatMid);
		return true;
	} catch (error) {
		if (pauseSquareChatAccess(client, squareChatMid, error, "event-push:prepare")) {
			return false;
		}
		console.warn(`[push:event] square target preparation failed for ${squareChatMid}`, error);
		return true;
	}
}

async function sendToTarget(
	client: Client,
	target: EventPushSubscription,
	text: string,
): Promise<"sent" | "stopped" | "unavailable"> {
	if (permissionStore.isBotStopped(target)) return "stopped";
	if (target.kind === "square") {
		if (!await prepareSquareTargetBestEffort(client, target.chatMid)) return "unavailable";
		try {
			await lineApiQueue.run("event-push:square", () =>
				client.base.square.sendMessage({ squareChatMid: target.chatMid, text })
			);
			markSquareChatAccessible(client, target.chatMid);
		} catch (error) {
			if (pauseSquareChatAccess(client, target.chatMid, error, "event-push:send")) {
				return "unavailable";
			}
			throw error;
		}
		return "sent";
	}
	await lineApiQueue.run("event-push:talk", () =>
		client.base.talk.sendMessage({
			to: target.chatMid,
			text,
			e2ee: target.encrypted,
		})
	);
	return "sent";
}

function notificationKey(
	target: EventPushSubscription,
	notifyAt: Date,
	phase: EventNotificationPhase,
	eventId: number,
	minutesBeforeStart?: number,
): string {
	const phaseKey = phase === "before-start"
		? `${phase}:${minutesBeforeStart}`
		: phase;
	return `${target.kind}:${target.chatMid}|${phaseKey}|${notifyAt.getTime()}|${eventId}`;
}

function notificationLine(
	phase: EventNotificationPhase,
	eventId: number,
	name: string,
	durationMs: number,
	minutesBeforeStart?: number,
): string {
	if (phase === "before-start") return `${eventId} ${name}の開催${minutesBeforeStart}分前です`;
	if (phase === "end-10m") return `${eventId} ${name}の終了10分前です`;
	return `${eventId} ${name} <${formatEventDuration(durationMs)}>`;
}

export async function checkEventStarts(client: Client, now: Date): Promise<void> {
	const targets = eventPushStore.list();
	if (targets.length === 0) return;
	const { sale, names } = await loadEventCatalog();
	const beforeStartMinutes = targets.flatMap((target) =>
		Object.values(target.advanceMinutesByEvent)
	);
	const notifications = collectEventNotifications(
		sale,
		new Date(now.getTime() - appConfig.eventPushLookbackMs),
		now,
		beforeStartMinutes,
	);

	const deliveredKeys: string[] = [];
	for (const target of targets) {
		const registeredAt = Date.parse(target.updatedAt) || now.getTime();
		for (const notification of notifications) {
			if (notification.notifyAt.getTime() < registeredAt) continue;
			const matchingEvents = notification.events.filter(({ eventId }) =>
				targetWantsNotification(
					target,
					notification.phase,
					eventId,
					notification.minutesBeforeStart,
				) &&
				!eventPushStore.hasNotified(
					notificationKey(
						target,
						notification.notifyAt,
						notification.phase,
						eventId,
						notification.minutesBeforeStart,
					),
				)
			);
			if (matchingEvents.length === 0) continue;

			const text = matchingEvents.map(({ eventId, durationMs }) =>
				notificationLine(
					notification.phase,
					eventId,
					names.get(eventId) || "名称不明",
					durationMs,
					notification.minutesBeforeStart,
				)
			).join("\n");
			try {
				const result = await sendToTarget(client, target, text);
				if (result !== "sent") continue;
				for (const { eventId } of matchingEvents) {
					deliveredKeys.push(
						notificationKey(
							target,
							notification.notifyAt,
							notification.phase,
							eventId,
							notification.minutesBeforeStart,
						),
					);
				}
			} catch (error) {
				console.error(`[push:event] delivery failed for ${target.kind}:${target.chatMid}`, error);
			}
		}
	}

	const dailyDelivery = dailyDeliveryInWindow(now, appConfig.eventPushLookbackMs);
	if (dailyDelivery) {
		const rootText = dailyRootText(dailyDelivery.dayStart);
		const bodyText = formatDailyScheduleBody(sale, names, dailyDelivery.dayStart);
		for (const target of targets) {
			if (!target.daily || target.kind !== "square") continue;
			const registeredAt = Date.parse(target.updatedAt) || now.getTime();
			if (dailyDelivery.dueAt.getTime() < registeredAt) continue;
			const key = `${target.kind}:${target.chatMid}|daily|${dailyDelivery.dateKey}`;
			if (eventPushStore.hasNotified(key) || permissionStore.isBotStopped(target)) continue;
			try {
				if (!await prepareSquareTargetBestEffort(client, target.chatMid)) continue;
				await sendSquareThreadWithRoot(client, target.chatMid, rootText, bodyText);
				markSquareChatAccessible(client, target.chatMid);
				deliveredKeys.push(key);
			} catch (error) {
				if (pauseSquareChatAccess(client, target.chatMid, error, "event-push:daily")) {
					continue;
				}
				console.error(`[push:event:daily] delivery failed for ${target.kind}:${target.chatMid}`, error);
			}
		}
	}
	await eventPushStore.markNotified(deliveredKeys);
}

export interface EventPushSchedulerHandle {
	wake(): void;
}

export interface EventPushSchedulerOptions {
	intervalMs?: number;
	initialDelayMs?: number;
	check?: typeof checkEventStarts;
}

export function startEventPushScheduler(
	getClient: () => Client | null,
	signal: AbortSignal,
	options: EventPushSchedulerOptions = {},
): EventPushSchedulerHandle {
	let running = false;
	let rerunRequested = false;
	const intervalMs = options.intervalMs ?? appConfig.eventPushIntervalMs;
	const initialDelayMs = options.initialDelayMs ?? 5_000;
	const check = options.check ?? checkEventStarts;
	const run = async () => {
		if (signal.aborted) return;
		if (running) {
			rerunRequested = true;
			return;
		}
		const client = getClient();
		if (!client) return;
		running = true;
		try {
			await check(client, new Date());
		} catch (error) {
			console.error("[push:event] scheduler check failed", error);
		} finally {
			running = false;
			if (rerunRequested && !signal.aborted) {
				rerunRequested = false;
				queueMicrotask(() => void run());
			}
		}
	};

	const interval = setInterval(() => void run(), intervalMs);
	const initial = setTimeout(() => void run(), initialDelayMs);
	signal.addEventListener("abort", () => {
		clearInterval(interval);
		clearTimeout(initial);
	}, { once: true });
	console.log(`[push:event] scheduler started (${intervalMs}ms, JST)`);
	return {
		wake() {
			void run();
		},
	};
}
