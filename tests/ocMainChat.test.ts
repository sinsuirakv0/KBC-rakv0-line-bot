import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@evex/linejs";
import {
	isMainSquareChat,
	resolveMainSquareChatMid,
} from "../src/moderation/ocMainChat.js";

function mockClient(input: {
	defaultChatMid?: string;
	chat?: { squareMid: string; squareChatMid: string; type: string | number };
}): Client {
	return {
		base: {
			livetalk: {
				async getSquareInfoByChatMid() {
					if (!input.defaultChatMid) throw new Error("livetalk unavailable");
					return { defaultChatMid: input.defaultChatMid };
				},
			},
			square: {
				async getSquareChat() {
					if (!input.chat) throw new Error("chat unavailable");
					return { squareChat: input.chat };
				},
			},
		},
	} as unknown as Client;
}

test("resolves the main OpenChat from a known subchat", async () => {
	const client = mockClient({ defaultChatMid: "m-main-1" });

	assert.equal(
		await resolveMainSquareChatMid(client, "s-main-1", "m-sub-1"),
		"m-main-1",
	);
});

test("recognizes a known chat as the main OpenChat without listing joined chats", async () => {
	const client = mockClient({
		chat: {
			squareMid: "s-main-2",
			squareChatMid: "m-main-2",
			type: "SQUARE_DEFAULT",
		},
	});

	assert.equal(await isMainSquareChat(client, "s-main-2", "m-main-2"), true);
});

test("does not repeatedly resolve a chat after a membership error", async () => {
	let livetalkCalls = 0;
	let squareCalls = 0;
	const client = {
		base: {
			livetalk: {
				async getSquareInfoByChatMid() {
					livetalkCalls += 1;
					throw new Error("このオープンチャットのメンバーではありません");
				},
			},
			square: {
				async getSquareChat() {
					squareCalls += 1;
					throw new Error("unexpected request");
				},
			},
		},
	} as unknown as Client;

	assert.equal(await resolveMainSquareChatMid(client, "s-old", "m-old"), undefined);
	assert.equal(await resolveMainSquareChatMid(client, "s-old", "m-old"), undefined);
	assert.equal(livetalkCalls, 1);
	assert.equal(squareCalls, 0);
});
