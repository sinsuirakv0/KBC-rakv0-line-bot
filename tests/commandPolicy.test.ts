import assert from "node:assert/strict";
import test from "node:test";
import { botCommand } from "../src/commands/bot.js";
import { getLineCommandPolicy } from "../src/commands/index.js";
import type {
	CommandContext,
	CommandProgress,
	ReplyableLineMessage,
} from "../src/commands/shared.js";

test("bot status bypasses progress while benchmark stays normal priority", () => {
	assert.deepEqual(getLineCommandPolicy("!bot status"), {
		priority: "high",
		progress: "none",
	});
	assert.deepEqual(getLineCommandPolicy("!bot status test heavy"), {
		priority: "normal",
		progress: "auto",
	});
	assert.deepEqual(getLineCommandPolicy("!help"), {
		priority: "normal",
		progress: "none",
	});
});

test("bot status renders without starting a LINE or GitHub operation", async () => {
	const sent: string[] = [];
	const message: ReplyableLineMessage = {
		async reply(text) {
			sent.push(text);
			return "message-id";
		},
		async send(text) {
			sent.push(text);
			return "message-id";
		},
		async sendImage() {},
		client: {} as never,
		destination: {
			kind: "square",
			chatMid: "m-test",
			scopeMid: "s-test",
			chatType: "SQUARE",
			senderMid: "p-test",
			encrypted: false,
		},
		mentionMids: [],
	};
	const progress: CommandProgress = {
		async update() {
			return undefined;
		},
		async finish() {},
		detach() {},
	};
	const context: CommandContext = {
		message,
		command: "bot",
		args: ["status"],
		rawText: "!bot status",
		body: "bot status",
		progress,
	};

	await botCommand.execute(context);
	assert.equal(sent.length, 1);
	assert.ok(sent[0]?.startsWith("bot status\n"));
});
