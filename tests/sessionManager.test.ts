import assert from "node:assert/strict";
import test from "node:test";
import { LoginRetryPolicy } from "../src/runtime/lineErrorPolicy.js";
import { SessionManager } from "../src/runtime/sessionManager.js";

test("session manager clears active client and applies retry policy", async () => {
	const controller = new AbortController();
	const active: Array<string | null> = [];
	const waits: number[] = [];
	let createCount = 0;
	const manager = new SessionManager<string>({
		signal: controller.signal,
		stableResetMs: 60_000,
		retryPolicy: new LoginRetryPolicy(
			15_000,
			300_000,
			1_800_000,
			21_600_000,
			3_600_000,
			() => 0.5,
		),
		async create() {
			createCount += 1;
			return `client-${createCount}`;
		},
		async run() {
			throw new Error("temporary network failure");
		},
		onActiveChange(value) {
			active.push(value);
		},
		async wait(ms) {
			waits.push(ms);
			if (waits.length === 2) controller.abort();
		},
	});

	await manager.run();
	assert.deepEqual(waits, [15_000, 30_000]);
	assert.deepEqual(active.slice(0, 4), ["client-1", null, "client-2", null]);
	assert.equal(active.at(-1), null);
});
