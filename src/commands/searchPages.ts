import type { ReplyableLineMessage } from "./shared.js";

const PAGE_SIZE = 10;
const EXPIRES_MS = 10 * 60_000;

interface SearchPageSession {
	title: string;
	rows: string[];
	destinationKey: string;
	expiresAt: number;
}

const sessions = new Map<string, SearchPageSession>();

function destinationKey(message: ReplyableLineMessage): string {
	return `${message.destination.kind}:${message.destination.chatMid}`;
}

function cleanup(): void {
	const now = Date.now();
	for (const [messageId, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(messageId);
	}
}

function formatPage(session: SearchPageSession, page: number): string {
	const start = (page - 1) * PAGE_SIZE;
	const end = Math.min(start + PAGE_SIZE, session.rows.length);
	const lines = [
		`${session.title} ${start + 1}~${end}/${session.rows.length}`,
		...session.rows.slice(start, end),
	];
	if (end < session.rows.length) {
		lines.push(`${end + 1}~${end + PAGE_SIZE}を表示するにはこのメッセージに ${page + 1} とリプライしてください`);
	}
	return lines.join("\n");
}

export async function sendSearchResults(
	message: ReplyableLineMessage,
	title: string,
	rows: string[],
): Promise<void> {
	cleanup();
	const temporarySession: SearchPageSession = {
		title,
		rows,
		destinationKey: destinationKey(message),
		expiresAt: Date.now() + EXPIRES_MS,
	};
	const messageId = await message.send(formatPage(temporarySession, 1));
	if (messageId && rows.length > PAGE_SIZE) sessions.set(messageId, temporarySession);
}

export async function handleSearchPageReply(
	messageText: string,
	message: ReplyableLineMessage,
): Promise<boolean> {
	cleanup();
	const targetId = message.replyToMessageId;
	if (!targetId) return false;
	const page = Number.parseInt(messageText.trim(), 10);
	if (!Number.isInteger(page) || String(page) !== messageText.trim() || page < 2) return false;
	const session = sessions.get(targetId);
	if (!session || session.destinationKey !== destinationKey(message)) return false;
	const maxPage = Math.ceil(session.rows.length / PAGE_SIZE);
	if (page > maxPage) {
		await message.send(`ページは1~${maxPage}までです。`);
		return true;
	}
	const messageId = await message.send(formatPage(session, page));
	if (messageId && page < maxPage) sessions.set(messageId, {
		...session,
		expiresAt: Date.now() + EXPIRES_MS,
	});
	return true;
}
