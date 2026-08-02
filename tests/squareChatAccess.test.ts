import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@evex/linejs";
import {
	isSquareChatAccessPaused,
	isSquareChatMembershipError,
	markSquareChatAccessible,
	pauseSquareChatAccess,
} from "../src/runtime/squareChatAccess.js";

function clientStub(): Client {
	return {} as Client;
}

test("membership errors pause only the affected client and chat", () => {
	const client = clientStub();
	const otherClient = clientStub();
	const error = new Error("このオープンチャットのメンバーではありません");

	assert.equal(pauseSquareChatAccess(client, "m-chat", error, "test", 1_000, 10_000), true);
	assert.equal(isSquareChatAccessPaused(client, "m-chat", 10_500), true);
	assert.equal(isSquareChatAccessPaused(client, "m-other", 10_500), false);
	assert.equal(isSquareChatAccessPaused(otherClient, "m-chat", 10_500), false);
	assert.equal(isSquareChatAccessPaused(client, "m-chat", 11_001), false);
});

test("successful activity immediately clears a pause", () => {
	const client = clientStub();
	pauseSquareChatAccess(
		client,
		"m-chat",
		new Error("NOT_A_MEMBER"),
		"test",
		10_000,
		20_000,
	);

	markSquareChatAccessible(client, "m-chat");

	assert.equal(isSquareChatAccessPaused(client, "m-chat", 20_001), false);
});

test("unrelated errors do not pause a chat", () => {
	const client = clientStub();
	const error = new Error("status=500");

	assert.equal(isSquareChatMembershipError(error), false);
	assert.equal(pauseSquareChatAccess(client, "m-chat", error, "test"), false);
	assert.equal(isSquareChatAccessPaused(client, "m-chat"), false);
});
