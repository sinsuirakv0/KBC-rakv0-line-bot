import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FileStorage } from "@evex/linejs/storage";
import type { Storage } from "@evex/linejs/storage";
import { appConfig } from "../config.js";
import { githubContentsClient } from "./githubContents.js";

interface EncryptedStorageFile {
	version: 1;
	algorithm: "aes-256-gcm";
	updatedAt: string;
	iv: string;
	authTag: string;
	ciphertext: string;
}

const SQUARE_SYNC_TOKEN_STORAGE_KEY = "kbc.squareSyncToken";
const SQUARE_CHAT_SYNC_TOKENS_STORAGE_KEY = "kbc.squareChatSyncTokens";
const SQUARE_SYNC_TOKEN_SAVE_DELAY_MS = 5_000;

function encryptionKey(): Buffer | null {
	if (!appConfig.lineStorageBackupKey) return null;
	return createHash("sha256").update(appConfig.lineStorageBackupKey, "utf8").digest();
}

export function encryptLineStorage(content: string): string {
	const key = encryptionKey();
	if (!key) throw new Error("LINE_STORAGE_BACKUP_KEY is not configured");
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
	const payload: EncryptedStorageFile = {
		version: 1,
		algorithm: "aes-256-gcm",
		updatedAt: new Date().toISOString(),
		iv: iv.toString("base64"),
		authTag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
	return `${JSON.stringify(payload, null, 2)}\n`;
}

export function decryptLineStorage(content: string): { data: string; updatedAt: number } {
	const key = encryptionKey();
	if (!key) throw new Error("LINE_STORAGE_BACKUP_KEY is not configured");
	const payload = JSON.parse(content) as EncryptedStorageFile;
	if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") {
		throw new Error("Unsupported LINE storage backup format");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(payload.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
	const data = Buffer.concat([
		decipher.update(Buffer.from(payload.ciphertext, "base64")),
		decipher.final(),
	]).toString("utf8");
	const parsed = JSON.parse(data);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Decrypted LINE storage is not a JSON object");
	}
	return { data, updatedAt: Date.parse(payload.updatedAt) || 0 };
}

class LineStorageBackup {
	private sha: string | undefined;
	private timer: NodeJS.Timeout | undefined;
	private queue: Promise<void> = Promise.resolve();

	get enabled(): boolean {
		return githubContentsClient.enabled && Boolean(encryptionKey());
	}

	async restore(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.storageFile), { recursive: true });
		if (!githubContentsClient.enabled) {
			console.warn("[line-storage] GitHub persistence is disabled");
			return;
		}
		if (!encryptionKey()) {
			console.warn("[line-storage] LINE_STORAGE_BACKUP_KEY is missing; auth storage will not be uploaded");
			return;
		}

		const remote = await githubContentsClient.read(appConfig.lineStorageGithubPath);
		if (!remote) {
			console.log("[line-storage] no remote auth backup found; a backup will be created after login");
			return;
		}
		this.sha = remote.sha;
		const restored = decryptLineStorage(remote.content);
		let localMtime = 0;
		try {
			localMtime = (await fs.stat(appConfig.storageFile)).mtimeMs;
		} catch { /* no local storage */ }
		if (localMtime > restored.updatedAt) {
			console.log("[line-storage] local auth storage is newer than the GitHub backup");
			return;
		}
		await fs.writeFile(appConfig.storageFile, restored.data, "utf8");
		console.log(`[line-storage] restored encrypted auth storage from ${appConfig.lineStorageGithubPath}`);
	}

	schedule(): void {
		if (!this.enabled) return;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.enqueueUpload();
		}, appConfig.lineStorageBackupIntervalMs);
	}

	async flush(): Promise<void> {
		if (!this.enabled) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
			await this.enqueueUpload();
		}
		await this.queue;
	}

	private async enqueueUpload(): Promise<void> {
		const operation = this.queue.then(async () => {
			const content = await fs.readFile(appConfig.storageFile, "utf8");
			this.sha = await githubContentsClient.write(
				appConfig.lineStorageGithubPath,
				encryptLineStorage(content),
				"Update encrypted LINE authentication storage",
				this.sha,
			);
			console.log(`[line-storage] encrypted auth storage synced to ${appConfig.lineStorageGithubPath}`);
		});
		this.queue = operation.catch((error) => {
			console.error("[line-storage] backup failed", error);
		});
		await operation;
	}
}

const backup = new LineStorageBackup();

export class SyncedLineStorage extends FileStorage {
	private pendingSquareSyncToken: string | undefined;
	private persistedSquareSyncToken: string | undefined;
	private squareSyncTokenTimer: NodeJS.Timeout | undefined;
	private squareSyncTokenQueue: Promise<void> = Promise.resolve();
	private squareChatSyncTokens: Record<string, string> | undefined;
	private pendingSquareChatSyncTokens = new Map<string, string | null>();
	private squareChatSyncTokenTimer: NodeJS.Timeout | undefined;
	private squareChatSyncTokenQueue: Promise<void> = Promise.resolve();

	override async set(key: Storage["Key"], value: Storage["Value"]): Promise<void> {
		await super.set(key, value);
		backup.schedule();
	}

	override async delete(key: Storage["Key"]): Promise<void> {
		await super.delete(key);
		backup.schedule();
	}

	override async clear(): Promise<void> {
		if (this.squareSyncTokenTimer) {
			clearTimeout(this.squareSyncTokenTimer);
			this.squareSyncTokenTimer = undefined;
		}
		if (this.squareChatSyncTokenTimer) {
			clearTimeout(this.squareChatSyncTokenTimer);
			this.squareChatSyncTokenTimer = undefined;
		}
		this.pendingSquareSyncToken = undefined;
		this.pendingSquareChatSyncTokens.clear();
		await this.squareSyncTokenQueue;
		await this.squareChatSyncTokenQueue;
		await super.clear();
		this.persistedSquareSyncToken = undefined;
		this.squareChatSyncTokens = undefined;
		backup.schedule();
	}

	async getSquareSyncToken(): Promise<string | undefined> {
		const value = await this.get(SQUARE_SYNC_TOKEN_STORAGE_KEY);
		const token = typeof value === "string" && value ? value : undefined;
		this.persistedSquareSyncToken = token;
		return token;
	}

	scheduleSquareSyncToken(token: string): void {
		if (!token || token === this.pendingSquareSyncToken || token === this.persistedSquareSyncToken) return;
		this.pendingSquareSyncToken = token;
		if (this.squareSyncTokenTimer) return;
		this.squareSyncTokenTimer = setTimeout(() => {
			this.squareSyncTokenTimer = undefined;
			void this.flushSquareSyncToken().catch((error) => {
				console.error("[line-storage] square sync token save failed", error);
			});
		}, SQUARE_SYNC_TOKEN_SAVE_DELAY_MS);
	}

	async clearSquareSyncToken(): Promise<void> {
		if (this.squareSyncTokenTimer) {
			clearTimeout(this.squareSyncTokenTimer);
			this.squareSyncTokenTimer = undefined;
		}
		this.pendingSquareSyncToken = undefined;
		await this.squareSyncTokenQueue;
		await this.delete(SQUARE_SYNC_TOKEN_STORAGE_KEY);
		this.persistedSquareSyncToken = undefined;
	}

	async getSquareChatSyncToken(squareChatMid: string): Promise<string | undefined> {
		await this.loadSquareChatSyncTokens();
		return this.squareChatSyncTokens?.[squareChatMid];
	}

	scheduleSquareChatSyncToken(squareChatMid: string, token: string): void {
		if (!squareChatMid || !token || this.squareChatSyncTokens?.[squareChatMid] === token) return;
		this.pendingSquareChatSyncTokens.set(squareChatMid, token);
		if (this.squareChatSyncTokenTimer) return;
		this.squareChatSyncTokenTimer = setTimeout(() => {
			this.squareChatSyncTokenTimer = undefined;
			void this.flushSquareChatSyncTokens().catch((error) => {
				console.error("[line-storage] square chat sync token save failed", error);
			});
		}, SQUARE_SYNC_TOKEN_SAVE_DELAY_MS);
	}

	async clearSquareChatSyncToken(squareChatMid: string): Promise<void> {
		await this.loadSquareChatSyncTokens();
		this.pendingSquareChatSyncTokens.set(squareChatMid, null);
		await this.flushSquareChatSyncTokens();
	}

	async flushBackup(): Promise<void> {
		if (this.squareSyncTokenTimer) {
			clearTimeout(this.squareSyncTokenTimer);
			this.squareSyncTokenTimer = undefined;
		}
		if (this.squareChatSyncTokenTimer) {
			clearTimeout(this.squareChatSyncTokenTimer);
			this.squareChatSyncTokenTimer = undefined;
		}
		await this.flushSquareSyncToken();
		await this.flushSquareChatSyncTokens();
		await backup.flush();
	}

	private async flushSquareSyncToken(): Promise<void> {
		const token = this.pendingSquareSyncToken;
		this.pendingSquareSyncToken = undefined;
		if (!token || token === this.persistedSquareSyncToken) {
			await this.squareSyncTokenQueue;
			return;
		}
		const operation = this.squareSyncTokenQueue.then(async () => {
			await this.set(SQUARE_SYNC_TOKEN_STORAGE_KEY, token);
			this.persistedSquareSyncToken = token;
		});
		this.squareSyncTokenQueue = operation.catch((error) => {
			this.pendingSquareSyncToken = token;
			console.error("[line-storage] square sync token write failed", error);
		});
		await operation;
	}

	private async loadSquareChatSyncTokens(): Promise<void> {
		if (this.squareChatSyncTokens) return;
		const value = await this.get(SQUARE_CHAT_SYNC_TOKENS_STORAGE_KEY);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			this.squareChatSyncTokens = {};
			return;
		}
		this.squareChatSyncTokens = Object.fromEntries(
			Object.entries(value).flatMap(([chatMid, token]) => (
				typeof token === "string" && token ? [[chatMid, token]] : []
			)),
		);
	}

	private async flushSquareChatSyncTokens(): Promise<void> {
		if (this.pendingSquareChatSyncTokens.size === 0) {
			await this.squareChatSyncTokenQueue;
			return;
		}
		await this.loadSquareChatSyncTokens();
		const updates = new Map(this.pendingSquareChatSyncTokens);
		this.pendingSquareChatSyncTokens.clear();
		const operation = this.squareChatSyncTokenQueue.then(async () => {
			const next = { ...(this.squareChatSyncTokens ?? {}) };
			for (const [chatMid, token] of updates) {
				if (token) next[chatMid] = token;
				else delete next[chatMid];
			}
			await this.set(SQUARE_CHAT_SYNC_TOKENS_STORAGE_KEY, next);
			this.squareChatSyncTokens = next;
		});
		this.squareChatSyncTokenQueue = operation.catch((error) => {
			for (const [chatMid, token] of updates) {
				if (!this.pendingSquareChatSyncTokens.has(chatMid)) {
					this.pendingSquareChatSyncTokens.set(chatMid, token);
				}
			}
			console.error("[line-storage] square chat sync token write failed", error);
		});
		await operation;
	}
}

export async function initializeLineStorage(): Promise<SyncedLineStorage> {
	try {
		await backup.restore();
	} catch (error) {
		console.error("[line-storage] restore failed; continuing with local storage", error);
	}
	await fs.mkdir(path.dirname(appConfig.storageFile), { recursive: true });
	return new SyncedLineStorage(appConfig.storageFile);
}
