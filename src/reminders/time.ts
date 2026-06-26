const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const MAX_DELAY_MINUTES = 10 * 365 * 24 * 60;

export type ReminderParseFailureReason =
	| "not-reminder"
	| "missing-content"
	| "invalid-time"
	| "past"
	| "too-far";

export type ReminderParseResult =
	| {
		ok: true;
		remindAt: Date;
		content: string;
	}
	| {
		ok: false;
		reason: ReminderParseFailureReason;
	};

interface DateTimeParts {
	year?: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	consumedArgs: number;
}

interface JstParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

function currentJstParts(now: Date): JstParts {
	const jst = new Date(now.getTime() + JST_OFFSET_MS);
	return {
		year: jst.getUTCFullYear(),
		month: jst.getUTCMonth() + 1,
		day: jst.getUTCDate(),
		hour: jst.getUTCHours(),
		minute: jst.getUTCMinutes(),
	};
}

function makeJstDate(parts: Required<DateTimeParts>): Date | null {
	if (
		parts.month < 1 ||
		parts.month > 12 ||
		parts.day < 1 ||
		parts.day > 31 ||
		parts.hour < 0 ||
		parts.hour > 23 ||
		parts.minute < 0 ||
		parts.minute > 59
	) {
		return null;
	}

	const value = new Date(Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
	) - JST_OFFSET_MS);
	const actual = currentJstParts(value);
	if (
		actual.year !== parts.year ||
		actual.month !== parts.month ||
		actual.day !== parts.day ||
		actual.hour !== parts.hour ||
		actual.minute !== parts.minute
	) {
		return null;
	}
	return value;
}

function parseYear(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const year = Number.parseInt(raw, 10);
	if (!Number.isInteger(year)) return undefined;
	return year < 100 ? 2000 + year : year;
}

function numberPart(value: string): number {
	return Number.parseInt(value, 10);
}

function parseDateTimeArgs(args: string[]): DateTimeParts | null {
	const first = args[0];
	if (!first) return null;

	const date = String.raw`(?:(\d{2,4})/)?(\d{1,2})/(\d{1,2})`;
	const time = String.raw`[-－ー]?(\d{1,2})[:：](\d{2})`;
	const combinedPatterns = [
		new RegExp(`^${date}[\\(（]${time}[\\)）]$`),
		new RegExp(`^${date}-${time}$`),
	];

	for (const pattern of combinedPatterns) {
		const match = pattern.exec(first);
		if (!match) continue;
		return {
			year: parseYear(match[1]),
			month: numberPart(match[2]),
			day: numberPart(match[3]),
			hour: numberPart(match[4]),
			minute: numberPart(match[5]),
			consumedArgs: 1,
		};
	}

	const dateOnly = new RegExp(`^${date}$`).exec(first);
	const timeOnly = /^[-－ー]?(\d{1,2})[:：](\d{2})$/.exec(args[1] ?? "");
	if (dateOnly && timeOnly) {
		return {
			year: parseYear(dateOnly[1]),
			month: numberPart(dateOnly[2]),
			day: numberPart(dateOnly[3]),
			hour: numberPart(timeOnly[1]),
			minute: numberPart(timeOnly[2]),
			consumedArgs: 2,
		};
	}

	if (dateOnly) {
		return {
			year: parseYear(dateOnly[1]),
			month: numberPart(dateOnly[2]),
			day: numberPart(dateOnly[3]),
			hour: 0,
			minute: 0,
			consumedArgs: 1,
		};
	}

	if (/^(\d{1,2})\/(\d{1,2})/.test(first)) {
		return {
			month: 0,
			day: 0,
			hour: 0,
			minute: 0,
			consumedArgs: 1,
		};
	}

	return null;
}

export function parseReminderArgs(args: string[], now = new Date()): ReminderParseResult {
	const first = args[0];
	if (!first) return { ok: false, reason: "not-reminder" };

	if (/^\d+$/.test(first)) {
		const minutes = Number.parseInt(first, 10);
		if (!Number.isSafeInteger(minutes) || minutes <= 0) {
			return { ok: false, reason: "invalid-time" };
		}
		if (minutes > MAX_DELAY_MINUTES) return { ok: false, reason: "too-far" };
		const content = args.slice(1).join(" ").trim();
		if (!content) return { ok: false, reason: "missing-content" };
		return {
			ok: true,
			remindAt: new Date(now.getTime() + minutes * MINUTE_MS),
			content,
		};
	}

	const dateTime = parseDateTimeArgs(args);
	if (!dateTime) return { ok: false, reason: "not-reminder" };
	if (!dateTime.month) return { ok: false, reason: "invalid-time" };

	const year = dateTime.year ?? currentJstParts(now).year;
	const remindAt = makeJstDate({ ...dateTime, year });
	if (!remindAt) return { ok: false, reason: "invalid-time" };
	if (remindAt.getTime() <= now.getTime()) return { ok: false, reason: "past" };

	const content = args.slice(dateTime.consumedArgs).join(" ").trim();
	if (!content) return { ok: false, reason: "missing-content" };
	return { ok: true, remindAt, content };
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatReminderDate(date: Date): string {
	const parts = currentJstParts(date);
	return `${parts.year}/${pad2(parts.month)}/${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)} JST`;
}
