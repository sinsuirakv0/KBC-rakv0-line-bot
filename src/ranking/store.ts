import fs from "node:fs/promises";
import path from "node:path";
import type { LineDestination } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

interface RankingUser {
	mid: string;
	name: string;
	count: number;
}

interface RankingScope {
	kind: "talk" | "square";
	scopeMid: string;
	totalCommands: number;
	users: RankingUser[];
}

interface RankingFile {
	version: 1;
	totalCommands: number;
	scopes: RankingScope[];
}

export interface RankingSnapshot {
	totalCommands: number;
	scopeTotalCommands: number;
	users: RankingUser[];
}

const EMPTY_RANKING: RankingFile = { version: 1, totalCommands: 0, scopes: [] };
const SAVE_DELAY_MS = 10_000;

function scopeKey(value: Pick<LineDestination, "kind" | "scopeMid">): string {
	return `${value.kind}:${value.scopeMid}`;
}

function parseRanking(value: unknown): RankingFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_RANKING);
	const raw = value as Partial<RankingFile>;
	const scopes = Array.isArray(raw.scopes) ? raw.scopes : [];
	return {
		version: 1,
		totalCommands: Number.isInteger(raw.totalCommands) && (raw.totalCommands ?? 0) >= 0
			? raw.totalCommands as number
			: 0,
		scopes: scopes.flatMap((scope) => {
			if (!scope || (scope.kind !== "talk" && scope.kind !== "square") ||
				typeof scope.scopeMid !== "string") return [];
			const users = Array.isArray(scope.users) ? scope.users : [];
			return [{
				kind: scope.kind,
				scopeMid: scope.scopeMid,
				totalCommands: Number.isInteger(scope.totalCommands) && scope.totalCommands >= 0
					? scope.totalCommands
					: 0,
				users: users.flatMap((user) =>
					user && typeof user.mid === "string" && Number.isInteger(user.count) && user.count >= 0
						? [{ mid: user.mid, name: typeof user.name === "string" ? user.name : user.mid, count: user.count }]
						: []
				),
			}];
		}),
	};
}

class RankingStore {
	private data: RankingFile = structuredClone(EMPTY_RANKING);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.rankingFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.rankingGithubPath);
				if (remote) {
					this.data = parseRanking(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[ranking] loaded ${this.data.scopes.length} scope(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[ranking] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseRanking(JSON.parse(await fs.readFile(appConfig.rankingFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[ranking] loaded ${this.data.scopes.length} scope(s)`);
	}

	record(destination: LineDestination): void {
		const scope = this.getOrCreateScope(destination);
		const user = scope.users.find((item) => item.mid === destination.senderMid);
		if (user) {
			user.count += 1;
			if (destination.senderName) user.name = destination.senderName;
		} else {
			scope.users.push({
				mid: destination.senderMid,
				name: destination.senderName || destination.senderMid,
				count: 1,
			});
		}
		scope.totalCommands += 1;
		this.data.totalCommands += 1;
		this.scheduleSave();
	}

	updateName(kind: "talk" | "square", mid: string, name: string): void {
		if (!name.trim()) return;
		let changed = false;
		for (const scope of this.data.scopes) {
			if (scope.kind !== kind) continue;
			const user = scope.users.find((item) => item.mid === mid);
			if (user && user.name !== name) {
				user.name = name;
				changed = true;
			}
		}
		if (changed) this.scheduleSave();
	}

	get(destination: Pick<LineDestination, "kind" | "scopeMid">): RankingSnapshot {
		const scope = this.data.scopes.find((item) => scopeKey(item) === scopeKey(destination));
		return {
			totalCommands: this.data.totalCommands,
			scopeTotalCommands: scope?.totalCommands ?? 0,
			users: [...(scope?.users ?? [])]
				.sort((left, right) => right.count - left.count ||
					left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid))
				.map((user) => ({ ...user })),
		};
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
					appConfig.rankingGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update LINE command ranking",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[ranking] save failed", error);
			this.dirty = true;
			this.scheduleSave();
		});
		await operation;
	}

	private getOrCreateScope(destination: LineDestination): RankingScope {
		const existing = this.data.scopes.find((item) => scopeKey(item) === scopeKey(destination));
		if (existing) return existing;
		const scope: RankingScope = {
			kind: destination.kind,
			scopeMid: destination.scopeMid,
			totalCommands: 0,
			users: [],
		};
		this.data.scopes.push(scope);
		return scope;
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush().catch((error) => {
				console.error("[ranking] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: RankingFile = this.data): Promise<void> {
		const temporary = `${appConfig.rankingFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.rankingFile);
	}
}

export const rankingStore = new RankingStore();
