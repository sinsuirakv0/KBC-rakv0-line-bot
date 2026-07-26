import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { runtimeWorkload } from "../runtime/workload.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface OcMemberActivity {
	squareMid: string;
	memberMid: string;
	displayName?: string;
	firstSeenAt: string;
	firstJoinAt?: string;
	latestJoinAt?: string;
	latestLeftAt?: string;
	lastRecordedLeftAt?: string;
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
	recorded: boolean;
	ignoreReason?: "duplicate-or-historical-leave" | "leave-before-latest-join";
	stayMs?: number;
	messageCount: number;
	joinedAt?: string;
	lastMessageAt?: string;
	lastMessageText?: string;
	remainingChatMids: string[];
	isFirstJoin: boolean;
}

export interface OcJoinRecordResult {
	activity: OcMemberActivity;
	isFirstJoin: boolean;
	recorded: boolean;
	reason: "recorded" | "duplicate-active" | "historical";
}

export interface OcMemberActivityDiagnostics {
	records: number;
	activeMembers: number;
	lastJoinAt?: string;
	lastLeaveAt?: string;
}

interface OcMemberActivityFile {
	version: 1;
	activities: OcMemberActivity[];
}

const EMPTY_ACTIVITY: OcMemberActivityFile = { version: 1, activities: [] };
const MAX_ACTIVITIES = 10_000;
const ACTIVITY_TRIM_BUFFER = 100;

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
				lastRecordedLeftAt: stringValue(item.lastRecordedLeftAt) ?? stringValue(item.latestLeftAt),
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
	private readonly activitiesByKey = new Map<string, OcMemberActivity>();
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
					this.rebuildIndex();
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
		this.rebuildIndex();
		console.log(`[oc-activity] loaded ${this.data.activities.length} activity record(s)`);
	}

	snapshot(squareMid: string, memberMid: string): OcMemberActivity | undefined {
		const activity = this.activitiesByKey.get(activityKey(squareMid, memberMid));
		return activity ? structuredClone(activity) : undefined;
	}

	recordSquareJoin(input: OcJoinInput): OcJoinRecordResult {
		const at = isoFromMs(input.at);
		const activity = this.ensureActivity(input.squareMid, input.memberMid, at);
		const atMs = millisFromIso(at) ?? Date.now();
		const latestLeftAtMs = millisFromIso(activity.latestLeftAt);
		if (latestLeftAtMs !== undefined && atMs <= latestLeftAtMs) {
			return {
				activity: structuredClone(activity),
				isFirstJoin: activity.totalJoinCount <= 1,
				recorded: false,
				reason: "historical",
			};
		}
		const hasActiveSquareMembership = Boolean(activity.latestJoinAt && !activity.latestLeftAt);
		if (hasActiveSquareMembership) {
			activity.displayName = input.displayName ?? activity.displayName;
			activity.activeChatMids = addUnique(activity.activeChatMids, input.squareChatMid);
			activity.joinedChatMids = addUnique(activity.joinedChatMids, input.squareChatMid);
			activity.updatedAt = nowIso();
			this.scheduleSave();
			return {
				activity: structuredClone(activity),
				isFirstJoin: activity.totalJoinCount <= 1,
				recorded: false,
				reason: "duplicate-active",
			};
		}
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
		return {
			activity: structuredClone(activity),
			isFirstJoin: previousJoinCount === 0,
			recorded: true,
			reason: "recorded",
		};
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
		activity.updatedAt = nowIso();
		this.scheduleSave();
		return structuredClone(activity);
	}

	recordSquareLeave(input: OcLeaveInput): OcLeaveDecisionInfo {
		const leftAt = isoFromMs(input.at);
		const activity = this.ensureActivity(input.squareMid, input.memberMid, leftAt);
		activity.displayName = input.displayName ?? activity.displayName;
		const leftAtMs = millisFromIso(leftAt) ?? Date.now();
		const latestJoinAtMs = millisFromIso(activity.latestJoinAt);
		const ignoreReason = latestJoinAtMs !== undefined && leftAtMs < latestJoinAtMs
			? "leave-before-latest-join"
			: activity.latestLeftAt !== undefined
				? "duplicate-or-historical-leave"
				: undefined;
		if (ignoreReason) {
			return {
				activity: structuredClone(activity),
				recorded: false,
				ignoreReason,
				messageCount: activity.currentSessionMessageCount,
				joinedAt: activity.latestJoinAt,
				lastMessageAt: activity.lastMessageAt,
				lastMessageText: activity.lastMessageText,
				remainingChatMids: [...activity.activeChatMids],
				isFirstJoin: activity.totalJoinCount <= 1,
			};
		}
		const remainingChatMids = input.clearAllChats ? [] : removeValue(activity.activeChatMids, input.squareChatMid);
		const joinAtMs = millisFromIso(activity.latestJoinAt);
		const stayMs = joinAtMs !== undefined && leftAtMs >= joinAtMs
			? leftAtMs - joinAtMs
			: undefined;
		const info: OcLeaveDecisionInfo = {
			activity: structuredClone(activity),
			recorded: true,
			stayMs,
			messageCount: activity.currentSessionMessageCount,
			joinedAt: activity.latestJoinAt,
			lastMessageAt: activity.lastMessageAt,
			lastMessageText: activity.lastMessageText,
			remainingChatMids,
			isFirstJoin: activity.totalJoinCount <= 1,
		};
		activity.latestLeftAt = leftAt;
		activity.lastRecordedLeftAt = leftAt;
		activity.activeChatMids = remainingChatMids;
		activity.updatedAt = nowIso();
		this.scheduleSave();
		return info;
	}

	diagnostics(squareMid: string): OcMemberActivityDiagnostics {
		let records = 0;
		let activeMembers = 0;
		let lastJoinAt: string | undefined;
		let lastLeaveAt: string | undefined;
		for (const activity of this.data.activities) {
			if (activity.squareMid !== squareMid) continue;
			records += 1;
			if (activity.latestJoinAt && !activity.latestLeftAt) activeMembers += 1;
			if (activity.latestJoinAt && (!lastJoinAt || activity.latestJoinAt > lastJoinAt)) {
				lastJoinAt = activity.latestJoinAt;
			}
			const recordedLeftAt = activity.lastRecordedLeftAt ?? activity.latestLeftAt;
			if (recordedLeftAt && (!lastLeaveAt || recordedLeftAt > lastLeaveAt)) {
				lastLeaveAt = recordedLeftAt;
			}
		}
		return { records, activeMembers, lastJoinAt, lastLeaveAt };
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
			const activity = this.activitiesByKey.get(activityKey(squareMid, memberMid));
			if (!activity) continue;
			activity.watchCohortId = cohortId;
			activity.watchUntil = watchUntil;
			activity.updatedAt = nowIso();
		}
		this.scheduleSave();
	}

	cohortWatch(squareMid: string, memberMid: string): { cohortId: string; watchUntil: string } | undefined {
		const activity = this.activitiesByKey.get(activityKey(squareMid, memberMid));
		if (!activity?.watchCohortId || !activity.watchUntil) return undefined;
		if ((millisFromIso(activity.watchUntil) ?? 0) <= Date.now()) return undefined;
		return { cohortId: activity.watchCohortId, watchUntil: activity.watchUntil };
	}

	rememberCohortReason(squareMid: string, memberMid: string, reason: string): boolean {
		const activity = this.activitiesByKey.get(activityKey(squareMid, memberMid));
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
		const key = activityKey(squareMid, memberMid);
		let activity = this.activitiesByKey.get(key);
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
			this.activitiesByKey.set(key, activity);
			this.trim();
		}
		return activity;
	}

	private trim(): void {
		if (this.data.activities.length <= MAX_ACTIVITIES + ACTIVITY_TRIM_BUFFER) return;
		this.data.activities.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
		this.data.activities = this.data.activities.slice(-MAX_ACTIVITIES);
		this.rebuildIndex();
	}

	private rebuildIndex(): void {
		this.activitiesByKey.clear();
		for (const activity of this.data.activities) {
			this.activitiesByKey.set(activityKey(activity.squareMid, activity.memberMid), activity);
		}
	}

	private scheduleSave(
		delayMs = appConfig.ocMemberActivitySaveDelayMs,
		allowRecentForeground = false,
	): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			if (!runtimeWorkload.canRunBackground(allowRecentForeground ? 0 : appConfig.backgroundQuietMs)) {
				this.scheduleSave(appConfig.backgroundRetryMs, true);
				return;
			}
			void runtimeWorkload.runBackground("oc-member-activity-save", async () => {
				await this.flush();
			}).catch((error) => {
				console.error("[oc-activity] scheduled save failed", error);
			});
		}, delayMs);
	}

	private async writeLocal(value: OcMemberActivityFile = this.data): Promise<void> {
		const temporary = `${appConfig.ocMemberActivityFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.ocMemberActivityFile);
	}
}

export const ocMemberActivityStore = new OcMemberActivityStore();
