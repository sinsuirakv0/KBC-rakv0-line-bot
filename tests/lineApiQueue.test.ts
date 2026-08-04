import assert from "node:assert/strict";
import test from "node:test";
import {
	LineApiQueue,
	LineApiQueuePausedError,
} from "../src/runtime/lineApiQueue.js";

test("LINE API queue serializes one scope in critical, high, normal order", async () => {
	const queue = new LineApiQueue();
	const order: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const first = queue.run("first", async () => {
		order.push("first:start");
		await firstGate;
		order.push("first:end");
	});
	const normal = queue.run("normal", async () => {
		order.push("normal");
	});
	const high = queue.run("high", async () => {
		order.push("high");
	}, "high");
	const critical = queue.run("critical", async () => {
		order.push("critical");
	}, "critical");
	releaseFirst();
	await Promise.all([first, normal, high, critical]);
	assert.deepEqual(order, ["first:start", "first:end", "critical", "high", "normal"]);
});

test("critical work uses the reserved slot while ordinary work waits", async () => {
	const queue = new LineApiQueue();
	let releaseBlocked!: () => void;
	let startedBlocked!: () => void;
	const blockedStarted = new Promise<void>((resolve) => {
		startedBlocked = resolve;
	});
	const blockedGate = new Promise<void>((resolve) => {
		releaseBlocked = resolve;
	});
	const blocked = queue.run("blocked", async () => {
		startedBlocked();
		await blockedGate;
	}, { scope: "test:blocked" });
	await blockedStarted;

	let ordinaryRan = false;
	const ordinary = queue.run("ordinary", async () => {
		ordinaryRan = true;
	}, { scope: "test:independent" });
	let criticalRan = false;
	await queue.run("notification", async () => {
		criticalRan = true;
	}, { priority: "critical", scope: "notification:test" });
	assert.equal(criticalRan, true);
	assert.equal(ordinaryRan, false);

	releaseBlocked();
	await Promise.all([blocked, ordinary]);
	assert.equal(ordinaryRan, true);
});

test("paused queue rejects pending work and accepts work after resume", async () => {
	const queue = new LineApiQueue();
	let releaseFirst!: () => void;
	let markFirstStarted!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	const first = queue.run("first", async () => {
		markFirstStarted();
		await firstGate;
	});
	await firstStarted;
	const pending = queue.run("pending", async () => {
		throw new Error("pending work must not run");
	});
	queue.pause("account-restricted");
	await assert.rejects(pending, LineApiQueuePausedError);
	await assert.rejects(
		async () => queue.run("blocked", async () => undefined),
		LineApiQueuePausedError,
	);
	releaseFirst();
	await first;
	queue.resume();
	let ran = false;
	await queue.run("after-resume", async () => {
		ran = true;
	});
	assert.equal(ran, true);
});
