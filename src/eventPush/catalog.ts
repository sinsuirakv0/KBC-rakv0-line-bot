import { fetchCsvMap, fetchJson } from "../commands/shared.js";
import {
	findNextEventOccurrence,
	formatEventSchedule,
	formatNextEventOccurrence,
} from "./format.js";
import { selectNotificationEventIds, type SaleEntry, type SaleJson } from "./schedule.js";

export interface EventCatalog {
	sale: SaleJson;
	names: Map<number, string>;
}

export interface EventDetails {
	eventId: number;
	name: string;
	entries: SaleEntry[];
}

export async function loadEventCatalog(): Promise<EventCatalog> {
	const [sale, names] = await Promise.all([
		fetchJson<SaleJson>("data/sale.json", 60_000),
		fetchCsvMap("data/sale_name.csv"),
	]);
	return { sale, names };
}

export function eventDetailsFromCatalog(catalog: EventCatalog, eventId: number): EventDetails {
	return {
		eventId,
		name: catalog.names.get(eventId) || "名称不明",
		entries: catalog.sale.data.filter((entry) =>
			selectNotificationEventIds(entry.stageIds).includes(eventId)
		),
	};
}

export function formatEventDetailsLines(
	details: EventDetails,
	now = new Date(),
): string[] {
	const next = findNextEventOccurrence(details.eventId, details.entries, now);
	return [
		`${details.eventId} ${details.name}`,
		"開催期間",
		...formatEventSchedule(details.entries),
		"次の開催",
		next ? formatNextEventOccurrence(next, now) : "予定なし",
	];
}
