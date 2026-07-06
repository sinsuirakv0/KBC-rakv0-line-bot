import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface OcUrlOffender {
	userMid: string;
	warningCount: number;
	deleteAllMessages: boolean;
	firstWarnedAt?: string;
	lockedAt?: string;
	updatedAt: string;
	updatedBy?: string;
}

export interface OcModerationSetting {
	squareMid: string;
	linkDeleteEnabled: boolean;
	mediaBurstDeleteEnabled: boolean;
	leftSoonMonitoringEnabled: boolean;
	dangerWordAutoKickEnabled: boolean;
	joinCohortWatchEnabled: boolean;
	modRoomChatMid?: string;
	modRoomSetAt?: string;
	modRoomSetBy?: string;
	urlOffenders: OcUrlOffender[];
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

interface OcModerationSettingsFile {
	version: 1;
	settings: OcModerationSetting[];
	setupSessions: OcSetupSession[];
}

const EMPTY_SETTINGS: OcModerationSettingsFile = { version: 1, settings: [], setupSessions: [] };
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
		dangerWordAutoKickEnabled: false,
		joinCohortWatchEnabled: false,
		modRoomChatMid: undefined,
		modRoomSetAt: undefined,
		modRoomSetBy: undefined,
		urlOffenders: [],
		updatedAt: "",
	};
}

function parseUrlOffenders(value: unknown): OcUrlOffender[] {
	if (!Array.isArray(value)) return [];
	const byUserMid = new Map<string, OcUrlOffender>();
	for (const offender of value) {
		const item = offender as Partial<OcUrlOffender>;
		if (typeof item.userMid !== "string" || !item.userMid) continue;
		const warningCount = Number.isFinite(item.warningCount)
			? Math.max(0, Math.min(3, Math.floor(item.warningCount ?? 0)))
			: 0;
		byUserMid.set(item.userMid, {
			userMid: item.userMid,
			warningCount,
			deleteAllMessages: item.deleteAllMessages === true,
			firstWarnedAt: typeof item.firstWarnedAt === "string" ? item.firstWarnedAt : undefined,
			lockedAt: typeof item.lockedAt === "string" ? item.lockedAt : undefined,
			updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
			updatedBy: typeof item.updatedBy === "string" ? item.updatedBy : undefined,
		});
	}
	return [...byUserMid.values()];
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
			dangerWordAutoKickEnabled: item.dangerWordAutoKickEnabled === true,
			joinCohortWatchEnabled: item.joinCohortWatchEnabled === true,
			modRoomChatMid: typeof item.modRoomChatMid === "string" ? item.modRoomChatMid : undefined,
			modRoomSetAt: typeof item.modRoomSetAt === "string" ? item.modRoomSetAt : undefined,
			modRoomSetBy: typeof item.modRoomSetBy === "string" ? item.modRoomSetBy : undefined,
			urlOffenders: parseUrlOffenders(item.urlOffenders),
			updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
			updatedBy: typeof item.updatedBy === "string" ? item.updatedBy : undefined,
		});
	}
	return {
		version: 1,
		settings: [...bySquareMid.values()],
		setupSessions: parseSetupSessions(raw.setupSessions),
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
			urlOffenders: value.urlOffenders.map((offender) => ({ ...offender })),
		};
	}

	setLinkDelete(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "linkDeleteEnabled", enabled, updatedBy);
	}

	setMediaBurstDelete(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "mediaBurstDeleteEnabled", enabled, updatedBy);
	}

	setLeftSoonMonitoring(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "leftSoonMonitoringEnabled", enabled, updatedBy);
	}

	setDangerWordAutoKick(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "dangerWordAutoKickEnabled", enabled, updatedBy);
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

	isLinkDeletionLocked(squareMid: string, userMid: string): boolean {
		const setting = this.data.settings.find((item) => item.squareMid === squareMid);
		return setting?.urlOffenders.some((offender) =>
			offender.userMid === userMid && offender.deleteAllMessages
		) ?? false;
	}

	recordLinkViolation(
		squareMid: string,
		userMid: string,
		updatedBy: string,
	): { shouldWarn: boolean; warningCount: number; locked: boolean; lockedNow: boolean } {
		const setting = this.ensureSetting(squareMid, updatedBy);
		let offender = setting.urlOffenders.find((item) => item.userMid === userMid);
		if (!offender) {
			offender = {
				userMid,
				warningCount: 0,
				deleteAllMessages: false,
				updatedAt: nowIso(),
				updatedBy,
			};
			setting.urlOffenders.push(offender);
		}

		const alreadyWarned = offender.warningCount > 0;
		const lockedNow = alreadyWarned && !offender.deleteAllMessages;
		if (lockedNow) {
			offender.deleteAllMessages = true;
			offender.lockedAt = nowIso();
		}

		const shouldWarn = offender.warningCount < 3;
		if (shouldWarn) {
			offender.warningCount += 1;
			if (!offender.firstWarnedAt) offender.firstWarnedAt = nowIso();
		}
		offender.updatedAt = nowIso();
		offender.updatedBy = updatedBy;
		setting.updatedAt = offender.updatedAt;
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return {
			shouldWarn,
			warningCount: offender.warningCount,
			locked: offender.deleteAllMessages,
			lockedNow,
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
		const clearedOffenders = key === "linkDeleteEnabled" && !enabled && setting.urlOffenders.length > 0;
		if (clearedOffenders) {
			setting.urlOffenders = [];
		}
		if (setting[key] === enabled) {
			if (clearedOffenders) this.scheduleSave();
			return "unchanged";
		}
		setting[key] = enabled;
		setting.updatedAt = nowIso();
		setting.updatedBy = updatedBy;
		this.scheduleSave();
		return enabled ? "enabled" : "disabled";
	}

	private ensureSetting(squareMid: string, updatedBy: string): OcModerationSetting {
		let setting = this.data.settings.find((item) => item.squareMid === squareMid);
		if (!setting) {
			setting = { ...emptySetting(squareMid), updatedAt: nowIso(), updatedBy };
			this.data.settings.push(setting);
		}
		return setting;
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
