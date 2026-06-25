import fs from "node:fs/promises";
import path from "node:path";
import type { LineDestination } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface NewMemberGreeting {
	kind: "square";
	chatMid: string;
	registeredBy: string;
	registeredAt: string;
}

interface GreetingFile {
	version: 1;
	greetings: NewMemberGreeting[];
}

const EMPTY: GreetingFile = { version: 1, greetings: [] };

function targetKey(target: { kind: string; chatMid: string }): string {
	return `${target.kind}:${target.chatMid}`;
}

function parseFile(value: unknown): GreetingFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY);
	const raw = value as Partial<GreetingFile>;
	return {
		version: 1,
		greetings: Array.isArray(raw.greetings)
			? raw.greetings.filter((item): item is NewMemberGreeting =>
				Boolean(item && item.kind === "square" && typeof item.chatMid === "string"))
			: [],
	};
}

class NewMemberGreetingStore {
	private data: GreetingFile = structuredClone(EMPTY);
	private githubSha: string | undefined;
	private saveQueue: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.newMemberGreetingsFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.newMemberGreetingsGithubPath);
				if (remote) {
					this.data = parseFile(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[newmember] restored ${this.data.greetings.length} setting(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[newmember] GitHub restore failed; using local storage", error);
			}
		}
		try {
			this.data = parseFile(JSON.parse(await fs.readFile(appConfig.newMemberGreetingsFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[newmember] loaded ${this.data.greetings.length} setting(s)`);
	}

	has(target: Pick<LineDestination, "kind" | "chatMid"> | Pick<NewMemberGreeting, "kind" | "chatMid">): boolean {
		if (target.kind !== "square") return false;
		const key = targetKey(target);
		return this.data.greetings.some((item) => targetKey(item) === key);
	}

	get(target: Pick<LineDestination, "kind" | "chatMid"> | Pick<NewMemberGreeting, "kind" | "chatMid">): NewMemberGreeting | undefined {
		if (target.kind !== "square") return undefined;
		const key = targetKey(target);
		const found = this.data.greetings.find((item) => targetKey(item) === key);
		return found ? { ...found } : undefined;
	}

	async enable(destination: LineDestination): Promise<boolean> {
		if (destination.kind !== "square" || destination.chatType !== "SQUARE") {
			throw new Error("参加挨拶はOpenChatでのみ設定できます");
		}
		const key = targetKey(destination);
		if (this.data.greetings.some((item) => targetKey(item) === key)) return false;
		this.data.greetings.push({
			kind: "square",
			chatMid: destination.chatMid,
			registeredBy: destination.senderMid,
			registeredAt: new Date().toISOString(),
		});
		await this.save();
		return true;
	}

	async disable(destination: Pick<LineDestination, "kind" | "chatMid">): Promise<boolean> {
		if (destination.kind !== "square") return false;
		const key = targetKey(destination);
		const before = this.data.greetings.length;
		this.data.greetings = this.data.greetings.filter((item) => targetKey(item) !== key);
		if (this.data.greetings.length === before) return false;
		await this.save();
		return true;
	}

	private async save(): Promise<void> {
		const operation = this.saveQueue.then(async () => {
			await this.writeLocal();
			if (githubContentsClient.enabled) {
				this.githubSha = await githubContentsClient.write(
					appConfig.newMemberGreetingsGithubPath,
					`${JSON.stringify(this.data, null, 2)}\n`,
					"Update LINE new member greeting settings",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch(() => {});
		await operation;
	}

	private async writeLocal(): Promise<void> {
		const temporary = `${appConfig.newMemberGreetingsFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.newMemberGreetingsFile);
	}
}

export const newMemberGreetingStore = new NewMemberGreetingStore();
