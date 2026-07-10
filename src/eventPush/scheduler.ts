import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { permissionStore } from "../permissions/store.js";
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

async function sendToTarget(
	client: Client,
	target: EventPushSubscription,
	text: string,
): Promise<"sent" | "stopped"> {
	if (permissionStore.isBotStopped(target)) return "stopped";
	if (target.kind === "square") {
		await client.base.square.sendMessage({ squareChatMid: target.chatMid, text });
		return "sent";
	}
	await client.base.talk.sendMessage({
		to: target.chatMid,
		text,
		e2ee: target.encrypted,
	});
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
				if (result === "stopped") continue;
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
				await sendSquareThreadWithRoot(client, target.chatMid, rootText, bodyText);
				deliveredKeys.push(key);
			} catch (error) {
				console.error(`[push:event:daily] delivery failed for ${target.kind}:${target.chatMid}`, error);
			}
		}
	}
	await eventPushStore.markNotified(deliveredKeys);
}

export function startEventPushScheduler(
	getClient: () => Client | null,
	signal: AbortSignal,
): void {
	let running = false;
	const run = async () => {
		if (running || signal.aborted) return;
		const client = getClient();
		if (!client) return;
		running = true;
		try {
			await checkEventStarts(client, new Date());
		} catch (error) {
			console.error("[push:event] scheduler check failed", error);
		} finally {
			running = false;
		}
	};

	const interval = setInterval(() => void run(), appConfig.eventPushIntervalMs);
	const initial = setTimeout(() => void run(), 5_000);
	signal.addEventListener("abort", () => {
		clearInterval(interval);
		clearTimeout(initial);
	}, { once: true });
	console.log(`[push:event] scheduler started (${appConfig.eventPushIntervalMs}ms, JST)`);
}
