import type { ReplyableLineMessage } from "./shared.js";

const DEFAULT_PAGE_SIZE = 10;
const EXPIRES_MS = 10 * 60_000;

interface SearchPageSession {
	title: string;
	rows: string[];
	pageSize: number;
	destinationKey: string;
	senderMid: string;
	expiresAt: number;
}

const sessions = new Map<string, SearchPageSession>();
const recentSessions = new Map<string, SearchPageSession>();
let cleanupTimer: NodeJS.Timeout | undefined;

function destinationKey(message: ReplyableLineMessage): string {
	return `${message.destination.kind}:${message.destination.chatMid}`;
}

function recentKey(message: ReplyableLineMessage): string {
	return `${destinationKey(message)}:${message.destination.senderMid}`;
}

function cleanup(): void {
	const now = Date.now();
	for (const [messageId, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(messageId);
	}
	for (const [key, session] of recentSessions) {
		if (session.expiresAt <= now) recentSessions.delete(key);
	}
	scheduleCleanup();
}

function scheduleCleanup(): void {
	if (cleanupTimer) {
		clearTimeout(cleanupTimer);
		cleanupTimer = undefined;
	}
	let nextExpiration = Number.POSITIVE_INFINITY;
	for (const session of sessions.values()) {
		nextExpiration = Math.min(nextExpiration, session.expiresAt);
	}
	for (const session of recentSessions.values()) {
		nextExpiration = Math.min(nextExpiration, session.expiresAt);
	}
	if (!Number.isFinite(nextExpiration)) return;
	cleanupTimer = setTimeout(cleanup, Math.max(1, nextExpiration - Date.now()));
	cleanupTimer.unref();
}

function releaseSession(session: SearchPageSession): void {
	for (const [messageId, stored] of sessions) {
		if (stored.rows === session.rows) sessions.delete(messageId);
	}
	for (const [key, stored] of recentSessions) {
		if (stored.rows === session.rows) recentSessions.delete(key);
	}
	scheduleCleanup();
}

function formatPage(session: SearchPageSession, page: number): string {
	const start = (page - 1) * session.pageSize;
	const end = Math.min(start + session.pageSize, session.rows.length);
	const lines = [
		`${session.title} ${start + 1}~${end}/${session.rows.length}`,
		...session.rows.slice(start, end),
	];
	if (end < session.rows.length) {
		lines.push(`${end + 1}~${Math.min(end + session.pageSize, session.rows.length)}を表示するにはこのメッセージに ${page + 1} とリプライしてください`);
	}
	return lines.join("\n");
}

export async function sendSearchResults(
	message: ReplyableLineMessage,
	title: string,
	rows: string[],
	pageSize = DEFAULT_PAGE_SIZE,
): Promise<void> {
	cleanup();
	const temporarySession: SearchPageSession = {
		title,
		rows,
		pageSize,
		destinationKey: destinationKey(message),
		senderMid: message.destination.senderMid,
		expiresAt: Date.now() + EXPIRES_MS,
	};
	const messageId = await message.send(formatPage(temporarySession, 1));
	if (messageId && rows.length > pageSize) sessions.set(messageId, temporarySession);
	if (rows.length > pageSize) recentSessions.set(recentKey(message), temporarySession);
	if (rows.length > pageSize) scheduleCleanup();
}

export async function handleSearchPageReply(
	messageText: string,
	message: ReplyableLineMessage,
): Promise<boolean> {
	cleanup();
	const page = Number.parseInt(messageText.trim(), 10);
	if (!Number.isInteger(page) || String(page) !== messageText.trim() || page < 2) return false;
	const targetId = message.replyToMessageId;
	const session = targetId ? sessions.get(targetId) : recentSessions.get(recentKey(message));
	if (!session || session.destinationKey !== destinationKey(message) ||
		session.senderMid !== message.destination.senderMid) return false;
	const maxPage = Math.ceil(session.rows.length / session.pageSize);
	if (page > maxPage) {
		await message.send(`ページは1~${maxPage}までです。`);
		return true;
	}
	const messageId = await message.send(formatPage(session, page));
	if (page >= maxPage) {
		releaseSession(session);
		return true;
	}
	const refreshedSession: SearchPageSession = {
		...session,
		expiresAt: Date.now() + EXPIRES_MS,
	};
	if (messageId) sessions.set(messageId, refreshedSession);
	recentSessions.set(recentKey(message), refreshedSession);
	scheduleCleanup();
	return true;
}
