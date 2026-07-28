import type { Client } from "@evex/linejs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatWithOptions } from "node:util";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

type BotLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface BotLogRelayFile {
	version: 2;
	enabled: boolean;
	updatedAt?: string;
	updatedBy?: string;
}

interface QueuedLog {
	at: number;
	level: BotLogLevel;
	text: string;
}

export interface BotLogRelaySnapshot {
	enabled: boolean;
	forcedOff: boolean;
	targetTalkMid: string;
	clientReady: boolean;
	queued: number;
	dropped: number;
	suppressed: number;
	lastSentAt?: string;
	lastError?: string;
	updatedAt?: string;
	updatedBy?: string;
}

const EMPTY_SETTINGS: BotLogRelayFile = { version: 2, enabled: false };
const MESSAGE_MAX_CHARS = 4_300;
const ENTRY_MAX_CHARS = 3_000;
const MAX_BATCHES_PER_FLUSH = 1;
const SEND_RETRY_MS = 15_000;
const MIN_SEND_INTERVAL_MS = 15_000;

// LINEへのログ送信自身が生成するログは、再送すると無限循環になるため転送しない。
const INTERNAL_LOG_PREFIXES = [
	"[bot-log-relay]",
	"[line-storage]",
	"[github]",
	"[talk:event] NOTIFIED_READ_MESSAGE",
	"[perf] talk poll=",
] as const;

function parseSettings(value: unknown): BotLogRelayFile {
	if (!value || typeof value !== "object") return { ...EMPTY_SETTINGS };
	const raw = value as Partial<BotLogRelayFile>;
	// v1は転送の自己循環を防げなかったため、安全のため一度OFFへ移行する。
	if (raw.version !== 2) {
		return {
			...EMPTY_SETTINGS,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
			updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : undefined,
		};
	}
	return {
		version: 2,
		enabled: raw.enabled === true,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
		updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : undefined,
	};
}

function jstTime(at: number, includeDate = false): string {
	const iso = new Date(at + 9 * 60 * 60_000).toISOString();
	return includeDate
		? `${iso.slice(2, 10).replaceAll("-", "/")} ${iso.slice(11, 23)}`
		: iso.slice(11, 23);
}

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

class BotLogRelay {
	private data: BotLogRelayFile = { ...EMPTY_SETTINGS };
	private githubSha: string | undefined;
	private client: Client | null = null;
	private queue: QueuedLog[] = [];
	private dropped = 0;
	private suppressed = 0;
	private flushTimer: NodeJS.Timeout | undefined;
	private flushing = false;
	private installed = false;
	private saveQueue: Promise<void> = Promise.resolve();
	private lastSentAt: string | undefined;
	private lastSendAttemptAt = 0;
	private lastError: string | undefined;
	private sensitiveValues: string[] = [];
	private readonly original = {
		debug: console.debug.bind(console),
		info: console.info.bind(console),
		log: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
	};

	install(): void {
		if (this.installed) return;
		this.installed = true;
		this.sensitiveValues = Object.entries(process.env)
			.filter(([name, value]) => (
				/(?:TOKEN|PASSWORD|SECRET|PRIVATE|AUTH|API_?KEY|BACKUP_?KEY|EMAIL)/i.test(name) &&
				typeof value === "string" &&
				value.length >= 8
			))
			.map(([, value]) => value as string)
			.sort((left, right) => right.length - left.length);

		console.debug = (...args: unknown[]) => {
			this.original.debug(...args);
			this.capture("DEBUG", args);
		};
		console.info = (...args: unknown[]) => {
			this.original.info(...args);
			this.capture("INFO", args);
		};
		console.log = (...args: unknown[]) => {
			this.original.log(...args);
			this.capture("INFO", args);
		};
		console.warn = (...args: unknown[]) => {
			this.original.warn(...args);
			this.capture("WARN", args);
		};
		console.error = (...args: unknown[]) => {
			this.original.error(...args);
			this.capture("ERROR", args);
		};
	}

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.botLogRelayFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.botLogRelayGithubPath);
				if (remote) {
					this.data = parseSettings(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[bot-log-relay] restored settings; enabled=${this.data.enabled}`);
					return;
				}
			} catch (error) {
				console.warn("[bot-log-relay] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseSettings(JSON.parse(await fs.readFile(appConfig.botLogRelayFile, "utf8")));
		} catch {
			this.data = { ...EMPTY_SETTINGS };
			await this.writeLocal();
		}
		console.log(`[bot-log-relay] loaded settings; enabled=${this.data.enabled}`);
	}

	setClient(client: Client | null): void {
		this.client = client;
		if (client && this.isEnabled() && this.queue.length > 0) this.scheduleFlush(250);
	}

	snapshot(): BotLogRelaySnapshot {
		return {
			enabled: this.isEnabled(),
			forcedOff: appConfig.botLogRelayForceOff,
			targetTalkMid: appConfig.botLogRelayTalkMid,
			clientReady: this.client !== null,
			queued: this.queue.length,
			dropped: this.dropped,
			suppressed: this.suppressed,
			lastSentAt: this.lastSentAt,
			lastError: this.lastError,
			updatedAt: this.data.updatedAt,
			updatedBy: this.data.updatedBy,
		};
	}

	async setEnabled(enabled: boolean, updatedBy: string): Promise<"enabled" | "disabled" | "unchanged"> {
		if (enabled && appConfig.botLogRelayForceOff) {
			throw new Error("BOT_LOG_RELAY_FORCE_OFF=true のため、環境変数側で停止されています。");
		}
		if (this.data.enabled === enabled) return "unchanged";
		const previous = { ...this.data };
		const next: BotLogRelayFile = {
			version: 2,
			enabled,
			updatedAt: new Date().toISOString(),
			updatedBy,
		};
		this.data = next;
		try {
			await this.save();
		} catch (error) {
			this.data = previous;
			await this.writeLocal(previous).catch(() => {});
			throw error;
		}
		if (!enabled) {
			if (this.flushTimer) clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
			this.queue = [];
			this.dropped = 0;
			this.suppressed = 0;
		}
		if (enabled) {
			this.capture("INFO", ["[bot-log-relay] LINEログ転送を有効化しました"]);
		}
		return enabled ? "enabled" : "disabled";
	}

	emitTest(actorMid: string): void {
		this.capture("INFO", [
			"[bot-log-relay:test] diagnostic delivery test",
			{ actorMid, targetTalkMid: appConfig.botLogRelayTalkMid },
		]);
	}

	async shutdown(): Promise<void> {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.client && this.isEnabled() && this.queue.length > 0) {
			await this.flush().catch(() => {});
		}
		await this.saveQueue.catch(() => {});
	}

	private capture(level: BotLogLevel, args: unknown[]): void {
		if (!this.isEnabled()) return;
		try {
			const formatted = formatWithOptions({
				colors: false,
				depth: 5,
				maxArrayLength: 50,
				maxStringLength: 2_000,
				breakLength: 160,
				compact: 2,
			}, ...args);
			const text = this.redact(formatted).replace(/\u001b\[[0-9;]*m/g, "").slice(0, ENTRY_MAX_CHARS);
			if (!text) return;
			if (INTERNAL_LOG_PREFIXES.some((prefix) => text.startsWith(prefix))) {
				this.suppressed++;
				return;
			}
			this.queue.push({ at: Date.now(), level, text });
			while (this.queue.length > appConfig.botLogRelayMaxQueue) {
				this.queue.shift();
				this.dropped++;
			}
			this.scheduleFlush();
		} catch (error) {
			this.original.error("[bot-log-relay] log formatting failed", error);
		}
	}

	private redact(value: string): string {
		let text = value;
		for (const secret of this.sensitiveValues) {
			if (text.includes(secret)) text = text.split(secret).join("[REDACTED]");
		}
		return text
			.replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[REDACTED_GITHUB_TOKEN]")
			.replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
			.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
			.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_JWT]")
			.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
			.replace(
				/((?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*["']?)[^\s,"'}]+/gi,
				"$1[REDACTED]",
			);
	}

	private scheduleFlush(delayMs = appConfig.botLogRelayBatchMs): void {
		if (!this.isEnabled() || this.flushTimer || this.flushing) return;
		const sendIntervalRemaining = Math.max(
			0,
			MIN_SEND_INTERVAL_MS - (Date.now() - this.lastSendAttemptAt),
		);
		const safeDelayMs = Math.max(delayMs, sendIntervalRemaining);
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, safeDelayMs);
	}

	private async flush(): Promise<void> {
		if (this.flushing || !this.isEnabled() || !this.client || this.queue.length === 0) return;
		this.flushing = true;
		let retry = false;
		try {
			for (let sent = 0; sent < MAX_BATCHES_PER_FLUSH && this.queue.length > 0; sent++) {
				const batch = this.takeBatch();
				try {
					this.lastSendAttemptAt = Date.now();
					await this.client.base.talk.sendMessage({
						to: appConfig.botLogRelayTalkMid,
						text: this.batchText(batch),
						e2ee: appConfig.botLogRelayE2ee,
					});
					this.lastSentAt = new Date().toISOString();
					this.lastError = undefined;
					this.dropped = 0;
				} catch (error) {
					this.queue.unshift(...batch);
					this.lastError = errorText(error);
					this.original.error("[bot-log-relay] delivery failed", error);
					retry = true;
					break;
				}
			}
		} finally {
			this.flushing = false;
		}
		if (this.queue.length > 0) this.scheduleFlush(retry ? SEND_RETRY_MS : undefined);
	}

	private takeBatch(): QueuedLog[] {
		const batch: QueuedLog[] = [];
		let chars = 80;
		while (this.queue.length > 0) {
			const next = this.queue[0];
			const line = this.logLine(next);
			if (batch.length > 0 && chars + line.length + 1 > MESSAGE_MAX_CHARS) break;
			batch.push(this.queue.shift() as QueuedLog);
			chars += line.length + 1;
		}
		return batch;
	}

	private batchText(batch: QueuedLog[]): string {
		const firstAt = batch[0]?.at ?? Date.now();
		const lines = [
			`BOT LOG ${jstTime(firstAt, true)}`,
			...(this.dropped > 0 ? [`[WARN] キュー上限により古いログを${this.dropped}件破棄しました。`] : []),
			...batch.map((entry) => this.logLine(entry)),
		];
		return lines.join("\n").slice(0, MESSAGE_MAX_CHARS);
	}

	private logLine(entry: QueuedLog): string {
		return `[${jstTime(entry.at)}][${entry.level}] ${entry.text}`;
	}

	private async save(): Promise<void> {
		const snapshot = { ...this.data };
		const operation = this.saveQueue.then(async () => {
			await this.writeLocal(snapshot);
			if (githubContentsClient.enabled) {
				this.githubSha = await githubContentsClient.write(
					appConfig.botLogRelayGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update bot LINE log relay settings",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			this.original.error("[bot-log-relay] settings save failed", error);
		});
		await operation;
	}

	private async writeLocal(value: BotLogRelayFile = this.data): Promise<void> {
		const temporary = `${appConfig.botLogRelayFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.botLogRelayFile);
	}

	private isEnabled(): boolean {
		return this.data.enabled && !appConfig.botLogRelayForceOff;
	}
}

export const botLogRelay = new BotLogRelay();
