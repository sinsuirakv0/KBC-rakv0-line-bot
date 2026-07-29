import assert from "node:assert/strict";
import test from "node:test";
import {
	clearSquareReadReceiptsForTest,
	listSquareReadReceipts,
	recordSquareReadReceiptFromEvent,
	uniqueSquareReadReceipts,
} from "../src/runtime/squareReadReceipts.js";

test("records OpenChat read receipts from numeric SquareEvent", () => {
	clearSquareReadReceiptsForTest();
	const receipt = recordSquareReadReceiptFromEvent({
		createdTime: 1_000,
		type: 6,
		payload: {
			notifiedMarkAsRead: {
				squareChatMid: "m-chat",
				sMemberMid: "p-reader",
				messageId: "msg-1",
			},
		},
	}, 2_000);

	assert.deepEqual(receipt, {
		receivedAt: 2_000,
		eventCreatedAt: 1_000,
		squareChatMid: "m-chat",
		memberMid: "p-reader",
		messageId: "msg-1",
	});
	assert.equal(listSquareReadReceipts({
		squareChatMid: "m-chat",
		messageId: "msg-1",
	}, 2_500).length, 1);
});

test("deduplicates read receipts by member mid", () => {
	clearSquareReadReceiptsForTest();
	for (const receivedAt of [1_000, 2_000]) {
		recordSquareReadReceiptFromEvent({
			type: "NOTIFIED_MARK_AS_READ",
			payload: {
				notifiedMarkAsRead: {
					squareChatMid: "m-chat",
					sMemberMid: "p-reader",
					messageId: "msg-1",
				},
			},
		}, receivedAt);
	}

	const unique = uniqueSquareReadReceipts(listSquareReadReceipts({
		squareChatMid: "m-chat",
		messageId: "msg-1",
	}, 2_500));
	assert.equal(unique.length, 1);
	assert.equal(unique[0]?.receivedAt, 2_000);
});

test("accepts string encoded OpenChat read event type", () => {
	clearSquareReadReceiptsForTest();
	recordSquareReadReceiptFromEvent({
		type: "6",
		payload: {
			notifiedMarkAsRead: {
				squareChatMid: "m-chat",
				sMemberMid: "p-reader",
				messageId: "msg-1",
			},
		},
	}, 2_000);

	assert.equal(listSquareReadReceipts({
		squareChatMid: "m-chat",
		messageId: "msg-1",
	}, 2_500).length, 1);
});
