import assert from "node:assert/strict";
import test from "node:test";
import {
	startMemoryGuard,
	type MemoryPressureSnapshot,
} from "../src/runtime/memoryGuard.js";

function snapshot(ratio: number): MemoryPressureSnapshot {
	return {
		currentBytes: ratio * 1_000,
		limitBytes: 1_000,
		ratio,
		rssBytes: 500,
		heapUsedBytes: 200,
		externalBytes: 50,
		arrayBuffersBytes: 25,
	};
}

test("memory guard triggers once when cgroup usage reaches the threshold", async () => {
	const controller = new AbortController();
	let samples = 0;
	let triggers = 0;
	const triggered = new Promise<void>((resolve) => {
		startMemoryGuard({
			signal: controller.signal,
			thresholdRatio: 0.9,
			intervalMs: 1_000,
			readSnapshot: async () => snapshot(++samples === 1 ? 0.89 : 0.9),
			onThreshold() {
				triggers += 1;
				resolve();
			},
		});
	});
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	await triggered;
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	controller.abort();
	assert.equal(triggers, 1);
});

test("memory guard stops without triggering when aborted", async () => {
	const controller = new AbortController();
	let triggers = 0;
	startMemoryGuard({
		signal: controller.signal,
		thresholdRatio: 0.9,
		intervalMs: 1_000,
		readSnapshot: async () => snapshot(0.5),
		onThreshold() {
			triggers += 1;
		},
	});
	controller.abort();
	await new Promise((resolve) => setTimeout(resolve, 1_050));
	assert.equal(triggers, 0);
});
