import assert from "node:assert/strict";
import test from "node:test";
import { appConfig } from "../src/config.js";
import { fixedOcPollingDecision } from "../src/runtime/ocPollingPolicy.js";

test("OC member-event polling always uses the fixed two-second interval", () => {
	const decision = fixedOcPollingDecision();
	assert.equal(decision.mode, "fixed");
	assert.equal(decision.intervalMs, appConfig.ocMemberPollIntervalMs);
	assert.equal(decision.intervalMs, 2_000);
});

test("runtime keeps Talk disabled in OpenChat-only mode", () => {
	assert.equal(appConfig.enableTalk, false);
});
