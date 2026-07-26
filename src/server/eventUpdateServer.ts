import http from "node:http";
import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { notifyScheduleUpdate, type EventUpdatePayload } from "../notifications/eventUpdates.js";
import { lineHealth } from "../runtime/lineHealth.js";

const MAX_BODY_BYTES = 128 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
				reject(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function isAuthorized(req: http.IncomingMessage): boolean {
	if (!appConfig.eventUpdateSecret) return true;
	return req.headers["x-event-update-secret"] === appConfig.eventUpdateSecret;
}

export function startEventUpdateServer(
	clientOrProvider: Client | (() => Client | null),
): http.Server {
	const getClient = typeof clientOrProvider === "function"
		? clientOrProvider
		: () => clientOrProvider;
	const server = http.createServer(async (req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			const health = lineHealth.snapshot();
			const staleChannels = [
				...(appConfig.enableTalk && lineHealth.isStale("talk", appConfig.talkPollStaleMs) ? ["talk"] : []),
				...(appConfig.enableSquare && lineHealth.isStale("square", appConfig.squarePollStaleMs) ? ["square"] : []),
			];
			const ok = Boolean(getClient()) && staleChannels.length === 0;
			res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok, lineReady: Boolean(getClient()), staleChannels, health }));
			return;
		}

		if (req.method !== "POST" || req.url !== "/event-update") {
			res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: false, error: "not found" }));
			return;
		}

		if (!isAuthorized(req)) {
			res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
			return;
		}

		try {
			const client = getClient();
			if (!client) {
				res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: false, error: "LINE client is reconnecting" }));
				return;
			}
			const raw = await readBody(req);
			const payload = (raw ? JSON.parse(raw) : {}) as EventUpdatePayload;
			const result = await notifyScheduleUpdate(client, payload);
			console.log(
				`[event-update] accepted phase=${String(payload.phase)} test=${payload.test === true} ` +
				`sent=${result.sent} skipped=${result.skipped}`,
			);
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: true, ...result }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[event-update] request failed: ${message}`);
			res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: false, error: message }));
		}
	});

	server.listen(appConfig.port, "0.0.0.0", () => {
		console.log(`[event-update] server listening on :${appConfig.port}`);
	});
	return server;
}
