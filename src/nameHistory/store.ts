import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

type NameHistoryKind = "talk" | "square";

interface StoredName {
	name: string;
	firstSeenAt: string;
	lastSeenAt: string;
	count: number;
}

interface StoredUser {
	kind: NameHistoryKind;
	scopeMid: string;
	mid: string;
	names: StoredName[];
}

interface NameHistoryFile {
	version: 1;
	users: StoredUser[];
}

export interface NameHistoryEntry {
	name: string;
	firstSeenAt: string;
	lastSeenAt: string;
	count: number;
}

const EMPTY_HISTORY: NameHistoryFile = { version: 1, users: [] };
const SAVE_DELAY_MS = 10_000;

function keyOf(value: Pick<StoredUser, "kind" | "scopeMid" | "mid">): string {
	return `${value.kind}:${value.scopeMid}:${value.mid}`;
}

function nowIso(time = Date.now()): string {
	return new Date(time).toISOString();
}

function cleanStoredName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (/^[up][0-9a-f]{8,}$/i.test(trimmed)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(trimmed)) return undefined;
	if (/^[\p{C}\s]+$/u.test(trimmed)) return undefined;
	return trimmed;
}

function parseHistory(value: unknown): NameHistoryFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_HISTORY);
	const raw = value as Partial<NameHistoryFile>;
	const users = Array.isArray(raw.users) ? raw.users : [];
	return {
		version: 1,
		users: users.flatMap((user) => {
			if (!user || (user.kind !== "talk" && user.kind !== "square") ||
				typeof user.scopeMid !== "string" || typeof user.mid !== "string") return [];
			const names = Array.isArray(user.names) ? user.names : [];
			return [{
				kind: user.kind,
				scopeMid: user.scopeMid,
				mid: user.mid,
				names: names.flatMap((name) => {
					if (!name || typeof name.name !== "string" || !name.name.trim()) return [];
					return [{
						name: name.name,
						firstSeenAt: typeof name.firstSeenAt === "string" ? name.firstSeenAt : nowIso(),
						lastSeenAt: typeof name.lastSeenAt === "string" ? name.lastSeenAt : nowIso(),
						count: Number.isInteger(name.count) && name.count > 0 ? name.count : 1,
					}];
				}),
			}];
		}),
	};
}

class MemberNameHistoryStore {
	private data: NameHistoryFile = structuredClone(EMPTY_HISTORY);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.memberNameHistoryFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.memberNameHistoryGithubPath);
				if (remote) {
					this.data = parseHistory(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[name-history] loaded ${this.data.users.length} user(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[name-history] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseHistory(JSON.parse(await fs.readFile(appConfig.memberNameHistoryFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[name-history] loaded ${this.data.users.length} user(s)`);
	}

	record(
		kind: NameHistoryKind,
		scopeMid: string,
		mid: string,
		name: string | undefined,
		seenAt = Date.now(),
	): void {
		const normalizedName = cleanStoredName(name);
		if (!normalizedName || !mid || !scopeMid) return;
		const seenIso = nowIso(seenAt);
		let user = this.data.users.find((item) => keyOf(item) === `${kind}:${scopeMid}:${mid}`);
		if (!user) {
			user = { kind, scopeMid, mid, names: [] };
			this.data.users.push(user);
		}
		const entry = user.names.find((item) => item.name === normalizedName);
		if (entry) {
			entry.lastSeenAt = seenIso;
			entry.count += 1;
		} else {
			user.names.push({
				name: normalizedName,
				firstSeenAt: seenIso,
				lastSeenAt: seenIso,
				count: 1,
			});
		}
		this.scheduleSave();
	}

	get(kind: NameHistoryKind, scopeMid: string, mid: string): NameHistoryEntry[] {
		const user = this.data.users.find((item) => keyOf(item) === `${kind}:${scopeMid}:${mid}`);
		return [...(user?.names ?? [])]
			.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
			.map((entry) => ({ ...entry }));
	}

	squareScopeMids(): string[] {
		return [...new Set(this.data.users
			.filter((user) => user.kind === "square")
			.map((user) => user.scopeMid))];
	}

	async scanKnownSquareNames(client: Client): Promise<void> {
		for (const squareMid of this.squareScopeMids()) {
			let continuationToken: string | undefined;
			for (let page = 0; page < 20; page++) {
				const response = await client.base.square.searchSquareMembers({
					request: {
						squareMid,
						searchOption: {
							membershipState: "JOINED",
							memberRoles: [],
							displayName: "",
							ableToReceiveMessage: "NONE",
							ableToReceiveFriendRequest: "NONE",
							chatMidToExcludeMembers: "",
							includingMe: true,
							excludeBlockedMembers: false,
							includingMeOnlyMatch: false,
						},
						continuationToken,
						limit: 100,
					},
				});
				for (const member of response.members) {
					this.record("square", squareMid, member.squareMemberMid, member.displayName);
				}
				continuationToken = response.continuationToken || undefined;
				if (!continuationToken || response.members.length === 0) break;
			}
		}
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
					appConfig.memberNameHistoryGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update LINE member name history",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[name-history] save failed", error);
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
				console.error("[name-history] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: NameHistoryFile = this.data): Promise<void> {
		const temporary = `${appConfig.memberNameHistoryFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.memberNameHistoryFile);
	}
}

export const memberNameHistoryStore = new MemberNameHistoryStore();
