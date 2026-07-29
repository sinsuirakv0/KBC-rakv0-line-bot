import assert from "node:assert/strict";
import test from "node:test";
import { lineApiQueue } from "../src/runtime/lineApiQueue.js";

test("LINE API queue serializes operations and lets queued high priority work go first", async () => {
	const order: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const first = lineApiQueue.run("first", async () => {
		order.push("first:start");
		await firstGate;
		order.push("first:end");
	});
	const normal = lineApiQueue.run("normal", async () => {
		order.push("normal");
	});
	const high = lineApiQueue.run("high", async () => {
		order.push("high");
	}, "high");
	releaseFirst();
	await Promise.all([first, normal, high]);
	assert.deepEqual(order, ["first:start", "first:end", "high", "normal"]);
});

test("a stalled destination does not block an independent destination", async () => {
	let releaseBlocked!: () => void;
	let startedBlocked!: () => void;
	const blockedStarted = new Promise<void>((resolve) => {
		startedBlocked = resolve;
	});
	const blockedGate = new Promise<void>((resolve) => {
		releaseBlocked = resolve;
	});
	const blocked = lineApiQueue.run("blocked", async () => {
		startedBlocked();
		await blockedGate;
	}, { scope: "test:blocked" });
	await blockedStarted;

	let independentRan = false;
	await lineApiQueue.run("independent", async () => {
		independentRan = true;
	}, { scope: "test:independent" });
	assert.equal(independentRan, true);

	releaseBlocked();
	await blocked;
});
