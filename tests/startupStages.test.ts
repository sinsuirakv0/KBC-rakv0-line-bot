import assert from "node:assert/strict";
import test from "node:test";
import { runStartupStages } from "../src/runtime/startupStages.js";

test("startup stages preserve stage order and cap concurrency", async () => {
	let active = 0;
	let maxActive = 0;
	const events: string[] = [];
	const task = (name: string) => ({
		name,
		async initialize() {
			active += 1;
			maxActive = Math.max(maxActive, active);
			events.push(`start:${name}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
			events.push(`end:${name}`);
			active -= 1;
		},
	});

	await runStartupStages([
		{ name: "core", tasks: [task("a"), task("b"), task("c")] },
		{ name: "logs", tasks: [task("d")] },
	], { concurrency: 2, pauseMs: 0 });

	assert.equal(maxActive, 2);
	assert.ok(events.indexOf("start:d") > events.indexOf("end:c"));
});
