import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface OcKickHistoryEntry {
	id: string;
	at: string;
	squareMid: string;
	chatMid: string;
	targetMid: string;
	targetName: string;
	actorMid: string;
	actorName: string;
	reason?: string;
	result: "success" | "failed";
	error?: string;
}

interface OcKickHistoryFile {
	version: 1;
	entries: OcKickHistoryEntry[];
}

const EMPTY_HISTORY: OcKickHistoryFile = { version: 1, entries: [] };
const SAVE_DELAY_MS = 5_000;
const MAX_HISTORY = 500;

function parseHistory(value: unknown): OcKickHistoryFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_HISTORY);
	const raw = value as Partial<OcKickHistoryFile>;
	const entries = Array.isArray(raw.entries) ? raw.entries : [];
	return {
		version: 1,
		entries: entries.flatMap((entry) => {
			const item = entry as Partial<OcKickHistoryEntry>;
			if (
				typeof item.id !== "string" ||
				typeof item.at !== "string" ||
				typeof item.squareMid !== "string" ||
				typeof item.chatMid !== "string" ||
				typeof item.targetMid !== "string" ||
				typeof item.targetName !== "string" ||
				typeof item.actorMid !== "string" ||
				typeof item.actorName !== "string" ||
				(item.result !== "success" && item.result !== "failed")
			) return [];
			return [{
				id: item.id,
				at: item.at,
				squareMid: item.squareMid,
				chatMid: item.chatMid,
				targetMid: item.targetMid,
				targetName: item.targetName,
				actorMid: item.actorMid,
				actorName: item.actorName,
				reason: typeof item.reason === "string" ? item.reason : undefined,
				result: item.result,
				error: typeof item.error === "string" ? item.error : undefined,
			}];
		}).slice(-MAX_HISTORY),
	};
}

class OcKickHistoryStore {
	private data: OcKickHistoryFile = structuredClone(EMPTY_HISTORY);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.ocKickHistoryFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.ocKickHistoryGithubPath);
				if (remote) {
					this.data = parseHistory(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[oc-kick] loaded ${this.data.entries.length} entrie(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[oc-kick] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseHistory(JSON.parse(await fs.readFile(appConfig.ocKickHistoryFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[oc-kick] loaded ${this.data.entries.length} entrie(s)`);
	}

	record(entry: Omit<OcKickHistoryEntry, "id" | "at">): void {
		this.data.entries.push({
			...entry,
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			at: new Date().toISOString(),
		});
		if (this.data.entries.length > MAX_HISTORY) {
			this.data.entries = this.data.entries.slice(-MAX_HISTORY);
		}
		this.scheduleSave();
	}

	list(squareMid: string, limit = 10): OcKickHistoryEntry[] {
		return this.data.entries
			.filter((entry) => entry.squareMid === squareMid)
			.slice(-Math.max(1, Math.min(limit, 30)))
			.reverse()
			.map((entry) => ({ ...entry }));
	}

	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (!this.dirty) {
			await this.saveQueue;
			return;
		}
		this.dirty = false;
		const snapshot = structuredClone(this.data);
		const operation = this.saveQueue.then(async () => {
			await this.writeLocal(snapshot);
			if (githubContentsClient.enabled) {
				this.githubSha = await githubContentsClient.write(
					appConfig.ocKickHistoryGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update OpenChat kick history",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[oc-kick] save failed", error);
			this.dirty = true;
			this.scheduleSave();
		});
		await operation;
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush().catch((error) => {
				console.error("[oc-kick] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: OcKickHistoryFile = this.data): Promise<void> {
		const temporary = `${appConfig.ocKickHistoryFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.ocKickHistoryFile);
	}
}

export const ocKickHistoryStore = new OcKickHistoryStore();
