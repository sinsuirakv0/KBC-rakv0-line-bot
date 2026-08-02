import type { Client } from "@evex/linejs";

import {
	isSquareChatAccessPaused,
	markSquareChatAccessible,
	pauseSquareChatAccess,
} from "../runtime/squareChatAccess.js";

const MAIN_CHAT_CACHE_MS = 6 * 60 * 60_000;

const mainChatMidCache = new WeakMap<Client, Map<string, { chatMid: string; expiresAt: number }>>();
const mainChatResolutionRequests = new WeakMap<Client, Map<string, Promise<string | undefined>>>();

function cacheFor(client: Client): Map<string, { chatMid: string; expiresAt: number }> {
	let cache = mainChatMidCache.get(client);
	if (!cache) {
		cache = new Map();
		mainChatMidCache.set(client, cache);
	}
	return cache;
}

function requestsFor(client: Client): Map<string, Promise<string | undefined>> {
	let requests = mainChatResolutionRequests.get(client);
	if (!requests) {
		requests = new Map();
		mainChatResolutionRequests.set(client, requests);
	}
	return requests;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function compactError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function isMainSquareChatType(value: unknown): boolean {
	return value === 4 || value === "SQUARE_DEFAULT" || String(value) === "4";
}

function cacheMainChatMid(client: Client, squareMid: string, chatMid: string): string {
	cacheFor(client).set(squareMid, {
		chatMid,
		expiresAt: Date.now() + MAIN_CHAT_CACHE_MS,
	});
	return chatMid;
}

export async function resolveMainSquareChatMid(
	client: Client,
	squareMid: string,
	sourceChatMid?: string,
): Promise<string | undefined> {
	const cached = cacheFor(client).get(squareMid);
	if (cached && cached.expiresAt > Date.now()) return cached.chatMid;
	if (!sourceChatMid) return undefined;
	if (isSquareChatAccessPaused(client, sourceChatMid)) return undefined;

	const requests = requestsFor(client);
	const running = requests.get(squareMid);
	if (running) return await running;
	const request = (async () => {
		try {
			const response = await client.base.livetalk.getSquareInfoByChatMid({
				request: { squareChatMid: sourceChatMid },
			});
			const defaultChatMid = stringValue((response as { defaultChatMid?: unknown }).defaultChatMid);
			markSquareChatAccessible(client, sourceChatMid);
			if (defaultChatMid) return cacheMainChatMid(client, squareMid, defaultChatMid);
		} catch (error) {
			if (pauseSquareChatAccess(client, sourceChatMid, error, "oc-main-chat:livetalk")) {
				return undefined;
			}
			console.warn("[oc-main-chat] getSquareInfoByChatMid failed", {
				squareMid,
				sourceChatMid,
				error: compactError(error),
			});
		}

		try {
			const response = await client.base.square.getSquareChat({ squareChatMid: sourceChatMid });
			markSquareChatAccessible(client, sourceChatMid);
			const chat = (response as {
				squareChat?: { squareMid?: unknown; squareChatMid?: unknown; type?: unknown };
			}).squareChat;
			if (
				stringValue(chat?.squareMid) === squareMid &&
				isMainSquareChatType(chat?.type)
			) {
				return cacheMainChatMid(
					client,
					squareMid,
					stringValue(chat?.squareChatMid) ?? sourceChatMid,
				);
			}
		} catch (error) {
			if (pauseSquareChatAccess(client, sourceChatMid, error, "oc-main-chat:get-chat")) {
				return undefined;
			}
			console.warn("[oc-main-chat] getSquareChat failed", {
				squareMid,
				sourceChatMid,
				error: compactError(error),
			});
		}

		return undefined;
	})().finally(() => {
		requests.delete(squareMid);
	});
	requests.set(squareMid, request);
	return await request;
}

export async function isMainSquareChat(
	client: Client,
	squareMid: string,
	squareChatMid: string | undefined,
): Promise<boolean> {
	if (!squareChatMid) return false;
	const mainChatMid = await resolveMainSquareChatMid(client, squareMid, squareChatMid);
	if (!mainChatMid) {
		console.warn("[oc-left-soon] main chat could not be resolved", {
			squareMid,
			squareChatMid,
		});
		return false;
	}
	return mainChatMid === squareChatMid;
}
