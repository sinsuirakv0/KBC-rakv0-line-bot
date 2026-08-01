import assert from "node:assert/strict";
import test from "node:test";
import { appConfig } from "../src/config.js";
import { OcPollingActivityTracker } from "../src/runtime/ocPollingPolicy.js";

const SQUARE_MID = "s00000000000000000000000000000000";

function addActiveMessages(
	tracker: OcPollingActivityTracker,
	now: number,
): void {
	for (let index = 0; index < appConfig.ocMemberPollQuietMessageThreshold; index++) {
		tracker.recordMessage(SQUARE_MID, now - index * 1_000);
	}
}

test("disabled OC features always use the inactive interval", () => {
	const tracker = new OcPollingActivityTracker();
	const now = Date.parse("2026-08-03T12:00:00+09:00");
	tracker.recordCommand(SQUARE_MID, now);
	const decision = tracker.decision(SQUARE_MID, false, now);
	assert.equal(decision.mode, "inactive");
	assert.equal(decision.intervalMs, appConfig.ocMemberPollInactiveMs);
	assert.equal(decision.energySaving, true);
});

test("a command enables the five-minute active boost during weekday eco time", () => {
	const tracker = new OcPollingActivityTracker();
	const now = Date.parse("2026-08-03T12:00:00+09:00");
	tracker.recordCommand(SQUARE_MID, now - 1_000);
	const decision = tracker.decision(SQUARE_MID, true, now);
	assert.equal(decision.mode, "command-boost");
	assert.equal(decision.intervalMs, appConfig.ocMemberPollActiveMs);
	assert.equal(decision.energySaving, false);
});

test("weekday 00:00 through 14:59 JST uses eco mode", () => {
	const tracker = new OcPollingActivityTracker();
	const now = Date.parse("2026-08-03T14:59:59+09:00");
	addActiveMessages(tracker, now);
	const decision = tracker.decision(SQUARE_MID, true, now);
	assert.equal(decision.mode, "weekday-eco");
	assert.equal(decision.intervalMs, appConfig.ocMemberPollEcoMs);
});

test("quiet OC uses eco mode outside the weekday period", () => {
	const tracker = new OcPollingActivityTracker();
	const now = Date.parse("2026-08-02T20:00:00+09:00");
	const decision = tracker.decision(SQUARE_MID, true, now);
	assert.equal(decision.mode, "quiet-eco");
	assert.equal(decision.intervalMs, appConfig.ocMemberPollEcoMs);
});

test("active OC uses the active interval outside the weekday period", () => {
	const tracker = new OcPollingActivityTracker();
	const now = Date.parse("2026-08-02T20:00:00+09:00");
	addActiveMessages(tracker, now);
	const decision = tracker.decision(SQUARE_MID, true, now);
	assert.equal(decision.mode, "active");
	assert.equal(decision.intervalMs, appConfig.ocMemberPollActiveMs);
	assert.equal(decision.energySaving, false);
});
