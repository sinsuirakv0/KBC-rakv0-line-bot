import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";
import {
	parseOcUrlAllowRules,
	sameOcUrlRule,
	type OcUrlAllowRule,
} from "./ocUrlPolicy.js";
import { isOcMuteActive, type OcMuteEntry } from "./ocMute.js";

export interface OcModerationSetting {
	squareMid: string;
	linkDeleteEnabled: boolean;
	mediaBurstDeleteEnabled: boolean;
	leftSoonMonitoringEnabled: boolean;
	leftSoonSourceChatMid?: string;
	dangerWordAutoKickEnabled: boolean;
	dangerWordAutoReportEnabled: boolean;
	joinCohortWatchEnabled: boolean;
	modRoomChatMid?: string;
	modRoomSetAt?: string;
	modRoomSetBy?: string;
	urlAllowRules: OcUrlAllowRule[];
	mutes: OcMuteEntry[];
	updatedAt: string;
	updatedBy?: string;
}

export interface OcSetupSession {
	messageId: string;
	squareMid: string;
	squareChatMid: string;
	createdAt: string;
	createdBy: string;
	expiresAt: string;
}

export interface OcMemberMessageSetting {
	squareMid: string;
	squareChatMid: string;
	text: string;
	mention: boolean;
	showId: boolean;
	updatedAt: string;
	updatedBy?: string;
}

export type OcJoinMessageSetting = OcMemberMessageSetting;
export type OcLeaveMessageSetting = OcMemberMessageSetting;

interface OcModerationSettingsFile {
	version: 1;
	settings: OcModerationSetting[];
	setupSessions: OcSetupSession[];
	joinMessages: OcJoinMessageSetting[];
	leaveMessages: OcLeaveMessageSetting[];
}

const EMPTY_SETTINGS: OcModerationSettingsFile = {
	version: 1,
	settings: [],
	setupSessions: [],
	joinMessages: [],
	leaveMessages: [],
};
const SAVE_DELAY_MS = 5_000;
const SETUP_SESSION_TTL_MS = 30 * 60_000;

function nowIso(): string {
	return new Date().toISOString();
}

function emptySetting(squareMid: string): OcModerationSetting {
	return {
		squareMid,
		linkDeleteEnabled: false,
		mediaBurstDeleteEnabled: false,
		leftSoonMonitoringEnabled: false,
		leftSoonSourceChatMid: undefined,
		dangerWordAutoKickEnabled: false,
		dangerWordAutoReportEnabled: false,
		joinCohortWatchEnabled: false,
		modRoomChatMid: undefined,
		modRoomSetAt: undefined,
		modRoomSetBy: undefined,
		urlAllowRules: [],
		mutes: [],
		updatedAt: "",
	};
}

function parseMutes(value: unknown): OcMuteEntry[] {
	if (!Array.isArray(value)) return [];
	const byMemberMid = new Map<string, OcMuteEntry>();
	for (const mute of value) {
		const item = mute as Partial<OcMuteEntry>;
		if (
			typeof item.memberMid !== "string" ||
			!/^p[0-9a-f]{8,}$/i.test(item.memberMid) ||
			typeof item.mutedAt !== "string" ||
			typeof item.mutedBy !== "string"
		) continue;
		if (typeof item.expiresAt === "string" && !Number.isFinite(new Date(item.expiresAt).getTime())) {
			continue;
		}
		const expiresAt = typeof item.expiresAt === "string" ? item.expiresAt : undefined;
		const entry: OcMuteEntry = {
			memberMid: item.memberMid,
			displayName: typeof item.displayName === "string" && item.displayName.trim()
				? item.displayName.trim().slice(0, 80)
				: undefined,
			mutedAt: item.mutedAt,
			mutedBy: item.mutedBy,
			expiresAt,
		};
		if (!isOcMuteActive(entry)) continue;
		byMemberMid.set(entry.memberMid, entry);
	}
	return [...byMemberMid.values()];
}

function parseSetupSessions(value: unknown): OcSetupSession[] {
	if (!Array.isArray(value)) return [];
	const now = Date.now();
	const byMessageId = new Map<string, OcSetupSession>();
	for (const session of value) {
		const item = session as Partial<OcSetupSession>;
		if (
			typeof item.messageId !== "string" ||
			typeof item.squareMid !== "string" ||
			typeof item.squareChatMid !== "string" ||
			typeof item.createdAt !== "string" ||
			typeof item.createdBy !== "string" ||
			typeof item.expiresAt !== "string"
		) continue;
		if (new Date(item.expiresAt).getTime() <= now) continue;
		byMessageId.set(item.messageId, {
			messageId: item.messageId,
			squareMid: item.squareMid,
			squareChatMid: item.squareChatMid,
			createdAt: item.createdAt,
			createdBy: item.createdBy,
			expiresAt: item.expiresAt,
		});
	}
	return [...byMessageId.values()];
}

function parseMemberMessages(value: unknown): OcMemberMessageSetting[] {
	if (!Array.isArray(value)) return [];
	const byChatMid = new Map<string, OcMemberMessageSetting>();
	for (const setting of value) {
		const item = setting as Partial<OcMemberMessageSetting>;
		if (
			typeof item.squareMid !== "string" ||
			!item.squareMid ||
			typeof item.squareChatMid !== "string" ||
			!item.squareChatMid ||
			typeof item.text !== "string" ||
			!item.text.trim()
		) continue;
		byChatMid.set(item.squareChatMid, {
			squareMid: item.squareMid,
			squareChatMid: item.squareChatMid,
			text: item.text,
			mention: item.mention === true,
			showId: item.showId === true,
			updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
			updatedBy: typeof item.updatedBy === "string" ? item.updatedBy : undefined,
		});
	}
	return [...byChatMid.values()];
}

function parseSettings(value: unknown): OcModerationSettingsFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_SETTINGS);
	const raw = value as Partial<OcModerationSettingsFile>;
	const settings = Array.isArray(raw.settings) ? raw.settings : [];
	const bySquareMid = new Map<string, OcModerationSetting>();
	for (const setting of settings) {
		const item = setting as Partial<OcModerationSetting>;
		if (typeof item.squareMid !== "string" || !item.squareMid) continue;
		bySquareMid.set(item.squareMid, {
			squareMid: item.squareMid,
			linkDeleteEnabled: item.linkDeleteEnabled === true,
			mediaBurstDeleteEnabled: item.mediaBurstDeleteEnabled === true,
			leftSoonMonitoringEnabled: item.leftSoonMonitoringEnabled === true,
			leftSoonSourceChatMid: typeof item.leftSoonSourceChatMid === "string"
				? item.leftSoonSourceChatMid
				: undefined,
			dangerWordAutoKickEnabled: item.dangerWordAutoKickEnabled === true,
			dangerWordAutoReportEnabled: item.dangerWordAutoReportEnabled === true,
			joinCohortWatchEnabled: item.joinCohortWatchEnabled === true,
			modRoomChatMid: typeof item.modRoomChatMid === "string" ? item.modRoomChatMid : undefined,
			modRoomSetAt: typeof item.modRoomSetAt === "string" ? item.modRoomSetAt : undefined,
			modRoomSetBy: typeof item.modRoomSetBy === "string" ? item.modRoomSetBy : undefined,
			urlAllowRules: parseOcUrlAllowRules(item.urlAllowRules),
			mutes: parseMutes(item.mutes),
			updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
			updatedBy: typeof item.updatedBy === "string" ? item.updatedBy : undefined,
		});
	}
	return {
		version: 1,
		settings: [...bySquareMid.values()],
		setupSessions: parseSetupSessions(raw.setupSessions),
		joinMessages: parseMemberMessages(raw.joinMessages),
		leaveMessages: parseMemberMessages(raw.leaveMessages),
	};
}

class OcModerationSettingsStore {
	private data: OcModerationSettingsFile = structuredClone(EMPTY_SETTINGS);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.ocModerationSettingsFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.ocModerationSettingsGithubPath);
				if (remote) {
					this.data = parseSettings(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[oc-settings] loaded ${this.data.settings.length} setting(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[oc-settings] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseSettings(JSON.parse(await fs.readFile(appConfig.ocModerationSettingsFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[oc-settings] loaded ${this.data.settings.length} setting(s)`);
	}

	snapshot(squareMid: string): OcModerationSetting {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		const value = setting ?? emptySetting(squareMid);
		return {
			...value,
			urlAllowRules: value.urlAllowRules.map((rule) => ({ ...rule })),
			mutes: value.mutes.map((mute) => ({ ...mute })),
		};
	}

	leftSoonMonitoringSettings(): OcModerationSetting[] {
		return this.data.settings
			.filter((setting) => setting.leftSoonMonitoringEnabled)
			.map((setting) => ({
				...setting,
				urlAllowRules: setting.urlAllowRules.map((rule) => ({ ...rule })),
				mutes: setting.mutes.map((mute) => ({ ...mute })),
			}));
	}

	memberPollingSettings(): OcModerationSetting[] {
		return this.data.settings.map((setting) => ({
			...setting,
			urlAllowRules: setting.urlAllowRules.map((rule) => ({ ...rule })),
			mutes: setting.mutes.map((mute) => ({ ...mute })),
		}));
	}

	activeMute(squareMid: string, memberMid: string, now = Date.now()): OcMuteEntry | undefined {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting) return undefined;
		this.cleanupExpiredMutes(setting, now);
		const entry = setting.mutes.find((mute) => mute.memberMid === memberMid);
		return entry ? { ...entry } : undefined;
	}

	listMutes(squareMid: string, now = Date.now()): OcMuteEntry[] {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting) return [];
		this.cleanupExpiredMutes(setting, now);
		return setting.mutes.map((mute) => ({ ...mute }));
	}

	setMute(
		squareMid: string,
		input: Omit<OcMuteEntry, "mutedAt">,
	): { result: "set" | "updated"; entry: OcMuteEntry } {
		const setting = this.ensureSetting(squareMid, input.mutedBy);
		const entry: OcMuteEntry = {
			...input,
			mutedAt: nowIso(),
		};
		const index = setting.mutes.findIndex((mute) => mute.memberMid === entry.memberMid);
		const result = index >= 0 ? "updated" : "set";
		if (index >= 0) setting.mutes[index] = entry;
		else setting.mutes.push(entry);
		setting.updatedAt = entry.mutedAt;
		setting.updatedBy = input.mutedBy;
		this.scheduleSave();
		return { result, entry: { ...entry } };
	}

	removeMute(squareMid: string, memberMid: string, updatedBy: string): OcMuteEntry | undefined {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting) return undefined;
		this.cleanupExpiredMutes(setting);
		const index = setting.mutes.findIndex((mute) => mute.memberMid === memberMid);
		if (index < 0) return undefined;
		const [entry] = setting.mutes.splice(index, 1);
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return { ...entry };
	}

	urlAllowRules(squareMid: string): OcUrlAllowRule[] {
		return this.snapshot(squareMid).urlAllowRules;
	}

	addUrlAllowRule(
		squareMid: string,
		rule: OcUrlAllowRule,
		updatedBy: string,
	): { result: "added" | "unchanged"; rule: OcUrlAllowRule } {
		const setting = this.ensureSetting(squareMid, updatedBy);
		const current = setting.urlAllowRules.find((item) => sameOcUrlRule(item, rule));
		if (current) return { result: "unchanged", rule: { ...current } };
		setting.urlAllowRules.push({ ...rule });
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return { result: "added", rule: { ...rule } };
	}

	removeUrlAllowRule(
		squareMid: string,
		ruleId: string,
		updatedBy: string,
	): "removed" | "unchanged" {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting) return "unchanged";
		const before = setting.urlAllowRules.length;
		setting.urlAllowRules = setting.urlAllowRules.filter((rule) => rule.id !== ruleId);
		if (setting.urlAllowRules.length === before) return "unchanged";
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return "removed";
	}

	clearUrlAllowRules(squareMid: string, updatedBy: string): number {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting || setting.urlAllowRules.length === 0) return 0;
		const removed = setting.urlAllowRules.length;
		setting.urlAllowRules = [];
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return removed;
	}

	joinMessage(squareChatMid: string): OcJoinMessageSetting | undefined {
		const setting = this.data.joinMessages.find((item) => item.squareChatMid === squareChatMid);
		return setting ? { ...setting } : undefined;
	}

	joinMessageSettings(): OcJoinMessageSetting[] {
		return this.data.joinMessages.map((setting) => ({ ...setting }));
	}

	setJoinMessage(
		squareMid: string,
		squareChatMid: string,
		text: string,
		mention: boolean,
		showId: boolean,
		updatedBy: string,
	): "set" | "unchanged" {
		return this.setMemberMessage("joinMessages", squareMid, squareChatMid, text, mention, showId, updatedBy);
	}

	clearJoinMessage(squareChatMid: string): "cleared" | "unchanged" {
		return this.clearMemberMessage("joinMessages", squareChatMid);
	}

	leaveMessage(squareChatMid: string): OcLeaveMessageSetting | undefined {
		const setting = this.data.leaveMessages.find((item) => item.squareChatMid === squareChatMid);
		return setting ? { ...setting } : undefined;
	}

	leaveMessageSettings(): OcLeaveMessageSetting[] {
		return this.data.leaveMessages.map((setting) => ({ ...setting }));
	}

	setLeaveMessage(
		squareMid: string,
		squareChatMid: string,
		text: string,
		mention: boolean,
		showId: boolean,
		updatedBy: string,
	): "set" | "unchanged" {
		return this.setMemberMessage("leaveMessages", squareMid, squareChatMid, text, mention, showId, updatedBy);
	}

	clearLeaveMessage(squareChatMid: string): "cleared" | "unchanged" {
		return this.clearMemberMessage("leaveMessages", squareChatMid);
	}

	setLinkDelete(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "linkDeleteEnabled", enabled, updatedBy);
	}

	setMediaBurstDelete(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "mediaBurstDeleteEnabled", enabled, updatedBy);
	}

	setLeftSoonMonitoring(
		squareMid: string,
		enabled: boolean,
		updatedBy: string,
		sourceChatMid?: string,
	): "enabled" | "disabled" | "unchanged" {
		const setting = this.ensureSetting(squareMid, updatedBy);
		const sourceChanged = enabled &&
			typeof sourceChatMid === "string" &&
			sourceChatMid.length > 0 &&
			setting.leftSoonSourceChatMid !== sourceChatMid;
		if (setting.leftSoonMonitoringEnabled === enabled && !sourceChanged) return "unchanged";
		setting.leftSoonMonitoringEnabled = enabled;
		if (sourceChanged) setting.leftSoonSourceChatMid = sourceChatMid;
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return enabled ? "enabled" : "disabled";
	}

	rememberLeftSoonSourceChat(squareMid: string, sourceChatMid: string): boolean {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (
			!setting?.leftSoonMonitoringEnabled ||
			setting.leftSoonSourceChatMid ||
			!sourceChatMid
		) return false;
		setting.leftSoonSourceChatMid = sourceChatMid;
		setting.updatedAt = nowIso();
		this.scheduleSave();
		console.log("[oc-settings] restored missing left-soon source chat", {
			squareMid,
			sourceChatMid,
		});
		return true;
	}

	setDangerWordAutoKick(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "dangerWordAutoKickEnabled", enabled, updatedBy);
	}

	setDangerWordAutoReport(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "dangerWordAutoReportEnabled", enabled, updatedBy);
	}

	setJoinCohortWatch(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "joinCohortWatchEnabled", enabled, updatedBy);
	}

	setModRoom(squareMid: string, squareChatMid: string, updatedBy: string): "set" | "unchanged" {
		const setting = this.ensureSetting(squareMid, updatedBy);
		if (setting.modRoomChatMid === squareChatMid) return "unchanged";
		const updatedAt = nowIso();
		setting.modRoomChatMid = squareChatMid;
		setting.modRoomSetAt = updatedAt;
		setting.modRoomSetBy = updatedBy;
		setting.updatedAt = updatedAt;
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return "set";
	}

	clearModRoom(squareMid: string, updatedBy: string): "cleared" | "unchanged" {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting?.modRoomChatMid) return "unchanged";
		setting.modRoomChatMid = undefined;
		setting.modRoomSetAt = undefined;
		setting.modRoomSetBy = undefined;
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return "cleared";
	}

	recordSetupSession(
		session: Omit<OcSetupSession, "createdAt" | "expiresAt"> & { ttlMs?: number },
	): OcSetupSession {
		this.cleanupExpiredSetupSessions();
		const createdAt = nowIso();
		const expiresAt = new Date(Date.now() + (session.ttlMs ?? SETUP_SESSION_TTL_MS)).toISOString();
		const next: OcSetupSession = {
			messageId: session.messageId,
			squareMid: session.squareMid,
			squareChatMid: session.squareChatMid,
			createdAt,
			createdBy: session.createdBy,
			expiresAt,
		};
		this.data.setupSessions = [
			...this.data.setupSessions.filter((item) => item.messageId !== next.messageId),
			next,
		].slice(-100);
		this.scheduleSave();
		return { ...next };
	}

	findSetupSession(messageId: string, squareMid?: string): OcSetupSession | undefined {
		this.cleanupExpiredSetupSessions();
		const session = this.data.setupSessions.find((item) =>
			item.messageId === messageId && (!squareMid || item.squareMid === squareMid)
		);
		return session ? { ...session } : undefined;
	}

	clearSetupSession(messageId: string): void {
		const before = this.data.setupSessions.length;
		this.data.setupSessions = this.data.setupSessions.filter((item) => item.messageId !== messageId);
		if (this.data.setupSessions.length !== before) this.scheduleSave();
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
					appConfig.ocModerationSettingsGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update OpenChat moderation settings",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[oc-settings] save failed", error);
			this.dirty = true;
			this.scheduleSave();
		});
		await operation;
	}

	private setFlag(
		squareMid: string,
		key:
			| "linkDeleteEnabled"
			| "mediaBurstDeleteEnabled"
			| "leftSoonMonitoringEnabled"
			| "dangerWordAutoKickEnabled"
			| "dangerWordAutoReportEnabled"
			| "joinCohortWatchEnabled",
		enabled: boolean,
		updatedBy: string,
	): "enabled" | "disabled" | "unchanged" {
		let setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting) {
			if (!enabled) return "unchanged";
			setting = { ...emptySetting(squareMid), updatedAt: nowIso(), updatedBy };
			this.data.settings.push(setting);
		}
		if (setting[key] === enabled) return "unchanged";
		setting[key] = enabled;
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return enabled ? "enabled" : "disabled";
	}

	private setMemberMessage(
		key: "joinMessages" | "leaveMessages",
		squareMid: string,
		squareChatMid: string,
		text: string,
		mention: boolean,
		showId: boolean,
		updatedBy: string,
	): "set" | "unchanged" {
		const normalizedText = text.trim();
		const current = this.data[key].find((item) => item.squareChatMid === squareChatMid);
		if (current) {
			if (
				current.text === normalizedText &&
				current.mention === mention &&
				current.showId === showId &&
				current.squareMid === squareMid
			) {
				return "unchanged";
			}
			current.squareMid = squareMid;
			current.text = normalizedText;
			current.mention = mention;
			current.showId = showId;
			current.updatedAt = nowIso();
			current.updatedBy = updatedBy;
			this.scheduleSave();
			return "set";
		}
		this.data[key].push({
			squareMid,
			squareChatMid,
			text: normalizedText,
			mention,
			showId,
			updatedAt: nowIso(),
			updatedBy,
		});
		this.scheduleSave();
		return "set";
	}

	private clearMemberMessage(key: "joinMessages" | "leaveMessages", squareChatMid: string): "cleared" | "unchanged" {
		const before = this.data[key].length;
		this.data[key] = this.data[key].filter((item) => item.squareChatMid !== squareChatMid);
		if (this.data[key].length === before) return "unchanged";
		this.scheduleSave();
		return "cleared";
	}

	private ensureSetting(squareMid: string, updatedBy: string): OcModerationSetting {
		let setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting) {
			setting = { ...emptySetting(squareMid), updatedAt: nowIso(), updatedBy };
			this.data.settings.push(setting);
		}
		return setting;
	}

	private cleanupExpiredMutes(setting: OcModerationSetting, now = Date.now()): void {
		const active = setting.mutes.filter((mute) => isOcMuteActive(mute, now));
		if (active.length === setting.mutes.length) return;
		setting.mutes = active;
		setting.updatedAt = nowIso();
		this.scheduleSave();
	}

	private cleanupExpiredSetupSessions(): void {
		const now = Date.now();
		const before = this.data.setupSessions.length;
		this.data.setupSessions = this.data.setupSessions.filter((session) =>
			new Date(session.expiresAt).getTime() > now
		);
		if (this.data.setupSessions.length !== before) this.scheduleSave();
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush().catch((error) => {
				console.error("[oc-settings] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: OcModerationSettingsFile = this.data): Promise<void> {
		const temporary = `${appConfig.ocModerationSettingsFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.ocModerationSettingsFile);
	}
}

export const ocModerationSettingsStore = new OcModerationSettingsStore();
