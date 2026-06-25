import fs from "node:fs/promises";
import path from "node:path";
import type { LineDestination } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export type PermissionRole = "admin" | "mod";
export type PermissionLevel = "admin" | "mod" | "none";
export type PermissionChatType = "GROUP" | "SQUARE";

export interface PermissionTarget {
	chatMid: string;
	chatType: PermissionChatType;
}

interface RoleGrant extends PermissionTarget {
	userMid: string;
	role: PermissionRole;
	createdAt: string;
	createdBy?: string;
}

interface UserBan extends PermissionTarget {
	userMid: string;
	createdAt: string;
	createdBy?: string;
}

interface TalkBan extends PermissionTarget {
	createdAt: string;
	createdBy?: string;
}

interface PermissionsFile {
	version: 1;
	roles: RoleGrant[];
	userBans: UserBan[];
	talkBans: TalkBan[];
}

const SAVE_DELAY_MS = 5_000;

const INITIAL_ADMINS: RoleGrant[] = [
	{
		chatType: "SQUARE",
		chatMid: "m2f7b1899dc79a842b4b494cdf85e4f69",
		userMid: "p947d06c23b7162b3060c26fec481fa10",
		role: "admin",
		createdAt: "2026-06-26T00:00:00.000+09:00",
		createdBy: "initial",
	},
	{
		chatType: "GROUP",
		chatMid: "c2139495d82ba0dfa0f1c6263aa144cc8",
		userMid: "u4ebdccc9aae03ef3718003894a20e73b",
		role: "admin",
		createdAt: "2026-06-26T00:00:00.000+09:00",
		createdBy: "initial",
	},
];

const EMPTY_PERMISSIONS: PermissionsFile = {
	version: 1,
	roles: [],
	userBans: [],
	talkBans: [],
};

function nowIso(): string {
	return new Date().toISOString();
}

export function roleLabel(role: PermissionLevel): string {
	if (role === "admin") return "\u7ba1\u7406\u8005";
	if (role === "mod") return "\u30e2\u30c7\u30ec\u30fc\u30bf\u30fc";
	return "\u4e00\u822c";
}

export function requiredPermissionLabel(role: Exclude<PermissionLevel, "none">): string {
	return role === "admin" ? "\u7ba1\u7406\u8005" : "\u30e2\u30c7\u30ec\u30fc\u30bf\u30fc";
}

export function permissionDeniedText(required: Exclude<PermissionLevel, "none">): string {
	return `\u5b9f\u884c\u6a29\u9650\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u6a29\u9650\uff1a${requiredPermissionLabel(required)}\u4ee5\u4e0a\u306eBOT\u7ba1\u7406\u6a29\u9650\u304c\u5fc5\u8981\u3067\u3059\u3002`;
}

export function targetFromDestination(destination: LineDestination): PermissionTarget | null {
	if (destination.chatType === "GROUP" || destination.chatType === "SQUARE") {
		return {
			chatMid: destination.chatMid,
			chatType: destination.chatType,
		};
	}
	return null;
}

export function targetKey(target: PermissionTarget): string {
	return `${target.chatType}:${target.chatMid}`;
}

function roleRank(role: PermissionLevel): number {
	if (role === "admin") return 2;
	if (role === "mod") return 1;
	return 0;
}

function parsePermissions(value: unknown): PermissionsFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_PERMISSIONS);
	const raw = value as Partial<PermissionsFile>;
	return {
		version: 1,
		roles: parseRoles(raw.roles),
		userBans: parseUserBans(raw.userBans),
		talkBans: parseTalkBans(raw.talkBans),
	};
}

function parseRoles(value: unknown): RoleGrant[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const raw = item as Partial<RoleGrant>;
		if (!isTarget(raw) || typeof raw.userMid !== "string") return [];
		if (raw.role !== "admin" && raw.role !== "mod") return [];
		return [{
			chatType: raw.chatType,
			chatMid: raw.chatMid,
			userMid: raw.userMid,
			role: raw.role,
			createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
			createdBy: typeof raw.createdBy === "string" ? raw.createdBy : undefined,
		}];
	});
}

function parseUserBans(value: unknown): UserBan[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const raw = item as Partial<UserBan>;
		if (!isTarget(raw) || typeof raw.userMid !== "string") return [];
		return [{
			chatType: raw.chatType,
			chatMid: raw.chatMid,
			userMid: raw.userMid,
			createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
			createdBy: typeof raw.createdBy === "string" ? raw.createdBy : undefined,
		}];
	});
}

function parseTalkBans(value: unknown): TalkBan[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const raw = item as Partial<TalkBan>;
		if (!isTarget(raw)) return [];
		return [{
			chatType: raw.chatType,
			chatMid: raw.chatMid,
			createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
			createdBy: typeof raw.createdBy === "string" ? raw.createdBy : undefined,
		}];
	});
}

function isTarget<T extends Partial<PermissionTarget>>(value: T): value is T & PermissionTarget {
	return typeof value.chatMid === "string" &&
		(value.chatType === "GROUP" || value.chatType === "SQUARE");
}

class PermissionStore {
	private data: PermissionsFile = structuredClone(EMPTY_PERMISSIONS);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.permissionsFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.permissionsGithubPath);
				if (remote) {
					this.data = parsePermissions(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					if (this.ensureInitialAdmins()) await this.flush();
					else await this.writeLocal();
					console.log(`[permissions] loaded ${this.data.roles.length} role(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[permissions] GitHub restore failed", error);
			}
		}

		try {
			this.data = parsePermissions(JSON.parse(await fs.readFile(appConfig.permissionsFile, "utf8")));
		} catch {
			this.data = structuredClone(EMPTY_PERMISSIONS);
		}
		if (this.ensureInitialAdmins()) await this.flush();
		else await this.writeLocal();
		console.log(`[permissions] loaded ${this.data.roles.length} role(s)`);
	}

	getRole(target: PermissionTarget | null, userMid: string): PermissionLevel {
		if (!target) return "none";
		const grant = this.data.roles.find((item) =>
			targetKey(item) === targetKey(target) && item.userMid === userMid
		);
		return grant?.role ?? "none";
	}

	hasAtLeast(target: PermissionTarget | null, userMid: string, required: Exclude<PermissionLevel, "none">): boolean {
		return roleRank(this.getRole(target, userMid)) >= roleRank(required);
	}

	executionStatus(target: PermissionTarget | null, userMid: string): { role: PermissionLevel; banned: boolean } {
		if (!target) return { role: "none", banned: false };
		const role = this.getRole(target, userMid);
		if (role === "admin") return { role, banned: false };
		return {
			role,
			banned: this.isUserBanned(target, userMid) || this.isTalkBanned(target),
		};
	}

	canExecute(destination: LineDestination): boolean {
		const target = targetFromDestination(destination);
		if (!target) return true;
		const role = this.getRole(target, destination.senderMid);
		if (role === "admin") return true;
		if (this.isUserBanned(target, destination.senderMid)) return false;
		if (this.isTalkBanned(target)) return false;
		return true;
	}

	setRole(target: PermissionTarget, userMid: string, role: PermissionRole, createdBy: string): "created" | "updated" | "unchanged" {
		const existing = this.data.roles.find((item) =>
			targetKey(item) === targetKey(target) && item.userMid === userMid
		);
		if (existing) {
			if (existing.role === role) return "unchanged";
			existing.role = role;
			existing.createdAt = nowIso();
			existing.createdBy = createdBy;
			this.scheduleSave();
			return "updated";
		}
		this.data.roles.push({ ...target, userMid, role, createdAt: nowIso(), createdBy });
		this.removeUserBan(target, userMid);
		this.scheduleSave();
		return "created";
	}

	removeRole(target: PermissionTarget, userMid: string, role?: PermissionRole): "removed" | "not_found" {
		const before = this.data.roles.length;
		this.data.roles = this.data.roles.filter((item) => {
			if (targetKey(item) !== targetKey(target) || item.userMid !== userMid) return true;
			return role ? item.role !== role : false;
		});
		if (this.data.roles.length === before) return "not_found";
		this.scheduleSave();
		return "removed";
	}

	banUser(target: PermissionTarget, userMid: string, createdBy: string): "banned" | "already" | "admin" {
		if (this.getRole(target, userMid) === "admin") return "admin";
		if (this.isUserBanned(target, userMid)) return "already";
		this.data.userBans.push({ ...target, userMid, createdAt: nowIso(), createdBy });
		this.scheduleSave();
		return "banned";
	}

	unbanUser(target: PermissionTarget, userMid: string): "removed" | "not_found" {
		const before = this.data.userBans.length;
		this.removeUserBan(target, userMid);
		if (this.data.userBans.length === before) return "not_found";
		this.scheduleSave();
		return "removed";
	}

	banTalk(target: PermissionTarget, createdBy: string): "banned" | "already" {
		if (this.isTalkBanned(target)) return "already";
		this.data.talkBans.push({ ...target, createdAt: nowIso(), createdBy });
		this.scheduleSave();
		return "banned";
	}

	unbanTalk(target: PermissionTarget): "removed" | "not_found" {
		const before = this.data.talkBans.length;
		this.data.talkBans = this.data.talkBans.filter((item) => targetKey(item) !== targetKey(target));
		if (this.data.talkBans.length === before) return "not_found";
		this.scheduleSave();
		return "removed";
	}

	snapshot(target: PermissionTarget): { roles: RoleGrant[]; userBans: UserBan[]; talkBanned: boolean } {
		return {
			roles: this.data.roles.filter((item) => targetKey(item) === targetKey(target)).map((item) => ({ ...item })),
			userBans: this.data.userBans.filter((item) => targetKey(item) === targetKey(target)).map((item) => ({ ...item })),
			talkBanned: this.isTalkBanned(target),
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
					appConfig.permissionsGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update LINE bot permissions",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[permissions] save failed", error);
			this.dirty = true;
			this.scheduleSave();
		});
		await operation;
	}

	private isUserBanned(target: PermissionTarget, userMid: string): boolean {
		return this.data.userBans.some((item) =>
			targetKey(item) === targetKey(target) && item.userMid === userMid
		);
	}

	private isTalkBanned(target: PermissionTarget): boolean {
		return this.data.talkBans.some((item) => targetKey(item) === targetKey(target));
	}

	private removeUserBan(target: PermissionTarget, userMid: string): void {
		this.data.userBans = this.data.userBans.filter((item) =>
			!(targetKey(item) === targetKey(target) && item.userMid === userMid)
		);
	}

	private ensureInitialAdmins(): boolean {
		let changed = false;
		for (const admin of INITIAL_ADMINS) {
			const existing = this.data.roles.find((item) =>
				targetKey(item) === targetKey(admin) && item.userMid === admin.userMid
			);
			if (!existing) {
				this.data.roles.push({ ...admin });
				changed = true;
			} else if (existing.role !== "admin") {
				existing.role = "admin";
				changed = true;
			}
		}
		if (changed) this.dirty = true;
		return changed;
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush().catch((error) => {
				console.error("[permissions] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: PermissionsFile = this.data): Promise<void> {
		const temporary = `${appConfig.permissionsFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.permissionsFile);
	}
}

export const permissionStore = new PermissionStore();
