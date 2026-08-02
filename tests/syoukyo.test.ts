import assert from "node:assert/strict";
import test from "node:test";
import {
	isGeneralSquareRole,
	messageTargetsFromEvent,
	parseEmergencyTargetMid,
} from "../src/commands/syoukyo.js";

test("syoukyo accepts only the remote member-purge syntax", () => {
	assert.equal(parseEmergencyTargetMid(["men", "m-target"]), "m-target");
	assert.equal(parseEmergencyTargetMid(["mes", "m-target"]), "m-target");
	assert.equal(parseEmergencyTargetMid(["men", "talkID:m-target"]), "m-target");
	assert.equal(parseEmergencyTargetMid(["men", "s-square"]), undefined);
	assert.equal(parseEmergencyTargetMid(["men", "m-target", "extra"]), undefined);
	assert.equal(parseEmergencyTargetMid(["other", "m-target"]), undefined);
});

test("syoukyo selects only general OpenChat members", () => {
	assert.equal(isGeneralSquareRole("MEMBER"), true);
	assert.equal(isGeneralSquareRole(10), true);
	assert.equal(isGeneralSquareRole("10"), true);
	assert.equal(isGeneralSquareRole("CO_ADMIN"), false);
	assert.equal(isGeneralSquareRole(2), false);
	assert.equal(isGeneralSquareRole("ADMIN"), false);
	assert.equal(isGeneralSquareRole(1), false);
});

test("syoukyo message cleanup includes bot replies and thread messages", () => {
	const targetChatMid = "m-target";
	const event = {
		createdTime: 2_000,
		payload: {
			receiveMessage: {
				squareChatMid: targetChatMid,
				squareMessage: { message: { id: "user-message", createdTime: 2_000 } },
			},
			sendMessage: {
				squareChatMid: targetChatMid,
				squareMessage: { message: { id: "bot-reply", createdTime: 2_000 } },
			},
			notificationThreadMessage: {
				chatMid: targetChatMid,
				threadMid: "thread-1",
				squareMessage: { message: { id: "thread-message", createdTime: 2_000 } },
			},
		},
	};
	assert.deepEqual(messageTargetsFromEvent(event, targetChatMid, 1_000), [
		{ messageId: "user-message", threadMid: "" },
		{ messageId: "bot-reply", threadMid: "" },
		{ messageId: "thread-message", threadMid: "thread-1" },
	]);
	assert.deepEqual(messageTargetsFromEvent(event, targetChatMid, 3_000), []);
	assert.deepEqual(messageTargetsFromEvent(event, "m-other", 1_000), []);
});
