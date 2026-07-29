import assert from "node:assert/strict";
import test from "node:test";
import { ReceiverSupervisor } from "../src/runtime/receiverSupervisor.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

test("restarts only the requested receiver", async () => {
	const parent = new AbortController();
	let starts = 0;
	const supervisor = new ReceiverSupervisor({
		name: "talk",
		parentSignal: parent.signal,
		retryDelayMs: 1,
		async run(signal) {
			starts += 1;
			await waitForAbort(signal);
		},
	});
	const running = supervisor.run();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(supervisor.restart(new Error("stale")), true);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(starts, 2);
	parent.abort();
	await running;
});
