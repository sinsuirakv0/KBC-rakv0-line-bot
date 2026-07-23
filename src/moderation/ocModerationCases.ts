import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export type OcModerationCaseType =
	| "left_soon_auto_ban"
	| "left_soon_pending_ban"
	| "left_soon_log"
	| "danger_word_auto_kick"
	| "cohort_watch"
	| "cohort_suspicious"
	| "url_review";

export type OcModerationCaseStatus =
	| "open"
	| "auto_banned"
	| "pending_ban"
	| "ignored"
	| "ban_succeeded"
	| "ban_failed"
	| "unban_requested"
	| "pending_review"
	| "url_allowed"
	| "url_rejected"
	| "resolved";

export interface OcModerationCase {
	id: string;
	type: OcModerationCaseType;
	status: OcModerationCaseStatus;
	squareMid: string;
	modRoomChatMid?: string;
	modRoomMessageId?: string;
	targetMid?: string;
	targetName?: string;
	reason?: string;
	payload?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	updatedBy?: string;
	error?: string;
}

interface OcModerationCasesFile {
	version: 1;
	cases: OcModerationCase[];
}

const EMPTY_CASES: OcModerationCasesFile = { version: 1, cases: [] };
const SAVE_DELAY_MS = 5_000;
const MAX_CASES = 2_000;

function nowIso(): string {
	return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: undefined;
}

function parseCases(value: unknown): OcModerationCasesFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_CASES);
	const raw = value as Partial<OcModerationCasesFile>;
	const cases = Array.isArray(raw.cases) ? raw.cases : [];
	return {
		version: 1,
		cases: cases.flatMap((entry) => {
			const item = entry as Partial<OcModerationCase>;
			const id = stringValue(item.id);
			const type = stringValue(item.type) as OcModerationCaseType | undefined;
			const status = stringValue(item.status) as OcModerationCaseStatus | undefined;
			const squareMid = stringValue(item.squareMid);
			const createdAt = stringValue(item.createdAt);
			const updatedAt = stringValue(item.updatedAt);
			if (!id || !type || !status || !squareMid || !createdAt || !updatedAt) return [];
			return [{
				id,
				type,
				status,
				squareMid,
				modRoomChatMid: stringValue(item.modRoomChatMid),
				modRoomMessageId: stringValue(item.modRoomMessageId),
				targetMid: stringValue(item.targetMid),
				targetName: stringValue(item.targetName),
				reason: stringValue(item.reason),
				payload: objectValue(item.payload),
				createdAt,
				updatedAt,
				updatedBy: stringValue(item.updatedBy),
				error: stringValue(item.error),
			}];
		}).slice(-MAX_CASES),
	};
}

class OcModerationCasesStore {
	private data: OcModerationCasesFile = structuredClone(EMPTY_CASES);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.ocModerationCasesFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.ocModerationCasesGithubPath);
				if (remote) {
					this.data = parseCases(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[oc-cases] loaded ${this.data.cases.length} case(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[oc-cases] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseCases(JSON.parse(await fs.readFile(appConfig.ocModerationCasesFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[oc-cases] loaded ${this.data.cases.length} case(s)`);
	}

	record(entry: Omit<OcModerationCase, "id" | "createdAt" | "updatedAt">): OcModerationCase {
		const now = nowIso();
		const next: OcModerationCase = {
			...entry,
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			createdAt: now,
			updatedAt: now,
		};
		this.data.cases.push(next);
		if (this.data.cases.length > MAX_CASES) this.data.cases = this.data.cases.slice(-MAX_CASES);
		this.scheduleSave();
		return { ...next };
	}

	attachMessage(caseId: string, modRoomChatMid: string, modRoomMessageId: string): OcModerationCase | undefined {
		const item = this.data.cases.find((entry) => entry.id === caseId);
		if (!item) return undefined;
		item.modRoomChatMid = modRoomChatMid;
		item.modRoomMessageId = modRoomMessageId;
		item.updatedAt = nowIso();
		this.scheduleSave();
		return { ...item };
	}

	findByModRoomMessage(messageId: string, squareMid?: string): OcModerationCase | undefined {
		const item = [...this.data.cases]
			.reverse()
			.find((entry) =>
				entry.modRoomMessageId === messageId &&
				(!squareMid || entry.squareMid === squareMid)
			);
		return item ? { ...item } : undefined;
	}

	update(
		caseId: string,
		patch: Partial<Pick<OcModerationCase, "status" | "updatedBy" | "error" | "reason">>,
	): OcModerationCase | undefined {
		const item = this.data.cases.find((entry) => entry.id === caseId);
		if (!item) return undefined;
		Object.assign(item, patch, { updatedAt: nowIso() });
		this.scheduleSave();
		return { ...item };
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
					appConfig.ocModerationCasesGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update OpenChat moderation cases",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[oc-cases] save failed", error);
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
				console.error("[oc-cases] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: OcModerationCasesFile = this.data): Promise<void> {
		const temporary = `${appConfig.ocModerationCasesFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.ocModerationCasesFile);
	}
}

export const ocModerationCasesStore = new OcModerationCasesStore();
