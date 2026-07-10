import type { EventNotificationPhase } from "./schedule.js";
import type { EventPushSubscription } from "./store.js";
import { isMissionEventId } from "../search/eventIdClassification.js";

export function isAllEventsDisplayable(eventId: number): boolean {
	return !(eventId >= 14_000 && eventId <= 14_999) && !isMissionEventId(eventId);
}

export function targetWantsNotification(
	target: EventPushSubscription,
	phase: EventNotificationPhase,
	eventId: number,
	minutesBeforeStart?: number,
): boolean {
	const individuallyRegistered = target.eventIds.includes(eventId);
	if (phase === "start") return individuallyRegistered ||
		(target.allEvents && isAllEventsDisplayable(eventId));
	if (phase === "end-10m") return individuallyRegistered;
	return individuallyRegistered &&
		target.advanceMinutesByEvent[String(eventId)] === minutesBeforeStart;
}
