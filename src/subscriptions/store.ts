import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import type { LineDestination } from "../commands/shared.js";

export interface PushSubscription {
	kind: "talk" | "square";
	chatMid: string;
	chatType: "GROUP" | "ROOM" | "SQUARE";
	encrypted: boolean;
	registeredBy: string;
	registeredAt: string;
}

interface SubscriptionData {
	version: 1;
	subscriptions: PushSubscription[];
	notifiedKeys: string[];
}

interface GithubFileResponse {
	content?: string;
	encoding?: string;
	sha?: string;
}

const EMPTY_DATA: SubscriptionData = {
	version: 1,
	subscriptions: [],
	notifiedKeys: [],
};

function targetKey(target: Pick<PushSubscription, "kind" | "chatMid">): string {
	return `${target.kind}:${target.chatMid}`;
}

function parseData(value: unknown): SubscriptionData {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_DATA);
	const raw = value as Partial<SubscriptionData>;
	return {
		version: 1,
		subscriptions: Array.isArray(raw.subscriptions)
			? raw.subscriptions.filter((item): item is PushSubscription =>
				Boolean(item && typeof item.chatMid === "string" &&
					(item.kind === "talk" || item.kind === "square")))
			: [],
		notifiedKeys: Array.isArray(raw.notifiedKeys)
			? raw.notifiedKeys.filter((item): item is string => typeof item === "string").slice(-100)
			: [],
	};
}

class PushSubscriptionStore {
	private data: SubscriptionData = structuredClone(EMPTY_DATA);
	private githubSha: string | undefined;
	private saveQueue: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.pushSubscriptionsFile), { recursive: true });
		if (this.githubEnabled()) {
			try {
				const remote = await this.readGithub();
				if (remote) {
					this.data = remote.data;
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[pushskd] restored ${this.data.subscriptions.length} subscription(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[pushskd] GitHub restore failed; using local storage", error);
			}
		}

		try {
			this.data = parseData(JSON.parse(await fs.readFile(appConfig.pushSubscriptionsFile, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("[pushskd] local subscription file could not be read", error);
			}
			await this.writeLocal();
		}
		console.log(`[pushskd] loaded ${this.data.subscriptions.length} subscription(s)`);
	}

	list(): PushSubscription[] {
		return this.data.subscriptions.map((item) => ({ ...item }));
	}

	has(destination: Pick<LineDestination, "kind" | "chatMid">): boolean {
		const key = targetKey(destination);
		return this.data.subscriptions.some((item) => targetKey(item) === key);
	}

	async subscribe(destination: LineDestination): Promise<boolean> {
		if (destination.chatType === "USER") {
			throw new Error("個人チャットはpushskdの通知先に登録できません");
		}
		const key = targetKey(destination);
		if (this.data.subscriptions.some((item) => targetKey(item) === key)) return false;
		this.data.subscriptions.push({
			kind: destination.kind,
			chatMid: destination.chatMid,
			chatType: destination.chatType,
			encrypted: destination.encrypted,
			registeredBy: destination.senderMid,
			registeredAt: new Date().toISOString(),
		});
		await this.save();
		return true;
	}

	async unsubscribe(destination: Pick<LineDestination, "kind" | "chatMid">): Promise<boolean> {
		const key = targetKey(destination);
		const before = this.data.subscriptions.length;
		this.data.subscriptions = this.data.subscriptions.filter((item) => targetKey(item) !== key);
		if (this.data.subscriptions.length === before) return false;
		await this.save();
		return true;
	}

	hasNotified(key: string): boolean {
		return this.data.notifiedKeys.includes(key);
	}

	async markNotified(key: string): Promise<void> {
		if (this.hasNotified(key)) return;
		this.data.notifiedKeys.push(key);
		this.data.notifiedKeys = this.data.notifiedKeys.slice(-100);
		await this.save();
	}

	private githubEnabled(): boolean {
		return Boolean(
			appConfig.pushSubscriptionsGithubRepo && appConfig.pushSubscriptionsGithubToken,
		);
	}

	private async save(): Promise<void> {
		const operation = this.saveQueue.then(async () => {
			await this.writeLocal();
			if (this.githubEnabled()) await this.writeGithub();
		});
		this.saveQueue = operation.catch(() => {});
		await operation;
	}

	private async writeLocal(): Promise<void> {
		const temporary = `${appConfig.pushSubscriptionsFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.pushSubscriptionsFile);
	}

	private githubUrl(): string {
		const encodedPath = appConfig.pushSubscriptionsGithubPath
			.split("/")
			.map(encodeURIComponent)
			.join("/");
		return `https://api.github.com/repos/${appConfig.pushSubscriptionsGithubRepo}/contents/${encodedPath}`;
	}

	private githubHeaders(): Record<string, string> {
		return {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${appConfig.pushSubscriptionsGithubToken}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "KBC-rakv0-line-bot",
		};
	}

	private async readGithub(): Promise<{ data: SubscriptionData; sha?: string } | null> {
		const url = new URL(this.githubUrl());
		url.searchParams.set("ref", appConfig.pushSubscriptionsGithubBranch);
		const response = await fetch(url, { headers: this.githubHeaders() });
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`GitHub read failed: HTTP ${response.status}`);
		const file = await response.json() as GithubFileResponse;
		if (file.encoding !== "base64" || !file.content) {
			throw new Error("GitHub subscription file is not base64 content");
		}
		const content = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
		return { data: parseData(JSON.parse(content)), sha: file.sha };
	}

	private async writeGithub(): Promise<void> {
		const response = await fetch(this.githubUrl(), {
			method: "PUT",
			headers: { ...this.githubHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "Update LINE push subscriptions",
				content: Buffer.from(`${JSON.stringify(this.data, null, 2)}\n`, "utf8").toString("base64"),
				branch: appConfig.pushSubscriptionsGithubBranch,
				...(this.githubSha ? { sha: this.githubSha } : {}),
			}),
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`GitHub write failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
		}
		const result = await response.json() as { content?: { sha?: string } };
		this.githubSha = result.content?.sha;
	}
}

export const pushSubscriptionStore = new PushSubscriptionStore();
