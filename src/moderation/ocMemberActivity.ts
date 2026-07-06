import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface OcMemberActivity {
	squareMid: string;
	memberMid: string;
	displayName?: string;
	firstSeenAt: string;
	firstJoinAt?: string;
	latestJoinAt?: string;
	latestLeftAt?: string;
	totalJoinCount: number;
	messageCount: number;
	currentSessionMessageCount: number;
	lastMessageAt?: string;
	lastMessageText?: string;
	activeChatMids: string[];
	joinedChatMids: string[];
	watchUntil?: string;
	watchCohortId?: string;
	loggedCohortReasons: string[];
	updatedAt: string;
}

export interface OcJoinInput {
	squareMid: string;
	squareChatMid?: string;
	memberMid: string;
	displayName?: string;
	at?: number;
}

export interface OcMessageInput {
	squareMid: string;
	squareChatMid: string;
	memberMid: string;
	displayName?: string;
	text?: string;
	at?: number;
}

export interface OcLeaveInput extends OcJoinInput {
	clearAllChats?: boolean;
}

export interface OcLeaveDecisionInfo {
	activity: OcMemberActivity;
	stayMs?: number;
	messageCount: number;
	remainingChatMids: string[];
	isFirstJoin: boolean;
}

interface OcMemberActivityFile {
	version: 1;
	activities: OcMemberActivity[];
}

const EMPTY_ACTIVITY: OcMemberActivityFile = { version: 1, activities: [] };
const SAVE_DELAY_MS = 5_000;
const MAX_ACTIVITIES = 10_000;

function nowIso(): string {
	return new Date().toISOString();
}

function isoFromMs(value: number | undefined): string {
	const millis = Number.isFinite(value) && value !== undefined && value > 0 ? value : Date.now();
	return new Date(millis).toISOString();
}

function millisFromIso(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const millis = new Date(value).getTime();
	return Number.isFinite(millis) ? millis : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.flatMap((item) => {
		const text = stringValue(item);
		return text ? [text] : [];
	}))];
}

function parseActivity(value: unknown): OcMemberActivityFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_ACTIVITY);
	const raw = value as Partial<OcMemberActivityFile>;
	const activities = Array.isArray(raw.activities) ? raw.activities : [];
	return {
		version: 1,
		activities: activities.flatMap((activity) => {
			const item = activity as Partial<OcMemberActivity>;
			const squareMid = stringValue(item.squareMid);
			const memberMid = stringValue(item.memberMid);
			const firstSeenAt = stringValue(item.firstSeenAt);
			if (!squareMid || !memberMid || !firstSeenAt) return [];
			return [{
				squareMid,
				memberMid,
				displayName: stringValue(item.displayName),
				firstSeenAt,
				firstJoinAt: stringValue(item.firstJoinAt),
				latestJoinAt: stringValue(item.latestJoinAt),
				latestLeftAt: stringValue(item.latestLeftAt),
				totalJoinCount: Math.max(0, Math.floor(Number(item.totalJoinCount) || 0)),
				messageCount: Math.max(0, Math.floor(Number(item.messageCount) || 0)),
				currentSessionMessageCount: Math.max(0, Math.floor(Number(item.currentSessionMessageCount) || 0)),
				lastMessageAt: stringValue(item.lastMessageAt),
				lastMessageText: stringValue(item.lastMessageText),
				activeChatMids: stringArray(item.activeChatMids),
				joinedChatMids: stringArray(item.joinedChatMids),
				watchUntil: stringValue(item.watchUntil),
				watchCohortId: stringValue(item.watchCohortId),
				loggedCohortReasons: stringArray(item.loggedCohortReasons),
				updatedAt: stringValue(item.updatedAt) ?? nowIso(),
			}];
		}).slice(-MAX_ACTIVITIES),
	};
}

function activityKey(squareMid: string, memberMid: string): string {
	return `${squareMid}:${memberMid}`;
}

function addUnique(list: string[], value: string | undefined): string[] {
	if (!value) return list;
	return list.includes(value) ? list : [...list, value];
}

function removeValue(list: string[], value: string | undefined): string[] {
	if (!value) return list;
	return list.filter((item) => item !== value);
}

class OcMemberActivityStore {
	private data: OcMemberActivityFile = structuredClone(EMPTY_ACTIVITY);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.ocMemberActivityFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.ocMemberActivityGithubPath);
				if (remote) {
					this.data = parseActivity(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[oc-activity] loaded ${this.data.activities.length} activity record(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[oc-activity] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseActivity(JSON.parse(await fs.readFile(appConfig.ocMemberActivityFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[oc-activity] loaded ${this.data.activities.length} activity record(s)`);
	}

	snapshot(squareMid: string, memberMid: string): OcMemberActivity | undefined {
		const activity = this.data.activities.find((item) => item.squareMid === squareMid && item.memberMid === memberMid);
		return activity ? structuredClone(activity) : undefined;
	}

	recordSquareJoin(input: OcJoinInput): { activity: OcMemberActivity; isFirstJoin: boolean } {
		const at = isoFromMs(input.at);
		const activity = this.ensureActivity(input.squareMid, input.memberMid, at);
		const previousJoinCount = activity.totalJoinCount;
		activity.displayName = input.displayName ?? activity.displayName;
		if (!activity.firstJoinAt) activity.firstJoinAt = at;
		activity.latestJoinAt = at;
		activity.latestLeftAt = undefined;
		activity.totalJoinCount += 1;
		activity.currentSessionMessageCount = 0;
		activity.activeChatMids = addUnique(activity.activeChatMids, input.squareChatMid);
		activity.joinedChatMids = addUnique(activity.joinedChatMids, input.squareChatMid);
		activity.updatedAt = nowIso();
		this.trim();
		this.scheduleSave();
		return { activity: structuredClone(activity), isFirstJoin: previousJoinCount === 0 };
	}

	recordChatJoin(input: OcJoinInput): OcMemberActivity {
		const at = isoFromMs(input.at);
		const activity = this.ensureActivity(input.squareMid, input.memberMid, at);
		activity.displayName = input.displayName ?? activity.displayName;
		activity.activeChatMids = addUnique(activity.activeChatMids, input.squareChatMid);
		activity.joinedChatMids = addUnique(activity.joinedChatMids, input.squareChatMid);
		activity.updatedAt = nowIso();
		this.scheduleSave();
		return structuredClone(activity);
	}

	recordChatLeave(input: OcLeaveInput): OcMemberActivity {
		const activity = this.ensureActivity(input.squareMid, input.memberMid, isoFromMs(input.at));
		activity.displayName = input.displayName ?? activity.displayName;
		activity.activeChatMids = input.clearAllChats
			? []
			: removeValue(activity.activeChatMids, input.squareChatMid);
		activity.latestLeftAt = isoFromMs(input.at);
		activity.updatedAt = nowIso();
		this.scheduleSave();
		return structuredClone(activity);
	}

	recordSquareLeave(input: OcLeaveInput): OcLeaveDecisionInfo {
		const leftAt = isoFromMs(input.at);
		const activity = this.ensureActivity(input.squareMid, input.memberMid, leftAt);
		activity.displayName = input.displayName ?? activity.displayName;
		const remainingChatMids = input.clearAllChats ? [] : removeValue(activity.activeChatMids, input.squareChatMid);
		const joinAtMs = millisFromIso(activity.latestJoinAt);
		const leftAtMs = millisFromIso(leftAt);
		const stayMs = joinAtMs !== undefined && leftAtMs !== undefined && leftAtMs >= joinAtMs
			? leftAtMs - joinAtMs
			: undefined;
		const info: OcLeaveDecisionInfo = {
			activity: structuredClone(activity),
			stayMs,
			messageCount: activity.currentSessionMessageCount,
			remainingChatMids,
			isFirstJoin: activity.totalJoinCount <= 1,
		};
		activity.latestLeftAt = leftAt;
		activity.activeChatMids = remainingChatMids;
		activity.updatedAt = nowIso();
		this.scheduleSave();
		return info;
	}

	recordMessage(input: OcMessageInput): OcMemberActivity {
		const at = isoFromMs(input.at);
		const activity = this.ensureActivity(input.squareMid, input.memberMid, at);
		activity.displayName = input.displayName ?? activity.displayName;
		activity.messageCount += 1;
		activity.currentSessionMessageCount += 1;
		activity.lastMessageAt = at;
		activity.lastMessageText = input.text?.replace(/\s+/g, " ").trim().slice(0, 300);
		activity.activeChatMids = addUnique(activity.activeChatMids, input.squareChatMid);
		activity.joinedChatMids = addUnique(activity.joinedChatMids, input.squareChatMid);
		activity.updatedAt = nowIso();
		this.scheduleSave();
		return structuredClone(activity);
	}

	recentFirstJoins(squareMid: string, sinceMs: number): OcMemberActivity[] {
		return this.data.activities
			.filter((activity) => {
				if (activity.squareMid !== squareMid || activity.totalJoinCount !== 1 || !activity.firstJoinAt) return false;
				const joinedAt = millisFromIso(activity.firstJoinAt);
				return joinedAt !== undefined && joinedAt >= sinceMs;
			})
			.map((activity) => structuredClone(activity));
	}

	markCohort(squareMid: string, memberMids: string[], cohortId: string, watchUntil: string): void {
		for (const memberMid of memberMids) {
			const activity = this.data.activities.find((item) => item.squareMid === squareMid && item.memberMid === memberMid);
			if (!activity) continue;
			activity.watchCohortId = cohortId;
			activity.watchUntil = watchUntil;
			activity.updatedAt = nowIso();
		}
		this.scheduleSave();
	}

	cohortWatch(squareMid: string, memberMid: string): { cohortId: string; watchUntil: string } | undefined {
		const activity = this.data.activities.find((item) => item.squareMid === squareMid && item.memberMid === memberMid);
		if (!activity?.watchCohortId || !activity.watchUntil) return undefined;
		if ((millisFromIso(activity.watchUntil) ?? 0) <= Date.now()) return undefined;
		return { cohortId: activity.watchCohortId, watchUntil: activity.watchUntil };
	}

	rememberCohortReason(squareMid: string, memberMid: string, reason: string): boolean {
		const activity = this.data.activities.find((item) => item.squareMid === squareMid && item.memberMid === memberMid);
		if (!activity) return false;
		if (activity.loggedCohortReasons.includes(reason)) return false;
		activity.loggedCohortReasons.push(reason);
		activity.updatedAt = nowIso();
		this.scheduleSave();
		return true;
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
					appConfig.ocMemberActivityGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update OpenChat member activity",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[oc-activity] save failed", error);
			this.dirty = true;
			this.scheduleSave();
		});
		await operation;
	}

	private ensureActivity(squareMid: string, memberMid: string, at: string): OcMemberActivity {
		let activity = this.data.activities.find((item) =>
			item.squareMid === squareMid && item.memberMid === memberMid
		);
		if (!activity) {
			activity = {
				squareMid,
				memberMid,
				firstSeenAt: at,
				totalJoinCount: 0,
				messageCount: 0,
				currentSessionMessageCount: 0,
				activeChatMids: [],
				joinedChatMids: [],
				loggedCohortReasons: [],
				updatedAt: nowIso(),
			};
			this.data.activities.push(activity);
		}
		return activity;
	}

	private trim(): void {
		if (this.data.activities.length <= MAX_ACTIVITIES) return;
		this.data.activities.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
		this.data.activities = this.data.activities.slice(-MAX_ACTIVITIES);
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush().catch((error) => {
				console.error("[oc-activity] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: OcMemberActivityFile = this.data): Promise<void> {
		const temporary = `${appConfig.ocMemberActivityFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.ocMemberActivityFile);
	}
}

export const ocMemberActivityStore = new OcMemberActivityStore();
