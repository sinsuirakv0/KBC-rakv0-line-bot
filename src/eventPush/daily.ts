import {
	collectEventOccurrences,
	formatEventDuration,
	type SaleJson,
} from "./schedule.js";

const JST_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

interface JstDateParts {
	year: number;
	month: number;
	day: number;
	weekday: number;
	hour: number;
	minute: number;
}

export interface DailyDelivery {
	dueAt: Date;
	dayStart: Date;
	dateKey: string;
}

function jstDateParts(date: Date): JstDateParts {
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

function makeJstDate(year: number, month: number, day: number, hour = 0): Date | null {
	const date = new Date(Date.UTC(year, month - 1, day, hour - 9));
	const parts = jstDateParts(date);
	if (parts.year !== year || parts.month !== month || parts.day !== day || parts.hour !== hour) {
		return null;
	}
	return date;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function startOfJstDay(date: Date): Date {
	const parts = jstDateParts(date);
	return makeJstDate(parts.year, parts.month, parts.day) as Date;
}

export function tomorrowJstStart(now = new Date()): Date {
	return new Date(startOfJstDay(now).getTime() + DAY_MS);
}

export function parseDailyDateArgument(value: string, now = new Date()): Date | null {
	const match = value.trim().match(/^(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})$/);
	if (!match) return null;
	const current = jstDateParts(now);
	const year = match[1] ? Number.parseInt(match[1], 10) : current.year;
	const month = Number.parseInt(match[2], 10);
	const day = Number.parseInt(match[3], 10);
	return makeJstDate(year, month, day);
}

export function formatDailyDate(dayStart: Date): string {
	const parts = jstDateParts(dayStart);
	return `${parts.year}/${parts.month}/${parts.day}(${WEEKDAYS_JA[parts.weekday]})`;
}

export function dailyRootText(dayStart: Date): string {
	return [
		`${formatDailyDate(dayStart)}の予定`,
		"ごく稀にイベントカレンダー未掲載のリークイベントが含まれるためスレッドに送信します",
	].join("\n");
}

export function formatDailyScheduleBody(
	sale: SaleJson,
	names: Map<number, string>,
	dayStart: Date,
): string {
	const dayEnd = new Date(dayStart.getTime() + DAY_MS);
	const dailySale: SaleJson = {
		...sale,
		data: sale.data.filter((entry) =>
			!(entry.header.endDate === "20300101" && entry.timeBlocks.length === 0)
		),
	};
	const occurrences = collectEventOccurrences(dailySale, dayStart, dayEnd);
	const groups = new Map<number, Map<string, { eventId: number; suffix: string }>>();
	for (const occurrence of occurrences) {
		const durationMs = occurrence.endAt.getTime() - occurrence.startAt.getTime();
		if (occurrence.startAt >= dayStart && occurrence.startAt < dayEnd) {
			const startTime = occurrence.startAt.getTime();
			const rows = groups.get(startTime) ?? new Map<string, { eventId: number; suffix: string }>();
			for (const eventId of occurrence.eventIds) {
				const suffix = `<${formatEventDuration(durationMs).replaceAll(" ", "")}>`;
				const key = `${eventId}|start|${durationMs}`;
				if (!rows.has(key)) rows.set(key, { eventId, suffix });
			}
			groups.set(startTime, rows);
		}
		if (
			occurrence.startAt < dayStart &&
			occurrence.endAt > dayStart &&
			occurrence.endAt < dayEnd
		) {
			const rows = groups.get(dayStart.getTime()) ??
				new Map<string, { eventId: number; suffix: string }>();
			const end = jstDateParts(occurrence.endAt);
			for (const eventId of occurrence.eventIds) {
				const suffix = `~${pad(end.hour)}:${pad(end.minute)}`;
				const key = `${eventId}|end|${occurrence.endAt.getTime()}`;
				if (!rows.has(key)) rows.set(key, { eventId, suffix });
			}
			groups.set(dayStart.getTime(), rows);
		}
	}

	const lines: string[] = [];
	for (const [startTime, rows] of [...groups.entries()].sort(([left], [right]) => left - right)) {
		const parts = jstDateParts(new Date(startTime));
		lines.push(`[${pad(parts.hour)}:${pad(parts.minute)}]`);
		for (const { eventId, suffix } of [...rows.values()].sort((left, right) =>
			left.eventId - right.eventId
		)) {
			lines.push(`${names.get(eventId) || "名称不明"} ${suffix}`);
		}
	}
	return lines.length > 0 ? lines.join("\n") : "予定なし";
}

export function dailyDeliveryInWindow(
	now: Date,
	lookbackMs: number,
	deliveryHour = 22,
): DailyDelivery | undefined {
	const todayStart = startOfJstDay(now);
	const dueAt = new Date(todayStart.getTime() + deliveryHour * 60 * 60 * 1_000);
	const from = new Date(now.getTime() - lookbackMs);
	if (dueAt <= from || dueAt > now) return undefined;
	const dayStart = new Date(todayStart.getTime() + DAY_MS);
	const parts = jstDateParts(dayStart);
	return {
		dueAt,
		dayStart,
		dateKey: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
	};
}
