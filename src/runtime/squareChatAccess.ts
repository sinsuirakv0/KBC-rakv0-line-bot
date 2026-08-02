import type { Client } from "@evex/linejs";
import { compactLineError } from "./lineErrorPolicy.js";

const DEFAULT_PAUSE_MS = 6 * 60 * 60_000;

interface PausedSquareChat {
	until: number;
	detail: string;
	source: string;
}

const pausedByClient = new WeakMap<Client, Map<string, PausedSquareChat>>();

function pausedChats(client: Client): Map<string, PausedSquareChat> {
	let chats = pausedByClient.get(client);
	if (!chats) {
		chats = new Map();
		pausedByClient.set(client, chats);
	}
	return chats;
}

export function isSquareChatMembershipError(error: unknown): boolean {
	return /NOT_FOUND|NOT_A_MEMBER|not a member|メンバーではありません|status=404\b/i.test(
		compactLineError(error),
	);
}

export function isSquareChatAccessPaused(
	client: Client,
	squareChatMid: string,
	now = Date.now(),
): boolean {
	const chats = pausedByClient.get(client);
	const paused = chats?.get(squareChatMid);
	if (!paused) return false;
	if (paused.until > now) return true;
	chats?.delete(squareChatMid);
	return false;
}

export function markSquareChatAccessible(client: Client, squareChatMid: string): void {
	const chats = pausedByClient.get(client);
	if (!chats?.delete(squareChatMid)) return;
	console.log("[square-access] target resumed after receiving accessible activity", {
		squareChatMid,
	});
}

export function pauseSquareChatAccess(
	client: Client,
	squareChatMid: string,
	error: unknown,
	source: string,
	pauseMs = DEFAULT_PAUSE_MS,
	now = Date.now(),
): boolean {
	if (!isSquareChatMembershipError(error)) return false;
	const chats = pausedChats(client);
	const current = chats.get(squareChatMid);
	const until = now + Math.max(1, pauseMs);
	chats.set(squareChatMid, {
		until: Math.max(current?.until ?? 0, until),
		detail: compactLineError(error),
		source,
	});
	if (!current || current.until <= now) {
		console.warn("[square-access] target paused because this bot is not a member", {
			squareChatMid,
			source,
			retryAfter: new Date(until).toISOString(),
		});
	}
	return true;
}
