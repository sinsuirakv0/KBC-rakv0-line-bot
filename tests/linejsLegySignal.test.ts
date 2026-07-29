import assert from "node:assert/strict";
import test from "node:test";

import { LegyEncryptedTransport } from "../node_modules/@evex/linejs/base/request/legy.js";

test("LEGY transport forwards the original abort signal", async () => {
	const controller = new AbortController();
	const request = new Request("https://legy.line-apps.com/SYNC4", {
		method: "POST",
		headers: {
			"x-line-access": "test-token",
			"x-lpv": "1",
		},
		signal: controller.signal,
		body: new Uint8Array([1, 2, 3]),
	});
	let forwardedSignal: AbortSignal | undefined;
	const transport = new LegyEncryptedTransport();

	await transport.fetch(
		request,
		async (outerRequest) => {
			forwardedSignal = outerRequest.signal;
			return new Response(null, { status: 200 });
		},
		{
			application: "TEST\t1.0\tTEST\t1.0",
			userAgent: "Line/1.0",
		},
	);

	assert.ok(forwardedSignal);
	assert.equal(forwardedSignal.aborted, false);
	controller.abort();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(forwardedSignal.aborted, true);
});
