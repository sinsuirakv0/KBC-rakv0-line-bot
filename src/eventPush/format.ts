import type { TimeBlock } from "../commands/shared.js";
import {
	collectEventOccurrences,
	formatEventDuration,
	type EventOccurrence,
	type SaleEntry,
	type SaleJson,
} from "./schedule.js";

const JST_MS = 9 * 60 * 60 * 1_000;
const SEARCH_RANGE_MS = 400 * 24 * 60 * 60 * 1_000;
const WEEKDAY_JA: Record<string, string> = {
	Sun: "\u65e5",
	Mon: "\u6708",
	Tue: "\u706b",
	Wed: "\u6c34",
	Thu: "\u6728",
	Fri: "\u91d1",
	Sat: "\u571f",
};

function formatTime(value: string): string {
	const padded = value.padStart(4, "0");
	return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
}

function formatAnnualPoint(value: string): string {
	const [datePart, timePart = "0"] = value.trim().split(/\s+/);
	const padded = datePart.padStart(4, "0");
	return `${padded.slice(0, 2)}/${padded.slice(2, 4)} ${formatTime(timePart)}`;
}

function formatBlock(block: TimeBlock): string[] {
	if (block.dateRanges.length > 0) {
		return block.dateRanges.map(({ start, end }) =>
			`\u6bce\u5e74${formatAnnualPoint(start)}~${formatAnnualPoint(end)}`
		);
	}

	const ranges = block.timeRanges.length > 0 ? block.timeRanges : [["0000", "2400"]];
	const rangeLabels = ranges.map(([start, end]) => `${formatTime(start)}~${formatTime(end)}`);
	if (block.monthDays.length > 0) {
		return block.monthDays.flatMap((day) =>
			rangeLabels.map((range) => `\u6bce\u6708${day}\u65e5 ${range}`)
		);
	}
	if (block.weekdays.length > 0) {
		return block.weekdays.flatMap((weekday) =>
			rangeLabels.map((range) => `\u6bce\u9031${WEEKDAY_JA[weekday] ?? weekday}\u66dc\u65e5 ${range}`)
		);
	}
	return rangeLabels.map((range) => `\u6bce\u65e5 ${range}`);
}

function formatHeader(entry: SaleEntry): string {
	const formatPoint = (date: string, time: string) => {
		const value = date.padStart(8, "0");
		return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)} ${formatTime(time)}`;
	};
	return `${formatPoint(entry.header.startDate, entry.header.startTime)}~${formatPoint(entry.header.endDate, entry.header.endTime)}`;
}

export function formatEventSchedule(entries: SaleEntry[]): string[] {
	const lines = entries.flatMap((entry) =>
		entry.timeBlocks.length > 0
			? entry.timeBlocks.flatMap(formatBlock)
			: [formatHeader(entry)]
	);
	return [...new Set(lines)];
}

export function findNextEventOccurrence(
	eventId: number,
	entries: SaleEntry[],
	now = new Date(),
): EventOccurrence | undefined {
	const sale: SaleJson = { updatedAt: "", data: entries };
	return collectEventOccurrences(sale, now, new Date(now.getTime() + SEARCH_RANGE_MS))
		.filter((occurrence) => occurrence.eventIds.includes(eventId) && occurrence.startAt > now)
		.sort((left, right) => left.startAt.getTime() - right.startAt.getTime())[0];
}

function jstDateParts(date: Date): {
	year: number;
	month: number;
	day: number;
	weekday: number;
	hour: number;
	minute: number;
} {
	const shifted = new Date(date.getTime() + JST_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		weekday: shifted.getUTCDay(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
	};
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function formatRelative(startAt: Date, now: Date): string {
	let minutes = Math.max(0, Math.floor((startAt.getTime() - now.getTime()) / 60_000));
	if (minutes === 0) return "1\u5206\u4ee5\u5185\u306b\u958b\u50ac";
	const days = Math.floor(minutes / (24 * 60));
	minutes -= days * 24 * 60;
	const hours = Math.floor(minutes / 60);
	minutes -= hours * 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}\u65e5`);
	if (hours > 0) parts.push(`${hours}\u6642\u9593`);
	if (minutes > 0) parts.push(`${minutes}\u5206`);
	return `${parts.join("")}\u5f8c\u306b\u958b\u50ac`;
}

export function formatNextEventOccurrence(occurrence: EventOccurrence, now = new Date()): string {
	const start = jstDateParts(occurrence.startAt);
	const end = jstDateParts(occurrence.endAt);
	const weekdays = ["\u65e5", "\u6708", "\u706b", "\u6c34", "\u6728", "\u91d1", "\u571f"];
	const startLabel = `${start.year}/${pad(start.month)}/${pad(start.day)}(${weekdays[start.weekday]}) ${pad(start.hour)}:${pad(start.minute)}`;
	const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
	const endLabel = sameDay
		? `${pad(end.hour)}:${pad(end.minute)}`
		: `${end.year}/${pad(end.month)}/${pad(end.day)} ${pad(end.hour)}:${pad(end.minute)}`;
	const duration = formatEventDuration(occurrence.endAt.getTime() - occurrence.startAt.getTime());
	return `${startLabel} ~${endLabel} <${duration}> (${formatRelative(occurrence.startAt, now)})`;
}
