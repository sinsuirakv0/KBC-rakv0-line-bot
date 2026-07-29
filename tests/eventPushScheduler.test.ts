import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@evex/linejs";
import { startEventPushScheduler } from "../src/eventPush/scheduler.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("event scheduler wakes immediately when a LINE client becomes active", async (context) => {
	const controller = new AbortController();
	context.after(() => controller.abort());
	const client = {} as Client;
	let activeClient: Client | null = null;
	let checks = 0;
	const scheduler = startEventPushScheduler(
		() => activeClient,
		controller.signal,
		{
			intervalMs: 60_000,
			initialDelayMs: 1,
			async check(receivedClient) {
				assert.equal(receivedClient, client);
				checks += 1;
			},
		},
	);

	await delay(10);
	assert.equal(checks, 0);

	activeClient = client;
	scheduler.wake();
	await delay(10);
	assert.equal(checks, 1);
});
