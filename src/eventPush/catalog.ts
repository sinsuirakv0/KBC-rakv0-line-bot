import { fetchCsvMap, fetchJson } from "../commands/shared.js";
import {
	findNextEventOccurrence,
	formatEventSchedule,
	formatNextEventOccurrence,
} from "./format.js";
import { fetchText } from "../commands/shared.js";
import {
	isEntryAvailableForVersion,
	selectNotificationEventIds,
	type SaleEntry,
	type SaleJson,
} from "./schedule.js";

const DEFAULT_VERSION_URL = "https://kbc-rakv0-event.vercel.app/setting/version";
const VERSION_CACHE_MS = 60_000;

let cachedVersion: { expiresAt: number; value: number } | undefined;
let pendingVersion: Promise<number> | undefined;

export interface EventCatalog {
	sale: SaleJson;
	names: Map<number, string>;
	currentVersion: number;
}

export interface EventDetails {
	eventId: number;
	name: string;
	entries: SaleEntry[];
}

function parseVersion(value: string): number | undefined {
	const match = value.trim().match(/^\d+$/);
	if (!match) return undefined;
	const version = Number.parseInt(match[0], 10);
	return Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

async function requestVersion(url: string): Promise<number | undefined> {
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) return undefined;
	return parseVersion(await response.text());
}

export async function loadCurrentEventVersion(): Promise<number> {
	if (cachedVersion && cachedVersion.expiresAt > Date.now()) return cachedVersion.value;
	if (!pendingVersion) {
		pendingVersion = (async () => {
			const versionUrl = process.env.KBC_EVENT_VERSION_URL || DEFAULT_VERSION_URL;
			const direct = await requestVersion(versionUrl).catch(() => undefined);
			const version = direct ?? parseVersion(await fetchText("setting/version", VERSION_CACHE_MS));
			if (!version) throw new Error("イベントバージョンを取得できませんでした");
			cachedVersion = { value: version, expiresAt: Date.now() + VERSION_CACHE_MS };
			return version;
		})().finally(() => {
			pendingVersion = undefined;
		});
	}
	return pendingVersion;
}

export async function loadEventCatalog(): Promise<EventCatalog> {
	const [sale, names, currentVersion] = await Promise.all([
		fetchJson<SaleJson>("data/sale.json", 60_000),
		fetchCsvMap("data/sale_name.csv"),
		loadCurrentEventVersion(),
	]);
	return {
		sale: {
			...sale,
			data: sale.data.filter((entry) => isEntryAvailableForVersion(entry, currentVersion)),
		},
		names,
		currentVersion,
	};
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
