import type { EventNotificationPhase } from "./schedule.js";
import type { EventPushSubscription } from "./store.js";

export function targetWantsNotification(
	target: EventPushSubscription,
	phase: EventNotificationPhase,
	eventId: number,
	minutesBeforeStart?: number,
): boolean {
	const individuallyRegistered = target.eventIds.includes(eventId);
	if (phase === "start") return target.allEvents || individuallyRegistered;
	if (phase === "end-10m") return individuallyRegistered;
	return individuallyRegistered &&
		target.advanceMinutesByEvent[String(eventId)] === minutesBeforeStart;
}
