import type { TimeBlock } from "../commands/shared.js";

const JST_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const IGNORED_STAGE_IDS = [102, 104, 112];

export interface SaleHeader {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
}

export interface SaleEntry {
	header: SaleHeader;
	timeBlocks: TimeBlock[];
	stageIds: number[];
}

export interface SaleJson {
	updatedAt: string;
	data: SaleEntry[];
}

export function isIgnoredEventEntry(entry: SaleEntry): boolean {
	return IGNORED_STAGE_IDS.some((id) => entry.stageIds.includes(id));
}

export interface EventOccurrence {
	startAt: Date;
	endAt: Date;
	eventIds: number[];
}

export type EventNotificationPhase = "start-5m" | "start" | "end-10m";

export interface EventNotification {
	notifyAt: Date;
	phase: EventNotificationPhase;
	events: Array<{
		eventId: number;
		durationMs: number;
	}>;
}

export function formatEventDuration(durationMs: number): string {
	let minutes = Math.max(0, Math.round(durationMs / 60_000));
	const days = Math.floor(minutes / (24 * 60));
	minutes -= days * 24 * 60;
	const hours = Math.floor(minutes / 60);
	minutes -= hours * 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
	return parts.join(" ");
}

interface JstParts {
	year: number;
	month: number;
	day: number;
	weekday: string;
}

function jstParts(date: Date): JstParts {
	const shifted = new Date(date.getTime() + JST_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		weekday: WEEKDAYS[shifted.getUTCDay()],
	};
}

function timeParts(value: string): { hour: number; minute: number } {
	const padded = value.padStart(4, "0");
	return {
		hour: Number.parseInt(padded.slice(0, 2), 10),
		minute: Number.parseInt(padded.slice(2, 4), 10),
	};
}

function makeJstDate(year: number, month: number, day: number, time: string): Date | null {
	const { hour, minute } = timeParts(time);
	if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 24 || minute < 0 || minute > 59) {
		return null;
	}
	if (hour === 24 && minute !== 0) return null;
	const date = new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
	const expected = hour === 24
		? new Date(Date.UTC(year, month - 1, day + 1))
		: new Date(Date.UTC(year, month - 1, day));
	const actual = jstParts(date);
	if (
		actual.year !== expected.getUTCFullYear() ||
		actual.month !== expected.getUTCMonth() + 1 ||
		actual.day !== expected.getUTCDate()
	) return null;
	return date;
}

function parseHeaderPoint(dateValue: string, timeValue: string): Date {
	const value = dateValue.padStart(8, "0");
	return makeJstDate(
		Number.parseInt(value.slice(0, 4), 10),
		Number.parseInt(value.slice(4, 6), 10),
		Number.parseInt(value.slice(6, 8), 10),
		timeValue,
	) ?? new Date(Number.NaN);
}

function parseAnnualPoint(year: number, value: string): Date | null {
	const [mmdd, time = "0000"] = value.trim().split(/\s+/);
	const padded = mmdd.padStart(4, "0");
	return makeJstDate(year, Number(padded.slice(0, 2)), Number(padded.slice(2, 4)), time);
}

function startOfJstDay(date: Date): Date {
	const parts = jstParts(date);
	return makeJstDate(parts.year, parts.month, parts.day, "0000") as Date;
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * DAY_MS);
}

function dateSelectorMatches(block: TimeBlock, parts: JstParts): boolean {
	if (block.monthDays.length > 0 && !block.monthDays.includes(parts.day)) return false;
	if (block.weekdays.length > 0 && !block.weekdays.includes(parts.weekday)) return false;
	return true;
}

function addOccurrence(
	occurrences: Map<string, { startAt: Date; endAt: Date; eventIds: Set<number> }>,
	startAt: Date | null,
	endAt: Date | null,
	eventIds: number[],
	entryStart: Date,
	entryEnd: Date,
): void {
	if (!startAt || !endAt || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) return;
	if (startAt < entryStart || startAt >= entryEnd) return;
	const clippedEnd = endAt > entryEnd ? entryEnd : endAt;
	if (clippedEnd <= startAt) return;
	const key = `${startAt.getTime()}|${clippedEnd.getTime()}`;
	const occurrence = occurrences.get(key) ?? { startAt, endAt: clippedEnd, eventIds: new Set<number>() };
	for (const eventId of eventIds) occurrence.eventIds.add(eventId);
	occurrences.set(key, occurrence);
}

function addBlockOccurrences(
	occurrences: Map<string, { startAt: Date; endAt: Date; eventIds: Set<number> }>,
	block: TimeBlock,
	eventIds: number[],
	windowFrom: Date,
	windowTo: Date,
	entryStart: Date,
	entryEnd: Date,
): void {
	if (block.dateRanges.length > 0) {
		const firstYear = jstParts(windowFrom).year - 1;
		const lastYear = jstParts(windowTo).year + 1;
		for (let year = firstYear; year <= lastYear; year++) {
			for (const range of block.dateRanges) {
				const startAt = parseAnnualPoint(year, range.start);
				let endAt = parseAnnualPoint(year, range.end);
				if (startAt && endAt && endAt <= startAt) endAt = parseAnnualPoint(year + 1, range.end);
				addOccurrence(occurrences, startAt, endAt, eventIds, entryStart, entryEnd);
			}
		}
		return;
	}

	for (
		let day = addDays(startOfJstDay(windowFrom), -2);
		day <= addDays(windowTo, 1);
		day = addDays(day, 1)
	) {
		const parts = jstParts(day);
		if (!dateSelectorMatches(block, parts)) continue;
		const ranges = block.timeRanges.length > 0 ? block.timeRanges : [["0000", "2400"]];
		for (const [start, end] of ranges) {
			const startAt = makeJstDate(parts.year, parts.month, parts.day, start);
			let endAt = makeJstDate(parts.year, parts.month, parts.day, end);
			if (startAt && endAt && endAt <= startAt) endAt = addDays(endAt, 1);
			addOccurrence(occurrences, startAt, endAt, eventIds, entryStart, entryEnd);
		}
	}
}

export function collectEventOccurrences(
	sale: SaleJson,
	windowFrom: Date,
	windowTo: Date,
): EventOccurrence[] {
	const occurrences = new Map<string, { startAt: Date; endAt: Date; eventIds: Set<number> }>();
	for (const entry of sale.data) {
		if (isIgnoredEventEntry(entry)) continue;
		const entryStart = parseHeaderPoint(entry.header.startDate, entry.header.startTime);
		const entryEnd = parseHeaderPoint(entry.header.endDate, entry.header.endTime);
		if (!Number.isFinite(entryStart.getTime()) || !Number.isFinite(entryEnd.getTime())) continue;
		if (entry.timeBlocks.length === 0) {
			addOccurrence(occurrences, entryStart, entryEnd, entry.stageIds, entryStart, entryEnd);
			continue;
		}
		for (const block of entry.timeBlocks) {
			addBlockOccurrences(
				occurrences,
				block,
				entry.stageIds,
				windowFrom,
				windowTo,
				entryStart,
				entryEnd,
			);
		}
	}
	return [...occurrences.values()]
		.sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
		.map((occurrence) => ({
			startAt: occurrence.startAt,
			endAt: occurrence.endAt,
			eventIds: [...occurrence.eventIds].sort((a, b) => a - b),
		}));
}

export function collectEventNotifications(
	sale: SaleJson,
	from: Date,
	to: Date,
): EventNotification[] {
	const grouped = new Map<
		string,
		{ notifyAt: Date; phase: EventNotificationPhase; events: Map<number, number> }
	>();
	const occurrences = collectEventOccurrences(sale, addDays(from, -2), addDays(to, 2));
	for (const occurrence of occurrences) {
		const phases: Array<[EventNotificationPhase, Date]> = [
			["start-5m", new Date(occurrence.startAt.getTime() - 5 * 60_000)],
			["start", occurrence.startAt],
			["end-10m", new Date(occurrence.endAt.getTime() - 10 * 60_000)],
		];
		for (const [phase, notifyAt] of phases) {
			if (notifyAt <= from || notifyAt > to) continue;
			const key = `${phase}|${notifyAt.getTime()}`;
			const notification = grouped.get(key) ?? { notifyAt, phase, events: new Map<number, number>() };
			const durationMs = occurrence.endAt.getTime() - occurrence.startAt.getTime();
			for (const eventId of occurrence.eventIds) {
				if (!notification.events.has(eventId)) notification.events.set(eventId, durationMs);
			}
			grouped.set(key, notification);
		}
	}
	return [...grouped.values()]
		.sort((left, right) => left.notifyAt.getTime() - right.notifyAt.getTime())
		.map((notification) => ({
			notifyAt: notification.notifyAt,
			phase: notification.phase,
			events: [...notification.events.entries()]
				.sort(([left], [right]) => left - right)
				.map(([eventId, durationMs]) => ({ eventId, durationMs })),
		}));
}
