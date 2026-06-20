import http from "node:http";
import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { notifyScheduleUpdate, type EventUpdatePayload } from "../notifications/eventUpdates.js";

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

export function startEventUpdateServer(client: Client): http.Server {
	const server = http.createServer(async (req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: true }));
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
			const raw = await readBody(req);
			const payload = (raw ? JSON.parse(raw) : {}) as EventUpdatePayload;
			const result = await notifyScheduleUpdate(client, payload);
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
