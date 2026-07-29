import assert from "node:assert/strict";
import test from "node:test";

import {
	listenTalkPushEvents,
	type TalkPushTransport,
} from "../src/runtime/talkPushReceiver.js";

function createTransport<T>() {
	let streamController!: ReadableStreamDefaultController<T>;
	let finishConnection!: () => void;
	let closeCount = 0;
	const stream = new ReadableStream<T>({
		start(controller) {
			streamController = controller;
		},
	});
	const connectionFinished = new Promise<void>((resolve) => {
		finishConnection = resolve;
	});
	const transport: TalkPushTransport<T> = {
		currPingId: 0,
		opStream: {
			stream,
			renew() {},
		},
		async initializeConn() {
			return {
				close() {
					closeCount += 1;
					finishConnection();
				},
			};
		},
		async InitAndRead() {
			await connectionFinished;
		},
	};
	return {
		transport,
		enqueue(event: T) {
			streamController.enqueue(event);
		},
		get closeCount() {
			return closeCount;
		},
	};
}

test("Talk push receiver dispatches events and closes on abort", async () => {
	const fake = createTransport<{ type: string }>();
	const controller = new AbortController();
	const events: string[] = [];
	let heartbeatEvents = 0;
	let resolveReceived!: () => void;
	const received = new Promise<void>((resolve) => {
		resolveReceived = resolve;
	});
	const receiver = listenTalkPushEvents({
		push: fake.transport,
		signal: controller.signal,
		staleMs: 1_000,
		heartbeatIntervalMs: 10,
		onEvent(event) {
			events.push(event.type);
			resolveReceived();
		},
		onHeartbeat(count) {
			heartbeatEvents += count;
		},
	});

	fake.enqueue({ type: "RECEIVE_MESSAGE" });
	await received;
	controller.abort();
	await receiver;

	assert.deepEqual(events, ["RECEIVE_MESSAGE"]);
	assert.equal(heartbeatEvents, 1);
	assert.equal(fake.closeCount, 1);
});

test("Talk push receiver rejects a stale connection", async () => {
	const fake = createTransport<never>();
	const controller = new AbortController();

	await assert.rejects(
		listenTalkPushEvents({
			push: fake.transport,
			signal: controller.signal,
			staleMs: 20,
			heartbeatIntervalMs: 5,
			onEvent() {},
			onHeartbeat() {},
		}),
		/Talk push heartbeat became stale/,
	);

	assert.equal(fake.closeCount, 1);
});
