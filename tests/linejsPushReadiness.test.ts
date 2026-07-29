import assert from "node:assert/strict";
import test from "node:test";

import { Conn } from "../node_modules/@evex/linejs/base/push/conn.js";

test("linejs PUSH waits for a delayed response stream", async () => {
	const conn = new Conn({
		log() {},
	} as never);
	const startedAt = Date.now();
	setTimeout(() => {
		conn.resStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	}, 700);

	await conn.read();

	const elapsedMs = Date.now() - startedAt;
	assert.ok(elapsedMs >= 600);
	assert.ok(elapsedMs < 3_000);
});
