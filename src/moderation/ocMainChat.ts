import type { Client } from "@evex/linejs";

const MAIN_CHAT_CACHE_MS = 6 * 60 * 60_000;

const mainChatMidCache = new Map<string, { chatMid: string; expiresAt: number }>();
const mainChatResolutionRequests = new Map<string, Promise<string | undefined>>();

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

function cacheMainChatMid(squareMid: string, chatMid: string): string {
	mainChatMidCache.set(squareMid, {
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
	const cached = mainChatMidCache.get(squareMid);
	if (cached && cached.expiresAt > Date.now()) return cached.chatMid;
	if (!sourceChatMid) return undefined;

	const running = mainChatResolutionRequests.get(squareMid);
	if (running) return await running;
	const request = (async () => {
		try {
			const response = await client.base.livetalk.getSquareInfoByChatMid({
				request: { squareChatMid: sourceChatMid },
			});
			const defaultChatMid = stringValue((response as { defaultChatMid?: unknown }).defaultChatMid);
			if (defaultChatMid) return cacheMainChatMid(squareMid, defaultChatMid);
		} catch (error) {
			console.warn("[oc-main-chat] getSquareInfoByChatMid failed", {
				squareMid,
				sourceChatMid,
				error: compactError(error),
			});
		}

		try {
			const response = await client.base.square.getSquareChat({ squareChatMid: sourceChatMid });
			const chat = (response as {
				squareChat?: { squareMid?: unknown; squareChatMid?: unknown; type?: unknown };
			}).squareChat;
			if (
				stringValue(chat?.squareMid) === squareMid &&
				isMainSquareChatType(chat?.type)
			) {
				return cacheMainChatMid(
					squareMid,
					stringValue(chat?.squareChatMid) ?? sourceChatMid,
				);
			}
		} catch (error) {
			console.warn("[oc-main-chat] getSquareChat failed", {
				squareMid,
				sourceChatMid,
				error: compactError(error),
			});
		}

		return undefined;
	})().finally(() => {
		mainChatResolutionRequests.delete(squareMid);
	});
	mainChatResolutionRequests.set(squareMid, request);
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
