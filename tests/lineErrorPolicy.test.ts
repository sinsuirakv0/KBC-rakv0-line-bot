import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyLineError,
	LoginRetryPolicy,
} from "../src/runtime/lineErrorPolicy.js";

test("classifies idle HTTP 410 separately from authentication failures", () => {
	assert.equal(classifyLineError(new Error("sync failed: status=410")).kind, "http-gone");
	assert.equal(classifyLineError(new Error("sync failed: status=410")).authRelated, false);
});

test("classifies permanent and rate-limited login failures", () => {
	assert.equal(
		classifyLineError(new Error("INVALID_IDENTITY_CREDENTIAL: Account ID or password is invalid")).kind,
		"auth-invalid",
	);
	assert.equal(classifyLineError(new Error("INVALID_AUTH_TOKEN")).kind, "auth-invalid");
	assert.equal(
		classifyLineError(new Error("AUTHENTICATION_FAILED: suspended user")).kind,
		"account-restricted",
	);
	assert.equal(classifyLineError(new Error("EXCESSIVE_ACCESS")).kind, "rate-limited");
	assert.equal(classifyLineError(new Error("EXCESSIVE_ACCESS")).authRelated, false);
});

test("login retry policy backs off permanent failures", () => {
	const policy = new LoginRetryPolicy(
		15_000,
		5 * 60_000,
		30 * 60_000,
		6 * 60 * 60_000,
		60 * 60_000,
		() => 0.5,
	);
	assert.equal(policy.next(new Error("temporary network failure")).delayMs, 15_000);
	assert.equal(policy.next(new Error("temporary network failure")).delayMs, 30_000);
	assert.equal(
		policy.next(new Error("INVALID_IDENTITY_CREDENTIAL: password is invalid")).delayMs,
		30 * 60_000,
	);
});
