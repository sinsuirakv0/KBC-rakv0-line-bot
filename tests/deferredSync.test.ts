import assert from "node:assert/strict";
import test from "node:test";
import { DeferredSync } from "../src/storage/deferredSync.js";

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("deferred sync does not block the caller and coalesces changes made while running", async () => {
	const releases: Array<() => void> = [];
	let calls = 0;
	const sync = new DeferredSync({
		label: "test",
		operation: async () => {
			calls += 1;
			await new Promise<void>((resolve) => releases.push(resolve));
		},
	});

	sync.schedule();
	await nextTurn();
	assert.equal(calls, 1);

	sync.schedule();
	assert.equal(calls, 1);
	releases.shift()?.();
	await nextTurn();
	assert.equal(calls, 2);

	releases.shift()?.();
	await nextTurn();
	assert.equal(calls, 2);
});
