import type { Client } from "@evex/linejs";
import { fetchCsvMap, fetchJson } from "../commands/shared.js";
import { appConfig } from "../config.js";
import {
	collectEventNotifications,
	formatEventDuration,
	type EventNotificationPhase,
	type SaleJson,
} from "./schedule.js";
import { eventPushStore, type EventPushSubscription } from "./store.js";

async function sendToTarget(
	client: Client,
	target: EventPushSubscription,
	text: string,
): Promise<void> {
	if (target.kind === "square") {
		await client.base.square.sendMessage({ squareChatMid: target.chatMid, text });
		return;
	}
	await client.base.talk.sendMessage({
		to: target.chatMid,
		text,
		e2ee: target.encrypted,
	});
}

function notificationKey(
	target: EventPushSubscription,
	notifyAt: Date,
	phase: EventNotificationPhase,
	eventId: number,
): string {
	return `${target.kind}:${target.chatMid}|${phase}|${notifyAt.getTime()}|${eventId}`;
}

function notificationLine(
	phase: EventNotificationPhase,
	eventId: number,
	name: string,
	durationMs: number,
): string {
	if (phase === "start-5m") return `${eventId} ${name}の開催5分前です`;
	if (phase === "end-10m") return `${eventId} ${name}の終了10分前です`;
	return `${eventId} ${name} <${formatEventDuration(durationMs)}>`;
}

export async function checkEventStarts(client: Client, now: Date): Promise<void> {
	const targets = eventPushStore.list();
	if (targets.length === 0) return;
	const [sale, names] = await Promise.all([
		fetchJson<SaleJson>("data/sale.json", 60_000),
		fetchCsvMap("data/sale_name.csv"),
	]);
	const notifications = collectEventNotifications(
		sale,
		new Date(now.getTime() - appConfig.eventPushLookbackMs),
		now,
	);

	const deliveredKeys: string[] = [];
	for (const target of targets) {
		const registeredAt = Date.parse(target.updatedAt) || now.getTime();
		for (const notification of notifications) {
			if (notification.notifyAt.getTime() < registeredAt) continue;
			const matchingEvents = notification.events.filter(({ eventId }) =>
				target.eventIds.includes(eventId) &&
				!eventPushStore.hasNotified(
					notificationKey(target, notification.notifyAt, notification.phase, eventId),
				)
			);
			if (matchingEvents.length === 0) continue;

			const text = matchingEvents.map(({ eventId, durationMs }) =>
				notificationLine(
					notification.phase,
					eventId,
					names.get(eventId) || "名称不明",
					durationMs,
				)
			).join("\n");
			try {
				await sendToTarget(client, target, text);
				for (const { eventId } of matchingEvents) {
					deliveredKeys.push(
					notificationKey(target, notification.notifyAt, notification.phase, eventId),
					);
				}
			} catch (error) {
				console.error(`[push:event] delivery failed for ${target.kind}:${target.chatMid}`, error);
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
