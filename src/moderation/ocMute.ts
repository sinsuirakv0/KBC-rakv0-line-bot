export interface OcMuteEntry {
	memberMid: string;
	displayName?: string;
	mutedAt: string;
	mutedBy: string;
	expiresAt?: string;
}

export type OcMuteExpirationParseResult =
	| { ok: true; expiresAt?: string }
	| { ok: false; error: string };

const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

interface JstDateParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

function jstDateParts(timestamp: number): JstDateParts {
	const date = new Date(timestamp + JST_OFFSET_MS);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
	};
}

function jstTimestamp(year: number, month: number, day: number, hour: number, minute: number): number | undefined {
	if (month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		return undefined;
	}
	const timestamp = Date.UTC(year, month - 1, day, hour - 9, minute);
	const actual = jstDateParts(timestamp);
	if (
		actual.year !== year ||
		actual.month !== month ||
		actual.day !== day ||
		actual.hour !== hour ||
		actual.minute !== minute
	) return undefined;
	return timestamp;
}

function numeric(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function futureTimestamp(timestamp: number | undefined, now: number): OcMuteExpirationParseResult {
	if (timestamp === undefined) return { ok: false, error: "日付または時刻の指定が正しくありません。" };
	if (timestamp <= now) return { ok: false, error: "終了時刻は現在より後にしてください。" };
	return { ok: true, expiresAt: new Date(timestamp).toISOString() };
}

/**
 * ミュート期限を日本時間として解析する。
 * 数字のみは分数、時刻だけは次に来る同時刻、日付だけは当日0時として扱う。
 */
export function parseOcMuteExpiration(raw: string | undefined, now = Date.now()): OcMuteExpirationParseResult {
	const value = raw?.normalize("NFKC").trim().toLowerCase();
	if (!value) return { ok: false, error: "時間指定が必要です。" };
	if (value === "inf" || value === "infinity") return { ok: true };

	const minutes = numeric(value);
	if (minutes !== undefined) {
		if (minutes < 1) return { ok: false, error: "分数は1以上で指定してください。" };
		const timestamp = now + minutes * 60_000;
		if (!Number.isSafeInteger(timestamp)) return { ok: false, error: "時間指定が大きすぎます。" };
		return { ok: true, expiresAt: new Date(timestamp).toISOString() };
	}

	const current = jstDateParts(now);
	const timeMatch = value.match(/^(\d{1,2}):(\d{2})$/);
	if (timeMatch) {
		const hour = numeric(timeMatch[1]);
		const minute = numeric(timeMatch[2]);
		if (hour === undefined || minute === undefined) return { ok: false, error: "時刻の指定が正しくありません。" };
		let timestamp = jstTimestamp(current.year, current.month, current.day, hour, minute);
		if (timestamp !== undefined && timestamp <= now) {
			const tomorrow = new Date(now + JST_OFFSET_MS + 24 * 60 * 60 * 1_000);
			timestamp = jstTimestamp(
				tomorrow.getUTCFullYear(),
				tomorrow.getUTCMonth() + 1,
				tomorrow.getUTCDate(),
				hour,
				minute,
			);
		}
		return futureTimestamp(timestamp, now);
	}

	const dateTimeMatch = value.match(/^(?:(\d{4})[/-])?(\d{1,2})\/(\d{1,2})[-\s](\d{1,2}):(\d{2})$/);
	if (dateTimeMatch) {
		const year = numeric(dateTimeMatch[1]) ?? current.year;
		const month = numeric(dateTimeMatch[2]);
		const day = numeric(dateTimeMatch[3]);
		const hour = numeric(dateTimeMatch[4]);
		const minute = numeric(dateTimeMatch[5]);
		if (month === undefined || day === undefined || hour === undefined || minute === undefined) {
			return { ok: false, error: "日付または時刻の指定が正しくありません。" };
		}
		return futureTimestamp(jstTimestamp(year, month, day, hour, minute), now);
	}

	const dateMatch = value.match(/^(?:(\d{4})[/-])?(\d{1,2})\/(\d{1,2})$/);
	if (dateMatch) {
		const year = numeric(dateMatch[1]) ?? current.year;
		const month = numeric(dateMatch[2]);
		const day = numeric(dateMatch[3]);
		if (month === undefined || day === undefined) return { ok: false, error: "日付の指定が正しくありません。" };
		return futureTimestamp(jstTimestamp(year, month, day, 0, 0), now);
	}

	return {
		ok: false,
		error: "時間指定が正しくありません。例: 170 / 0:17 / 8/7 / 8/7-0:17 / inf",
	};
}

export function isOcMuteActive(entry: Pick<OcMuteEntry, "expiresAt">, now = Date.now()): boolean {
	if (!entry.expiresAt) return true;
	const timestamp = new Date(entry.expiresAt).getTime();
	return Number.isFinite(timestamp) && timestamp > now;
}

export function formatOcMuteRemaining(entry: Pick<OcMuteEntry, "expiresAt">, now = Date.now()): string {
	if (!entry.expiresAt) return "無期限";
	const timestamp = new Date(entry.expiresAt).getTime();
	if (!Number.isFinite(timestamp) || timestamp <= now) return "期限切れ";
	const totalMinutes = Math.max(1, Math.ceil((timestamp - now) / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}日`);
	if (hours > 0) parts.push(`${hours}時間`);
	if (minutes > 0 || parts.length === 0) parts.push(`${minutes}分`);
	return parts.join("");
}

export function formatOcMuteUntil(entry: Pick<OcMuteEntry, "expiresAt">): string {
	if (!entry.expiresAt) return "無期限";
	const timestamp = new Date(entry.expiresAt).getTime();
	if (!Number.isFinite(timestamp)) return "期限不明";
	const date = jstDateParts(timestamp);
	const month = String(date.month).padStart(2, "0");
	const day = String(date.day).padStart(2, "0");
	const hour = String(date.hour).padStart(2, "0");
	const minute = String(date.minute).padStart(2, "0");
	return `${date.year}/${month}/${day} ${hour}:${minute}まで`;
}
