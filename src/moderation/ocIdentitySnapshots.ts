import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface OcIdentitySnapshot {
	id: string;
	at: string;
	squareMid: string;
	squareChatMid: string;
	targetMid: string;
	displayName?: string;
	role?: string;
	membershipState?: string;
	profileImageObsHash?: string;
	ableToReceiveMessage?: boolean;
	joinMessage?: string;
	memberCreatedAt?: string;
	memberRevision?: string;
	selfIntroduction?: string;
	socialMediaAccountUrls: string[];
	oneOnOneChatMid?: string;
	relationState?: string;
	relationRevision?: string;
	contentsAttribute?: string;
	chatMembershipState?: string;
	chatMemberRevision?: string;
	chatMemberError?: string;
	actorMid: string;
	actorName?: string;
}

export interface OcIdentityMatch {
	snapshot: OcIdentitySnapshot;
	score: number;
	reasons: string[];
}

type OcIdentitySnapshotInput = Omit<OcIdentitySnapshot, "id" | "at">;

interface OcIdentitySnapshotFile {
	version: 1;
	entries: OcIdentitySnapshot[];
}

const EMPTY_SNAPSHOTS: OcIdentitySnapshotFile = { version: 1, entries: [] };
const SAVE_DELAY_MS = 5_000;
const MAX_SNAPSHOTS = 1_000;

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const text = stringValue(item);
		return text ? [text] : [];
	});
}

function parseSnapshots(value: unknown): OcIdentitySnapshotFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_SNAPSHOTS);
	const raw = value as Partial<OcIdentitySnapshotFile>;
	const entries = Array.isArray(raw.entries) ? raw.entries : [];
	return {
		version: 1,
		entries: entries.flatMap((entry) => {
			const item = entry as Partial<OcIdentitySnapshot>;
			const id = stringValue(item.id);
			const at = stringValue(item.at);
			const squareMid = stringValue(item.squareMid);
			const squareChatMid = stringValue(item.squareChatMid);
			const targetMid = stringValue(item.targetMid);
			const actorMid = stringValue(item.actorMid);
			if (!id || !at || !squareMid || !squareChatMid || !targetMid || !actorMid) return [];
			return [{
				id,
				at,
				squareMid,
				squareChatMid,
				targetMid,
				displayName: stringValue(item.displayName),
				role: stringValue(item.role),
				membershipState: stringValue(item.membershipState),
				profileImageObsHash: stringValue(item.profileImageObsHash),
				ableToReceiveMessage: booleanValue(item.ableToReceiveMessage),
				joinMessage: stringValue(item.joinMessage),
				memberCreatedAt: stringValue(item.memberCreatedAt),
				memberRevision: stringValue(item.memberRevision),
				selfIntroduction: stringValue(item.selfIntroduction),
				socialMediaAccountUrls: stringArrayValue(item.socialMediaAccountUrls),
				oneOnOneChatMid: stringValue(item.oneOnOneChatMid),
				relationState: stringValue(item.relationState),
				relationRevision: stringValue(item.relationRevision),
				contentsAttribute: stringValue(item.contentsAttribute),
				chatMembershipState: stringValue(item.chatMembershipState),
				chatMemberRevision: stringValue(item.chatMemberRevision),
				chatMemberError: stringValue(item.chatMemberError),
				actorMid,
				actorName: stringValue(item.actorName),
			}];
		}).slice(-MAX_SNAPSHOTS),
	};
}

function normalizeText(value: string | undefined): string | undefined {
	const normalized = value?.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
	return normalized || undefined;
}

function normalizeUrl(value: string): string {
	return value.normalize("NFKC").trim().replace(/\/+$/, "").toLowerCase();
}

function addReason(
	match: { score: number; reasons: string[] },
	condition: boolean,
	score: number,
	reason: string,
): void {
	if (!condition) return;
	match.score += score;
	match.reasons.push(reason);
}

function scoreSnapshot(target: OcIdentitySnapshotInput, candidate: OcIdentitySnapshot): OcIdentityMatch | undefined {
	const result = { score: 0, reasons: [] as string[] };
	addReason(result, target.targetMid === candidate.targetMid, 2, "same squareMemberMid");
	addReason(
		result,
		Boolean(target.oneOnOneChatMid && target.oneOnOneChatMid === candidate.oneOnOneChatMid),
		6,
		"same oneOnOneChatMid",
	);
	addReason(
		result,
		Boolean(target.profileImageObsHash && target.profileImageObsHash === candidate.profileImageObsHash),
		3,
		"same profileImageObsHash",
	);
	addReason(
		result,
		Boolean(normalizeText(target.displayName) && normalizeText(target.displayName) === normalizeText(candidate.displayName)),
		1,
		"same displayName",
	);
	addReason(
		result,
		Boolean(
			normalizeText(target.selfIntroduction) &&
			normalizeText(target.selfIntroduction) === normalizeText(candidate.selfIntroduction)
		),
		2,
		"same selfIntroduction",
	);
	addReason(
		result,
		Boolean(target.memberCreatedAt && target.memberCreatedAt === candidate.memberCreatedAt),
		1,
		"same memberCreatedAt",
	);

	const targetUrls = new Set(target.socialMediaAccountUrls.map(normalizeUrl));
	const sharedUrls = candidate.socialMediaAccountUrls.filter((url) => targetUrls.has(normalizeUrl(url)));
	addReason(result, sharedUrls.length > 0, 3, "same socialMediaUrl");

	return result.score > 0 ? { snapshot: { ...candidate }, ...result } : undefined;
}

class OcIdentitySnapshotsStore {
	private data: OcIdentitySnapshotFile = structuredClone(EMPTY_SNAPSHOTS);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.ocIdentitySnapshotsFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.ocIdentitySnapshotsGithubPath);
				if (remote) {
					this.data = parseSnapshots(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[oc-identity] loaded ${this.data.entries.length} snapshot(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[oc-identity] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseSnapshots(JSON.parse(await fs.readFile(appConfig.ocIdentitySnapshotsFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[oc-identity] loaded ${this.data.entries.length} snapshot(s)`);
	}

	record(entry: OcIdentitySnapshotInput): OcIdentitySnapshot {
		const snapshot: OcIdentitySnapshot = {
			...entry,
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			at: new Date().toISOString(),
		};
		this.data.entries.push(snapshot);
		if (this.data.entries.length > MAX_SNAPSHOTS) {
			this.data.entries = this.data.entries.slice(-MAX_SNAPSHOTS);
		}
		this.scheduleSave();
		return { ...snapshot };
	}

	recent(squareMid: string, limit = 10): OcIdentitySnapshot[] {
		return this.data.entries
			.filter((entry) => entry.squareMid === squareMid)
			.slice(-Math.max(1, Math.min(limit, 30)))
			.reverse()
			.map((entry) => ({ ...entry }));
	}

	findCandidates(target: OcIdentitySnapshotInput, limit = 8): OcIdentityMatch[] {
		const byTargetMid = new Map<string, OcIdentityMatch>();
		for (const entry of this.data.entries) {
			if (entry.squareMid !== target.squareMid) continue;
			const match = scoreSnapshot(target, entry);
			if (!match) continue;
			const existing = byTargetMid.get(entry.targetMid);
			if (!existing || match.score > existing.score || (match.score === existing.score && match.snapshot.at > existing.snapshot.at)) {
				byTargetMid.set(entry.targetMid, match);
			}
		}
		return [...byTargetMid.values()]
			.sort((left, right) => right.score - left.score || right.snapshot.at.localeCompare(left.snapshot.at))
			.slice(0, Math.max(1, Math.min(limit, 20)));
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
					appConfig.ocIdentitySnapshotsGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update OpenChat identity snapshots",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[oc-identity] save failed", error);
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
				console.error("[oc-identity] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: OcIdentitySnapshotFile = this.data): Promise<void> {
		const temporary = `${appConfig.ocIdentitySnapshotsFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.ocIdentitySnapshotsFile);
	}
}

export const ocIdentitySnapshotsStore = new OcIdentitySnapshotsStore();
