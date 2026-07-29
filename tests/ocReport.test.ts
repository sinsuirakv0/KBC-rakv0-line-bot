import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@evex/linejs";
import { reportOcMessage } from "../src/moderation/ocReport.js";

test("reports the exact OpenChat message with the selected reason", async () => {
	let request: unknown;
	const client = {
		base: {
			square: {
				async reportSquareMessage(input: unknown) {
					request = input;
					return {};
				},
			},
		},
	} as unknown as Client;

	await reportOcMessage(client, {
		squareMid: "s-test",
		squareChatMid: "m-test",
		messageId: "message-test",
		reportType: "SCAM",
		otherReason: "danger word",
		threadMid: "thread-test",
	});

	assert.deepEqual(request, {
		request: {
			squareMid: "s-test",
			squareChatMid: "m-test",
			squareMessageId: "message-test",
			reportType: "SCAM",
			otherReason: "danger word",
			threadMid: "thread-test",
		},
	});
});
