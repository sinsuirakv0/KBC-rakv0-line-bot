import assert from "node:assert/strict";
import test from "node:test";
import { appConfig } from "../src/config.js";
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

test("GitHub directory reads only one requested directory", async () => {
	const originalFetch = globalThis.fetch;
	const originalRepo = appConfig.pushSubscriptionsGithubRepo;
	const originalToken = appConfig.pushSubscriptionsGithubToken;
	let requestedUrl = "";
	appConfig.pushSubscriptionsGithubRepo = "owner/repo";
	appConfig.pushSubscriptionsGithubToken = "test-token";
	globalThis.fetch = (async (input) => {
		requestedUrl = String(input);
		return Response.json([
			{ name: "2026-07-30.0001.json", path: "logs/message-log/square/mid/2026/07/2026-07-30.0001.json", type: "file", size: 123 },
			{ name: "nested", path: "logs/message-log/square/mid/2026/07/nested", type: "dir" },
			{ name: "ignored", path: "logs/message-log/square/mid/2026/07/ignored", type: "symlink" },
		]);
	}) as typeof fetch;
	try {
		const client = new GithubContentsClient();
		const entries = await client.listDirectory("logs/message-log/square/mid/2026/07");
		assert.equal(entries.length, 2);
		assert.equal(entries[0]?.type, "file");
		assert.equal(entries[0]?.size, 123);
		assert.match(requestedUrl, /\/contents\/logs\/message-log\/square\/mid\/2026\/07\?ref=/);
		assert.doesNotMatch(requestedUrl, /git\/trees/);
	} finally {
		globalThis.fetch = originalFetch;
		appConfig.pushSubscriptionsGithubRepo = originalRepo;
		appConfig.pushSubscriptionsGithubToken = originalToken;
	}
});
