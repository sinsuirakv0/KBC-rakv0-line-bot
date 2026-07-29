import assert from "node:assert/strict";
import test from "node:test";

import {
	applyTalkSyncResponse,
	classifyTalkSyncGone,
} from "../src/runtime/talkSync.js";

test("Talk sync response advances every cursor", () => {
	const cursor = {
		revision: 1,
		globalRev: 2,
		individualRev: 3,
	};
	const events = applyTalkSyncResponse(cursor, {
		fullSyncResponse: { nextRevision: 10 },
		operationResponse: {
			globalEvents: { lastRevision: 20 },
			individualEvents: { lastRevision: 30 },
			operations: [
				{ type: "RECEIVE_MESSAGE", revision: 11 },
				{ type: "NOTIFIED_READ_MESSAGE", revision: 12 },
			],
		},
	});

	assert.equal(events.length, 2);
	assert.deepEqual(cursor, {
		revision: 12,
		globalRev: 20,
		individualRev: 30,
	});
});

test("Talk full sync continues from one revision before nextRevision", () => {
	const cursor = {
		revision: 0,
		globalRev: 0,
		individualRev: 0,
	};
	applyTalkSyncResponse(cursor, {
		fullSyncResponse: { nextRevision: 100n },
	});

	assert.equal(cursor.revision, 99n);
});

test("Talk sync HTTP 410 distinguishes expiry, cursor rejection, and stalls", () => {
	assert.equal(classifyTalkSyncGone(5_100, 5_000, 15_000), "poll-expired");
	assert.equal(classifyTalkSyncGone(200, 5_000, 15_000), "cursor-rejected");
	assert.equal(classifyTalkSyncGone(110_000, 5_000, 15_000), "stalled");
});
