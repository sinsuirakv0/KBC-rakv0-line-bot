import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import type { LineDestination } from "../commands/shared.js";
import { githubContentsClient } from "../storage/githubContents.js";

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
		if (githubContentsClient.enabled) {
			try {
				let remote = await this.readGithub(appConfig.pushSubscriptionsGithubPath);
				let migrated = false;
				if (!remote && appConfig.pushSubscriptionsGithubPath !== "push-subscriptions.json") {
					remote = await this.readGithub("push-subscriptions.json");
					migrated = Boolean(remote);
				}
				if (remote) {
					this.data = remote.data;
					this.githubSha = migrated ? undefined : remote.sha;
					await this.writeLocal();
					if (migrated) {
						await this.writeGithub();
						if (remote.sha) {
							try {
								await githubContentsClient.delete(
									"push-subscriptions.json",
									"Remove migrated LINE push subscriptions",
									remote.sha,
								);
							} catch (error) {
								console.warn("[push:skd] old GitHub data could not be removed", error);
							}
						}
						console.log(`[push:skd] migrated GitHub data to ${appConfig.pushSubscriptionsGithubPath}`);
					}
					console.log(`[push:skd] restored ${this.data.subscriptions.length} subscription(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[push:skd] GitHub restore failed; using local storage", error);
			}
		}

		try {
			this.data = parseData(JSON.parse(await fs.readFile(appConfig.pushSubscriptionsFile, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("[push:skd] local subscription file could not be read", error);
			}
			await this.writeLocal();
		}
		console.log(`[push:skd] loaded ${this.data.subscriptions.length} subscription(s)`);
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
			throw new Error("個人チャットはスケジュール更新通知の通知先に登録できません");
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

	private async save(): Promise<void> {
		const operation = this.saveQueue.then(async () => {
			await this.writeLocal();
			if (githubContentsClient.enabled) await this.writeGithub();
		});
		this.saveQueue = operation.catch(() => {});
		await operation;
	}

	private async writeLocal(): Promise<void> {
		const temporary = `${appConfig.pushSubscriptionsFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.pushSubscriptionsFile);
	}

	private async readGithub(filePath: string): Promise<{ data: SubscriptionData; sha?: string } | null> {
		const file = await githubContentsClient.read(filePath);
		if (!file) return null;
		return { data: parseData(JSON.parse(file.content)), sha: file.sha };
	}

	private async writeGithub(): Promise<void> {
		this.githubSha = await githubContentsClient.write(
			appConfig.pushSubscriptionsGithubPath,
			`${JSON.stringify(this.data, null, 2)}\n`,
			"Update LINE push subscriptions",
			this.githubSha,
		);
	}
}

export const pushSubscriptionStore = new PushSubscriptionStore();
