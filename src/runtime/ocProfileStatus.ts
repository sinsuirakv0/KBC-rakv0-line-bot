import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import type { SyncedLineStorage } from "../storage/lineStorage.js";
import { lineApiQueue } from "./lineApiQueue.js";

export type OcProfileStatus = "normal" | "restarting" | "stopped";

interface SquareMemberRecord {
	squareMemberMid: string;
	squareMid: string;
	displayName: string;
	membershipState: string | number;
	revision: number | bigint;
	[key: string]: unknown;
}

interface StoredProfileNames {
	version: 1;
	baseNames: Record<string, string>;
}

const STORAGE_KEY = "kbcOcProfileNamesV1";
const STATUS_SUFFIX: Record<Exclude<OcProfileStatus, "normal">, string> = {
	restarting: " (再起動中)",
	stopped: " (停止中)",
};
const STATUS_SUFFIX_PATTERN = /\s*\((?:省エネ中|再起動中|停止中)\)$/u;

function stripStatusSuffix(name: string): string {
	return name.replace(STATUS_SUFFIX_PATTERN, "").trim();
}

function parseStoredNames(value: unknown): StoredProfileNames {
	if (!value || typeof value !== "object") return { version: 1, baseNames: {} };
	const raw = value as { version?: unknown; baseNames?: unknown };
	if (!raw.baseNames || typeof raw.baseNames !== "object") {
		return { version: 1, baseNames: {} };
	}
	const baseNames: Record<string, string> = {};
	for (const [squareMid, name] of Object.entries(raw.baseNames)) {
		if (squareMid.startsWith("s") && typeof name === "string" && name.trim()) {
			baseNames[squareMid] = stripStatusSuffix(name);
		}
	}
	return { version: 1, baseNames };
}

function isJoinedMembership(value: string | number): boolean {
	return value === "JOINED" || value === 2;
}

export class OcProfileStatusManager {
	private client: Client | undefined;
	private storage: SyncedLineStorage | undefined;
	private readonly members = new Map<string, SquareMemberRecord>();
	private readonly baseNames = new Map<string, string>();
	private globalStatus: "restarting" | "stopped" | undefined;
	private queue: Promise<void> = Promise.resolve();

	async bind(
		client: Client,
		storage: SyncedLineStorage,
		initialGlobalStatus?: "stopped",
	): Promise<void> {
		this.client = client;
		this.storage = storage;
		this.globalStatus = initialGlobalStatus;
		if (!appConfig.ocProfileStatusEnabled) return;
		await this.enqueue(async () => {
			await this.loadBaseNames();
			await this.refreshMembers();
			await this.applyAll();
		});
	}

	unbind(client: Client): void {
		if (this.client !== client) return;
		this.client = undefined;
		this.members.clear();
	}

	async setGlobalStatus(status: "restarting" | "stopped" | undefined): Promise<void> {
		if (this.globalStatus === "stopped" && status === "restarting") {
			await this.queue;
			return;
		}
		if (this.globalStatus === status) return;
		this.globalStatus = status;
		if (!appConfig.ocProfileStatusEnabled) return;
		await this.enqueue(() => this.applyAll());
	}

	async flush(): Promise<void> {
		await this.queue;
	}

	private desiredStatus(_squareMid: string): OcProfileStatus {
		if (this.globalStatus) return this.globalStatus;
		return "normal";
	}

	private desiredName(squareMid: string): string | undefined {
		const baseName = this.baseNames.get(squareMid);
		if (!baseName) return undefined;
		const status = this.desiredStatus(squareMid);
		return status === "normal" ? baseName : `${baseName}${STATUS_SUFFIX[status]}`;
	}

	private async loadBaseNames(): Promise<void> {
		if (!this.storage || this.baseNames.size > 0) return;
		const stored = parseStoredNames(await this.storage.get(STORAGE_KEY as never));
		for (const [squareMid, name] of Object.entries(stored.baseNames)) {
			this.baseNames.set(squareMid, name);
		}
	}

	private async refreshMembers(): Promise<void> {
		if (!this.client) return;
		let continuationToken = "";
		let namesChanged = false;
		for (let page = 0; page < 20; page++) {
			const response = await this.client.base.square.getJoinedSquares({
				continuationToken,
				limit: 100,
			});
			const raw = response as unknown as {
				members?: Record<string, SquareMemberRecord>;
				continuationToken?: string;
			};
			for (const member of Object.values(raw.members ?? {})) {
				if (
					!member.squareMid?.startsWith("s") ||
					!member.squareMemberMid?.startsWith("p") ||
					!isJoinedMembership(member.membershipState)
				) continue;
				this.members.set(member.squareMid, member);
				const currentName = member.displayName?.trim();
				if (!currentName) continue;
				const hasStatusSuffix = STATUS_SUFFIX_PATTERN.test(currentName);
				const storedBaseName = this.baseNames.get(member.squareMid);
				const baseName = !hasStatusSuffix || !storedBaseName
					? stripStatusSuffix(currentName)
					: storedBaseName;
				if (baseName && storedBaseName !== baseName) {
					this.baseNames.set(member.squareMid, baseName);
					namesChanged = true;
				}
			}
			continuationToken = raw.continuationToken || "";
			if (!continuationToken) break;
		}
		if (namesChanged) await this.saveBaseNames();
	}

	private async saveBaseNames(): Promise<void> {
		if (!this.storage) return;
		const value: StoredProfileNames = {
			version: 1,
			baseNames: Object.fromEntries(this.baseNames),
		};
		await this.storage.set(STORAGE_KEY as never, value as never);
	}

	private async applyAll(): Promise<void> {
		for (const squareMid of this.members.keys()) {
			await this.applySquare(squareMid);
		}
	}

	private async applySquare(squareMid: string): Promise<void> {
		if (lineApiQueue.isPaused()) return;
		const client = this.client;
		const member = this.members.get(squareMid);
		const displayName = this.desiredName(squareMid);
		if (!client || !member || !displayName || member.displayName === displayName) return;
		try {
			const response = await lineApiQueue.run(
				`oc-profile:${this.desiredStatus(squareMid)}`,
				() => client.base.square.updateSquareMember({
					request: {
						updatedAttrs: ["DISPLAY_NAME"],
						updatedPreferenceAttrs: [],
						squareMember: {
							...member,
							displayName,
						},
					},
				} as never),
				{ priority: "normal", scope: `profile:${squareMid}` },
			);
			const updated = (response as unknown as { squareMember?: SquareMemberRecord }).squareMember;
			this.members.set(squareMid, updated ?? { ...member, displayName });
			console.log("[oc-profile-status] updated", {
				squareMid,
				status: this.desiredStatus(squareMid),
				displayName,
			});
		} catch (error) {
			console.warn("[oc-profile-status] update failed", {
				squareMid,
				status: this.desiredStatus(squareMid),
				error,
			});
		}
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const current = this.queue.catch(() => undefined).then(operation);
		this.queue = current.catch((error) => {
			console.warn("[oc-profile-status] operation failed", error);
		});
		return this.queue;
	}
}

export const ocProfileStatusManager = new OcProfileStatusManager();
