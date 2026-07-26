import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

interface BotStatusFile {
	version: 1;
	totalUptimeMs: number;
	updatedAt?: string;
	lastSessionEnd?: BotStatusSessionEnd;
}

export interface BotStatusSessionEnd {
	endedAt: string;
	source: string;
	reason: string;
	durationMs: number;
}

export interface BotStatusSnapshot {
	sessionUptimeMs: number;
	totalUptimeMs: number;
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	systemUsedRatio: number;
	lastSessionEnd?: BotStatusSessionEnd;
}

const EMPTY: BotStatusFile = { version: 1, totalUptimeMs: 0 };

function parseStatus(value: unknown): BotStatusFile {
	if (!value || typeof value !== "object") return { ...EMPTY };
	const raw = value as Partial<BotStatusFile>;
	const sessionEnd = raw.lastSessionEnd;
	return {
		version: 1,
		totalUptimeMs: Number.isFinite(raw.totalUptimeMs) && (raw.totalUptimeMs ?? 0) >= 0
			? raw.totalUptimeMs as number
			: 0,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
		lastSessionEnd: (
			sessionEnd &&
			typeof sessionEnd.endedAt === "string" &&
			typeof sessionEnd.source === "string" &&
			typeof sessionEnd.reason === "string" &&
			Number.isFinite(sessionEnd.durationMs)
		) ? {
				endedAt: sessionEnd.endedAt,
				source: sessionEnd.source,
				reason: sessionEnd.reason,
				durationMs: Math.max(0, sessionEnd.durationMs),
			} : undefined,
	};
}

class RuntimeStore {
	private data: BotStatusFile = { ...EMPTY };
	private githubSha: string | undefined;
	private sessionStartedAt: number | undefined;
	private accountedAt: number | undefined;
	private saveQueue: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.botStatusFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.botStatusGithubPath);
				if (remote) {
					this.data = parseStatus(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[runtime] restored bot status from ${appConfig.botStatusGithubPath}`);
					return;
				}
			} catch (error) {
				console.warn("[runtime] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseStatus(JSON.parse(await fs.readFile(appConfig.botStatusFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
	}

	async startSession(now = Date.now()): Promise<void> {
		this.sessionStartedAt = now;
		this.accountedAt = now;
		await this.save();
	}

	async endSession(
		detail?: { source: string; reason: string },
		now = Date.now(),
	): Promise<void> {
		if (this.accountedAt === undefined) return;
		this.data.totalUptimeMs += Math.max(0, now - this.accountedAt);
		if (detail) {
			this.data.lastSessionEnd = {
				endedAt: new Date(now).toISOString(),
				source: detail.source,
				reason: detail.reason,
				durationMs: this.sessionStartedAt === undefined
					? 0
					: Math.max(0, now - this.sessionStartedAt),
			};
		}
		this.sessionStartedAt = undefined;
		this.accountedAt = undefined;
		await this.save();
	}

	async checkpoint(now = Date.now()): Promise<void> {
		if (this.accountedAt !== undefined) {
			this.data.totalUptimeMs += Math.max(0, now - this.accountedAt);
			this.accountedAt = now;
		}
		await this.save();
	}

	snapshot(now = Date.now()): BotStatusSnapshot {
		const sessionUptimeMs = this.sessionStartedAt === undefined
			? 0
			: Math.max(0, now - this.sessionStartedAt);
		const unaccountedMs = this.accountedAt === undefined ? 0 : Math.max(0, now - this.accountedAt);
		const memory = process.memoryUsage();
		const total = os.totalmem();
		const free = os.freemem();
		return {
			sessionUptimeMs,
			totalUptimeMs: this.data.totalUptimeMs + unaccountedMs,
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
			heapTotalBytes: memory.heapTotal,
			systemUsedRatio: total > 0 ? (total - free) / total : 0,
			lastSessionEnd: this.data.lastSessionEnd,
		};
	}

	async flush(): Promise<void> {
		await this.checkpoint();
	}

	private async save(): Promise<void> {
		const snapshot = {
			...this.data,
			updatedAt: new Date().toISOString(),
		};
		const operation = this.saveQueue.then(async () => {
			await this.writeLocal(snapshot);
			if (githubContentsClient.enabled) {
				this.githubSha = await githubContentsClient.write(
					appConfig.botStatusGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update LINE bot runtime status",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[runtime] save failed", error);
		});
		await operation;
	}

	private async writeLocal(value: BotStatusFile = this.data): Promise<void> {
		const temporary = `${appConfig.botStatusFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.botStatusFile);
	}
}

export const runtimeStore = new RuntimeStore();
