import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface OcModerationSetting {
	squareMid: string;
	linkDeleteEnabled: boolean;
	mediaBurstDeleteEnabled: boolean;
	updatedAt: string;
	updatedBy?: string;
}

interface OcModerationSettingsFile {
	version: 1;
	settings: OcModerationSetting[];
}

const EMPTY_SETTINGS: OcModerationSettingsFile = { version: 1, settings: [] };
const SAVE_DELAY_MS = 5_000;

function nowIso(): string {
	return new Date().toISOString();
}

function emptySetting(squareMid: string): OcModerationSetting {
	return {
		squareMid,
		linkDeleteEnabled: false,
		mediaBurstDeleteEnabled: false,
		updatedAt: "",
	};
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
			updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
			updatedBy: typeof item.updatedBy === "string" ? item.updatedBy : undefined,
		});
	}
	return {
		version: 1,
		settings: [...bySquareMid.values()],
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
		return { ...(setting ?? emptySetting(squareMid)) };
	}

	setLinkDelete(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "linkDeleteEnabled", enabled, updatedBy);
	}

	setMediaBurstDelete(squareMid: string, enabled: boolean, updatedBy: string): "enabled" | "disabled" | "unchanged" {
		return this.setFlag(squareMid, "mediaBurstDeleteEnabled", enabled, updatedBy);
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
		key: "linkDeleteEnabled" | "mediaBurstDeleteEnabled",
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
