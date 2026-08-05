import assert from "node:assert/strict";
import test from "node:test";
import {
	formatOcMuteRemaining,
	formatOcMuteUntil,
	parseOcMuteExpiration,
} from "../src/moderation/ocMute.js";

const NOW = Date.UTC(2026, 7, 6, 14, 30); // 2026/08/06 23:30 JST

function parsed(value: string) {
	const result = parseOcMuteExpiration(value, NOW);
	if (!result.ok) throw new Error(result.error);
	return result;
}

test("parses numeric mute duration as minutes", () => {
	assert.equal(parsed("170").expiresAt, "2026-08-06T17:20:00.000Z");
	assert.equal(parsed("１７０").expiresAt, "2026-08-06T17:20:00.000Z");
});

test("parses a time-only mute deadline as the next JST time", () => {
	assert.equal(parsed("0:17").expiresAt, "2026-08-06T15:17:00.000Z");
	assert.equal(parsed("23:45").expiresAt, "2026-08-06T14:45:00.000Z");
});

test("parses JST date-only and date-time mute deadlines", () => {
	assert.equal(parsed("8/7").expiresAt, "2026-08-06T15:00:00.000Z");
	assert.equal(parsed("8/7-0:17").expiresAt, "2026-08-06T15:17:00.000Z");
	assert.equal(parsed("2026/8/7 0:17").expiresAt, "2026-08-06T15:17:00.000Z");
});

test("supports infinite mute and rejects expired or invalid deadlines", () => {
	assert.equal(parsed("inf").expiresAt, undefined);
	assert.equal(parsed("infinity").expiresAt, undefined);
	assert.equal(parseOcMuteExpiration("8/6", NOW).ok, false);
	assert.equal(parseOcMuteExpiration("8/7-24:00", NOW).ok, false);
	assert.equal(parseOcMuteExpiration("0", NOW).ok, false);
});

test("formats finite and infinite mute duration for warnings and lists", () => {
	const finite = { expiresAt: "2026-08-06T17:20:00.000Z" };
	assert.equal(formatOcMuteRemaining(finite, NOW), "2時間50分");
	assert.equal(formatOcMuteUntil(finite), "2026/08/07 02:20まで");
	assert.equal(formatOcMuteRemaining({}, NOW), "無期限");
	assert.equal(formatOcMuteUntil({}), "無期限");
});
