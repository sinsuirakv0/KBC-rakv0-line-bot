export const RAW_BASE_URL =
	process.env.KBC_EVENT_RAW_BASE_URL ||
	"https://raw.githubusercontent.com/sinsuirakv0/KBC-rakv0-event/main";

export const JST_MS = 9 * 60 * 60 * 1000;
export const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
export const WEEKDAY_JA_MAP: Record<string, string> = {
	Sun: "日",
	Mon: "月",
	Tue: "火",
	Wed: "水",
	Thu: "木",
	Fri: "金",
	Sat: "土",
};

const cache = new Map<string, { expiresAt: number; value: unknown }>();

export interface ReplyableLineMessage {
	reply(text: string): Promise<void>;
	send(text: string): Promise<void>;
	client: Client;
	destination: LineDestination;
}

export interface LineDestination {
	kind: "talk" | "square";
	chatMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	senderMid: string;
	encrypted: boolean;
}

export interface CommandContext {
	message: ReplyableLineMessage;
	command: string;
	args: string[];
}

export interface LineCommand {
	name: string;
	aliases?: string[];
	execute(context: CommandContext): Promise<void>;
}

export function parseDate(dateStr: string, timeStr: string): Date {
	const d = dateStr.padStart(8, "0");
	const t = timeStr.padStart(4, "0");
	return new Date(
		`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${
			t.slice(2, 4)
		}:00+09:00`,
	);
}

export function formatDateShort(date: Date): string {
	const jst = new Date(date.getTime() + JST_MS);
	const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
	const d = String(jst.getUTCDate()).padStart(2, "0");
	const wd = WEEKDAYS_JA[jst.getUTCDay()];
	const hh = String(jst.getUTCHours()).padStart(2, "0");
	const mm = String(jst.getUTCMinutes()).padStart(2, "0");
	return `${m}/${d}(${wd}) ${hh}:${mm}`;
}

export function formatDateFull(date: Date): string {
	const jst = new Date(date.getTime() + JST_MS);
	const y = jst.getUTCFullYear();
	const m = jst.getUTCMonth() + 1;
	const d = jst.getUTCDate();
	const wd = WEEKDAYS_JA[jst.getUTCDay()];
	const hh = String(jst.getUTCHours()).padStart(2, "0");
	const mm = String(jst.getUTCMinutes()).padStart(2, "0");
	return `${y}年${m}月${d}日(${wd}) ${hh}:${mm}`;
}

export function parseTimeMin(s: string): number {
	const p = s.padStart(4, "0");
	return parseInt(p.slice(0, 2), 10) * 60 + parseInt(p.slice(2, 4), 10);
}

export function fmtMin(m: number): string {
	if (m >= 1440) return "24:00";
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${
		String(m % 60).padStart(2, "0")
	}`;
}

export function parseDateRangePoint(s: string): string {
	const parts = s.trim().split(" ");
	const mmdd = parts[0].padStart(4, "0");
	const month = parseInt(mmdd.slice(0, 2), 10);
	const day = parseInt(mmdd.slice(2, 4), 10);
	const ts = (parts[1] ?? "0").padStart(4, "0");
	return `${month}/${day} ${ts.slice(0, 2)}:${ts.slice(2, 4)}`;
}

export interface TimeBlock {
	dateRanges: { start: string; end: string }[];
	monthDays: number[];
	weekdays: string[];
	timeRanges: string[][];
}

export function formatTimeBlock(block: TimeBlock): string {
	let dayPart: string;
	if (block.weekdays.length > 0) {
		const days = block.weekdays.map((w) => WEEKDAY_JA_MAP[w] ?? w).join("・");
		dayPart = `毎週${days}曜`;
	} else if (block.monthDays.length > 0) {
		dayPart = `毎月${block.monthDays.join(",")}日`;
	} else if (block.dateRanges.length > 0) {
		dayPart = block.dateRanges
			.map((r) => `${parseDateRangePoint(r.start)}~${parseDateRangePoint(r.end)}`)
			.join(" / ");
	} else {
		dayPart = "毎日";
	}

	const timePart = block.timeRanges.length === 0
		? "終日"
		: block.timeRanges
			.map(([s, e]) => `${fmtMin(parseTimeMin(s))}~${fmtMin(parseTimeMin(e))}`)
			.join("、");

	return `${dayPart} ${timePart}`;
}

export async function fetchText(path: string, ttlMs = 60_000): Promise<string> {
	const url = `${RAW_BASE_URL}/${path}`;
	const cached = cache.get(url);
	if (cached && cached.expiresAt > Date.now()) return cached.value as string;

	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
	const value = await response.text();
	cache.set(url, { expiresAt: Date.now() + ttlMs, value });
	return value;
}

export async function fetchJson<T>(path: string, ttlMs = 60_000): Promise<T> {
	const url = `${RAW_BASE_URL}/${path}`;
	const cached = cache.get(url);
	if (cached && cached.expiresAt > Date.now()) return cached.value as T;

	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
	const value = await response.json() as T;
	cache.set(url, { expiresAt: Date.now() + ttlMs, value });
	return value;
}

export async function fetchCsvMap(path: string): Promise<Map<number, string>> {
	const text = await fetchText(path);
	const map = new Map<number, string>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const comma = trimmed.indexOf(",");
		if (comma === -1) continue;
		const id = parseInt(trimmed.slice(0, comma), 10);
		if (!Number.isNaN(id)) map.set(id, trimmed.slice(comma + 1).trim());
	}
	return map;
}

export async function fetchItemNameMap(path: string): Promise<Map<number, string>> {
	const text = await fetchText(path);
	const map = new Map<number, string>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const comma = trimmed.indexOf(",");
		if (comma === -1) continue;
		const id = parseInt(trimmed.slice(0, comma), 10);
		if (Number.isNaN(id) || id === -1) continue;
		const rest = trimmed.slice(comma + 1);
		const secondComma = rest.indexOf(",");
		const name = secondComma === -1 ? rest.trim() : rest.slice(0, secondComma).trim();
		if (name) map.set(id, name);
	}
	return map;
}

export function isExactInteger(value: string): boolean {
	if (!/^-?\d+$/.test(value.trim())) return false;
	return String(parseInt(value, 10)) === value.trim();
}

export function codeBlock(text: string, lang = ""): string {
	const safe = text.replace(/```/g, "`\u200b``");
	return lang ? `\`\`\`${lang}\n${safe}\n\`\`\`` : `\`\`\`\n${safe}\n\`\`\``;
}

export async function sendLong(message: ReplyableLineMessage, text: string, lang = ""): Promise<void> {
	const lines = text.split("\n");
	const chunks: string[] = [];
	let current = "";
	const max = 1600;

	for (const line of lines) {
		const addition = current ? `\n${line}` : line;
		if ((current + addition).length > max && current) {
			chunks.push(current);
			current = line;
		} else {
			current = current ? `${current}\n${line}` : line;
		}
	}
	if (current) chunks.push(current);

	for (let i = 0; i < chunks.length; i++) {
		const body = codeBlock(chunks[i], lang);
		if (i === 0) await message.reply(body);
		else await message.send(body);
	}
}

export async function sendError(message: ReplyableLineMessage, text: string): Promise<void> {
	await message.reply(`エラー: ${text}`);
}
import type { Client } from "@evex/linejs";
