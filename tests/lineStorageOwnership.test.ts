import assert from "node:assert/strict";
import test from "node:test";

import { classifySquareSyncOwner } from "../src/storage/lineStorage.js";

test("Square sync ownership resets unknown and changed accounts", () => {
	assert.equal(classifySquareSyncOwner(undefined, "u-current"), "initialized");
	assert.equal(classifySquareSyncOwner("u-old", "u-current"), "changed");
	assert.equal(classifySquareSyncOwner("u-current", "u-current"), "confirmed");
});
