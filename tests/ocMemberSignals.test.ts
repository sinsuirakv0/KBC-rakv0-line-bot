import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@evex/linejs";
import {
	OpenChatMemberSignalDispatcher,
	type OpenChatMemberSignal,
	type OpenChatMemberSignalHandlers,
} from "../src/moderation/ocMemberSignals.js";

const client = {} as Client;

function joinSignal(
	at: number,
	origin: OpenChatMemberSignal["origin"] = "square-receiver",
): OpenChatMemberSignal {
	return {
		type: "join",
		origin,
		event: {
			client,
			squareMid: "s-test",
			squareChatMid: "m-test",
			memberMid: "p-test",
			displayName: "member",
			joinedAt: at,
			source: "chat-member",
		},
	};
}

function leaveSignal(at: number): OpenChatMemberSignal {
	return {
		type: "leave",
		origin: "chat-poll",
		event: {
			client,
			squareMid: "s-test",
			squareChatMid: "m-test",
			memberMid: "p-test",
			displayName: "member",
			leftAt: at,
			source: "chat-member",
		},
	};
}

function handlers(events: string[]): OpenChatMemberSignalHandlers {
	return {
		async record(signal) {
			events.push(`record:${signal.type}`);
		},
		async track(signal, suppressed) {
			events.push(`track:${signal.type}:${suppressed}`);
		},
		async notify(signal) {
			events.push(`notify:${signal.type}`);
		},
	};
}

test("deduplicates the same member transition across receiver origins", async () => {
	const events: string[] = [];
	const dispatcher = new OpenChatMemberSignalDispatcher(handlers(events));
	const at = Date.now();

	assert.equal(await dispatcher.publish(joinSignal(at, "square-receiver")), "processed");
	assert.equal(await dispatcher.publish(joinSignal(at + 1_000, "chat-poll")), "duplicate");
	assert.equal(events.filter((event) => event.startsWith("track:")).length, 1);
	assert.equal(events.filter((event) => event.startsWith("notify:")).length, 1);
});

test("keeps join and leave processing ordered for the same member", async () => {
	const events: string[] = [];
	const dispatcher = new OpenChatMemberSignalDispatcher({
		async record() {},
		async track(signal) {
			if (signal.type === "join") {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			events.push(`track:${signal.type}`);
		},
		async notify(signal) {
			events.push(`notify:${signal.type}`);
		},
	});
	const at = Date.now();

	await Promise.all([
		dispatcher.publish(joinSignal(at)),
		dispatcher.publish(leaveSignal(at + 5_000)),
	]);
	assert.deepEqual(new Set(events), new Set([
		"notify:join",
		"track:join",
		"notify:leave",
		"track:leave",
	]));
	const lastJoinIndex = Math.max(events.indexOf("notify:join"), events.indexOf("track:join"));
	const firstLeaveIndex = Math.min(events.indexOf("notify:leave"), events.indexOf("track:leave"));
	assert.equal(lastJoinIndex < firstLeaveIndex, true);
});

test("still sends the configured member message when tracking fails", async () => {
	const events: string[] = [];
	const dispatcher = new OpenChatMemberSignalDispatcher({
		async record() {},
		async track() {
			throw new Error("tracking failed");
		},
		async notify(signal) {
			events.push(`notify:${signal.type}`);
		},
	});

	assert.equal(await dispatcher.publish(joinSignal(Date.now())), "processed");
	assert.deepEqual(events, ["notify:join"]);
});

test("restores replayed signals without running notifications", async () => {
	const events: string[] = [];
	const dispatcher = new OpenChatMemberSignalDispatcher(handlers(events));
	const signal = joinSignal(Date.now() - 60_000);
	signal.ignoreBefore = Date.now();

	await dispatcher.publish(signal);
	assert.equal(events.includes("track:join:true"), true);
	assert.equal(events.some((event) => event.startsWith("notify:")), false);
});
