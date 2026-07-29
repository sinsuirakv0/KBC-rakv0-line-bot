import assert from "node:assert/strict";
import test from "node:test";
import { GithubContentsClient } from "../src/storage/githubContents.js";

test("GitHub writes retry transient server errors", async () => {
	const originalFetch = globalThis.fetch;
	const methods: string[] = [];
	let call = 0;
	globalThis.fetch = (async (_input, init) => {
		methods.push(init?.method ?? "GET");
		call += 1;
		if (call === 1) return new Response("temporary", { status: 500 });
		return Response.json({ content: { sha: "next-sha" } }, { status: 201 });
	}) as typeof fetch;
	try {
		const client = new GithubContentsClient();
		assert.equal(await client.write("test.json", "{}", "test"), "next-sha");
		assert.deepEqual(methods, ["PUT", "PUT"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("GitHub conflict retry uses the latest remote sha", async () => {
	const originalFetch = globalThis.fetch;
	const putBodies: Array<Record<string, unknown>> = [];
	let call = 0;
	globalThis.fetch = (async (_input, init) => {
		call += 1;
		if (init?.method === "PUT") {
			putBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			if (call === 1) return new Response("conflict", { status: 409 });
			return Response.json({ content: { sha: "new-sha" } }, { status: 201 });
		}
		return Response.json({
			content: Buffer.from("old", "utf8").toString("base64"),
			encoding: "base64",
			sha: "latest-sha",
		});
	}) as typeof fetch;
	try {
		const client = new GithubContentsClient();
		assert.equal(await client.write("test.json", "{}", "test", "stale-sha"), "new-sha");
		assert.equal(putBodies.length, 2);
		assert.equal(putBodies[1]?.sha, "latest-sha");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
