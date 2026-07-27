import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { runtimeWorkload } from "../runtime/workload.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface OcRecentChatPresence {
	chatMid: string;
	joinedAt?: string;
	leftAt?: string;
	active: boolean;
}

export interface OcRecentPresence {
	squareMid: string;
	memberMid: string;
	displayName?: string;
	joinedAt: string;
	leftAt?: string;
	squareActive: boolean;
	isFirstJoin: boolean;
	messageCount: number;
	lastMessageAt?: string;
	lastMessageText?: string;
	chats: OcRecentChatPresence[];
	expiresAt: string;
	updatedAt: string;
}

export interface OcRecentJoinInput {
	squareMid: string;
	squareChatMid?: string;
	memberMid: string;
	displayName?: string;
	at?: number;
	isFirstJoin: boolean;
}

export interface OcRecentChatInput {
	squareMid: string;
	squareChatMid?: string;
	memberMid: string;
	displayName?: string;
	at?: number;
}

export interface OcRecentMessageInput extends OcRecentChatInput {
	text?: string;
}

export interface OcRecentLeaveDecisionInfo {
	presence?: OcRecentPresence;
	recorded: boolean;
	ignoreReason?:
		| "session-not-found"
		| "outside-monitoring-window"
		| "duplicate-or-historical-leave"
		| "leave-before-join";
	stayMs?: number;
	messageCount: number;
	joinedAt?: string;
	lastMessageAt?: string;
	lastMessageText?: string;
	remainingChatMids: string[];
	isFirstJoin: boolean;
	displayName?: string;
}

interface OcRecentPresenceFile {
	version: 1;
	presences: OcRecentPresence[];
}

const MONITORING_WINDOW_MS = 30 * 60_000;
const MAX_CLOCK_FUTURE_MS = 60_000;
const EMPTY_FILE: OcRecentPresenceFile = { version: 1, presences: [] };

function nowIso(): string {
	return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function millisFromIso(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const millis = new Date(value).getTime();
	return Number.isFinite(millis) ? millis : undefined;
}

function eventTime(value: number | undefined): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return Date.now();
	return Math.min(value, Date.now() + MAX_CLOCK_FUTURE_MS);
}

function presenceKey(squareMid: string, memberMid: string): string {
	return `${squareMid}:${memberMid}`;
}

function parseChat(value: unknown): OcRecentChatPresence | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Partial<OcRecentChatPresence>;
	const chatMid = stringValue(item.chatMid);
	if (!chatMid) return undefined;
	return {
		chatMid,
		joinedAt: stringValue(item.joinedAt),
		leftAt: stringValue(item.leftAt),
		active: item.active === true,
	};
}

function parseFile(value: unknown): OcRecentPresenceFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_FILE);
	const raw = value as Partial<OcRecentPresenceFile>;
	const presences = Array.isArray(raw.presences) ? raw.presences : [];
	return {
		version: 1,
		presences: presences.flatMap((value) => {
			const item = value as Partial<OcRecentPresence>;
			const squareMid = stringValue(item.squareMid);
			const memberMid = stringValue(item.memberMid);
			const joinedAt = stringValue(item.joinedAt);
			const expiresAt = stringValue(item.expiresAt);
			if (!squareMid || !memberMid || !joinedAt || !expiresAt) return [];
			return [{
				squareMid,
				memberMid,
				displayName: stringValue(item.displayName),
				joinedAt,
				leftAt: stringValue(item.leftAt),
				squareActive: item.squareActive === true,
				isFirstJoin: item.isFirstJoin === true,
				messageCount: Math.max(0, Math.floor(Number(item.messageCount) || 0)),
				lastMessageAt: stringValue(item.lastMessageAt),
				lastMessageText: stringValue(item.lastMessageText),
				chats: Array.isArray(item.chats)
					? item.chats.flatMap((chat) => {
						const parsed = parseChat(chat);
						return parsed ? [parsed] : [];
					})
					: [],
				expiresAt,
				updatedAt: stringValue(item.updatedAt) ?? joinedAt,
			}];
		}),
	};
}

function activeChatMids(presence: OcRecentPresence): string[] {
	return presence.chats.filter((chat) => chat.active).map((chat) => chat.chatMid);
}

class OcRecentPresenceStore {
	private data: OcRecentPresenceFile = structuredClone(EMPTY_FILE);
	private readonly presencesByKey = new Map<string, OcRecentPresence>();
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.ocRecentPresenceFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.ocRecentPresenceGithubPath);
				if (remote) {
					this.data = parseFile(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					this.rebuildIndex();
					this.pruneExpired();
					await this.writeLocal();
					console.log(`[oc-recent-presence] loaded ${this.data.presences.length} record(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[oc-recent-presence] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseFile(JSON.parse(await fs.readFile(appConfig.ocRecentPresenceFile, "utf8")));
		} catch {
			this.data = structuredClone(EMPTY_FILE);
		}
		this.rebuildIndex();
		this.pruneExpired();
		await this.writeLocal();
		console.log(`[oc-recent-presence] loaded ${this.data.presences.length} record(s)`);
	}

	recordSquareJoin(input: OcRecentJoinInput): OcRecentPresence | undefined {
		const joinedAtMs = eventTime(input.at);
		if (Date.now() - joinedAtMs > MONITORING_WINDOW_MS) return undefined;
		this.pruneExpired();
		const key = presenceKey(input.squareMid, input.memberMid);
		const existing = this.presencesByKey.get(key);
		if (existing?.squareActive) {
			existing.displayName = input.displayName ?? existing.displayName;
			existing.isFirstJoin = existing.isFirstJoin && input.isFirstJoin;
			this.updateChat(existing, input.squareChatMid, joinedAtMs, true);
			existing.updatedAt = nowIso();
			this.scheduleSave();
			return structuredClone(existing);
		}
		const existingLeftAtMs = millisFromIso(existing?.leftAt);
		if (existingLeftAtMs !== undefined && joinedAtMs <= existingLeftAtMs) {
			return existing ? structuredClone(existing) : undefined;
		}

		const joinedAt = new Date(joinedAtMs).toISOString();
		const presence: OcRecentPresence = {
			squareMid: input.squareMid,
			memberMid: input.memberMid,
			displayName: input.displayName,
			joinedAt,
			squareActive: true,
			isFirstJoin: input.isFirstJoin,
			messageCount: 0,
			chats: [],
			expiresAt: new Date(joinedAtMs + MONITORING_WINDOW_MS).toISOString(),
			updatedAt: nowIso(),
		};
		this.updateChat(presence, input.squareChatMid, joinedAtMs, true);
		if (existing) {
			const index = this.data.presences.indexOf(existing);
			if (index >= 0) this.data.presences[index] = presence;
		} else {
			this.data.presences.push(presence);
		}
		this.presencesByKey.set(key, presence);
		this.scheduleSave();
		return structuredClone(presence);
	}

	recordChatJoin(input: OcRecentChatInput): OcRecentPresence | undefined {
		const presence = this.current(input.squareMid, input.memberMid);
		if (!presence || !presence.squareActive) return undefined;
		const atMs = eventTime(input.at);
		if (atMs < (millisFromIso(presence.joinedAt) ?? 0)) return structuredClone(presence);
		presence.displayName = input.displayName ?? presence.displayName;
		this.updateChat(presence, input.squareChatMid, atMs, true);
		presence.updatedAt = nowIso();
		this.scheduleSave();
		return structuredClone(presence);
	}

	recordChatLeave(input: OcRecentChatInput): OcRecentPresence | undefined {
		const presence = this.current(input.squareMid, input.memberMid);
		if (!presence) return undefined;
		const atMs = eventTime(input.at);
		if (atMs < (millisFromIso(presence.joinedAt) ?? 0)) return structuredClone(presence);
		presence.displayName = input.displayName ?? presence.displayName;
		this.updateChat(presence, input.squareChatMid, atMs, false);
		presence.updatedAt = nowIso();
		this.scheduleSave();
		return structuredClone(presence);
	}

	recordMessage(input: OcRecentMessageInput): OcRecentPresence | undefined {
		const presence = this.current(input.squareMid, input.memberMid);
		if (!presence || !presence.squareActive) return undefined;
		const atMs = eventTime(input.at);
		if (atMs < (millisFromIso(presence.joinedAt) ?? 0)) return structuredClone(presence);
		presence.displayName = input.displayName ?? presence.displayName;
		presence.messageCount += 1;
		presence.lastMessageAt = new Date(atMs).toISOString();
		presence.lastMessageText = input.text?.replace(/\s+/g, " ").trim().slice(0, 300);
		this.updateChat(presence, input.squareChatMid, atMs, true);
		presence.updatedAt = nowIso();
		// 発言ごとのGitHub書き込みは避け、次の参加・退出保存へ同梱する。
		return structuredClone(presence);
	}

	recordSquareLeave(input: OcRecentChatInput): OcRecentLeaveDecisionInfo {
		const leftAtMs = eventTime(input.at);
		const key = presenceKey(input.squareMid, input.memberMid);
		const presence = this.presencesByKey.get(key);
		if (!presence) return this.emptyDecision("session-not-found");
		const joinedAtMs = millisFromIso(presence.joinedAt);
		if (joinedAtMs === undefined || leftAtMs < joinedAtMs) {
			return this.decisionFromPresence(presence, false, "leave-before-join");
		}
		if (leftAtMs - joinedAtMs > MONITORING_WINDOW_MS) {
			this.remove(key, presence);
			this.scheduleSave();
			return this.decisionFromPresence(presence, false, "outside-monitoring-window");
		}
		if (presence.leftAt) {
			return this.decisionFromPresence(presence, false, "duplicate-or-historical-leave");
		}

		presence.displayName = input.displayName ?? presence.displayName;
		presence.leftAt = new Date(leftAtMs).toISOString();
		presence.squareActive = false;
		for (const chat of presence.chats) {
			if (!chat.active) continue;
			chat.active = false;
			chat.leftAt = presence.leftAt;
		}
		presence.updatedAt = nowIso();
		this.scheduleSave();
		return this.decisionFromPresence(presence, true);
	}

	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		this.pruneExpired();
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
					appConfig.ocRecentPresenceGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update recent OpenChat member presence",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[oc-recent-presence] save failed", error);
			this.dirty = true;
			this.scheduleSave();
		});
		await operation;
	}

	private current(squareMid: string, memberMid: string): OcRecentPresence | undefined {
		this.pruneExpired();
		return this.presencesByKey.get(presenceKey(squareMid, memberMid));
	}

	private decisionFromPresence(
		presence: OcRecentPresence,
		recorded: boolean,
		ignoreReason?: OcRecentLeaveDecisionInfo["ignoreReason"],
	): OcRecentLeaveDecisionInfo {
		const joinedAtMs = millisFromIso(presence.joinedAt);
		const leftAtMs = millisFromIso(presence.leftAt);
		return {
			presence: structuredClone(presence),
			recorded,
			ignoreReason,
			stayMs: joinedAtMs !== undefined && leftAtMs !== undefined
				? Math.max(0, leftAtMs - joinedAtMs)
				: undefined,
			messageCount: presence.messageCount,
			joinedAt: presence.joinedAt,
			lastMessageAt: presence.lastMessageAt,
			lastMessageText: presence.lastMessageText,
			remainingChatMids: activeChatMids(presence),
			isFirstJoin: presence.isFirstJoin,
			displayName: presence.displayName,
		};
	}

	private emptyDecision(ignoreReason: OcRecentLeaveDecisionInfo["ignoreReason"]): OcRecentLeaveDecisionInfo {
		return {
			recorded: false,
			ignoreReason,
			messageCount: 0,
			remainingChatMids: [],
			isFirstJoin: false,
		};
	}

	private updateChat(
		presence: OcRecentPresence,
		chatMid: string | undefined,
		atMs: number,
		active: boolean,
	): void {
		if (!chatMid) return;
		let chat = presence.chats.find((item) => item.chatMid === chatMid);
		if (!chat) {
			chat = { chatMid, active: false };
			presence.chats.push(chat);
		}
		const joinedAtMs = millisFromIso(chat.joinedAt);
		const leftAtMs = millisFromIso(chat.leftAt);
		if (active) {
			if (leftAtMs !== undefined && atMs <= leftAtMs) return;
			if (!chat.active) chat.joinedAt = new Date(atMs).toISOString();
			chat.leftAt = undefined;
		} else {
			if (joinedAtMs !== undefined && atMs < joinedAtMs) return;
			if (leftAtMs !== undefined && atMs <= leftAtMs) return;
			chat.leftAt = new Date(atMs).toISOString();
		}
		chat.active = active;
	}

	private pruneExpired(now = Date.now()): void {
		const retained = this.data.presences.filter((presence) => {
			const expiresAt = millisFromIso(presence.expiresAt);
			return expiresAt !== undefined && expiresAt > now;
		});
		if (retained.length === this.data.presences.length) return;
		this.data.presences = retained;
		this.rebuildIndex();
		this.dirty = true;
	}

	private remove(key: string, presence: OcRecentPresence): void {
		this.presencesByKey.delete(key);
		this.data.presences = this.data.presences.filter((item) => item !== presence);
		this.dirty = true;
	}

	private rebuildIndex(): void {
		this.presencesByKey.clear();
		for (const presence of this.data.presences) {
			this.presencesByKey.set(presenceKey(presence.squareMid, presence.memberMid), presence);
		}
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			if (!runtimeWorkload.canRunBackground(0)) {
				this.scheduleSave();
				return;
			}
			void runtimeWorkload.runBackground("oc-recent-presence-save", async () => {
				await this.flush();
			}).catch((error) => {
				console.error("[oc-recent-presence] scheduled save failed", error);
				this.scheduleSave();
			});
		}, appConfig.ocRecentPresenceSaveDelayMs);
	}

	private async writeLocal(value: OcRecentPresenceFile = this.data): Promise<void> {
		const temporary = `${appConfig.ocRecentPresenceFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.ocRecentPresenceFile);
	}
}

export const ocRecentPresenceStore = new OcRecentPresenceStore();
