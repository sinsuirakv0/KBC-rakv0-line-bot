import fs from "node:fs/promises";
import path from "node:path";
import type { LineDestination } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";
import {
	extractMemberEvents,
	memberEventIdentityKey,
	type MemberEventFallback,
	type MemberEventScope,
	type MemberEventType,
	type ParsedMemberEvent,
} from "./events.js";

export interface StoredMemberEvent {
	type: MemberEventType;
	scope: MemberEventScope;
	at: number;
	mid: string;
	name?: string;
}

export interface MemberEventRecordResult {
	read: number;
	added: number;
	duplicates: number;
}

export interface MemberEventSearchResult {
	mid: string;
	name?: string;
	names: string[];
	lastAt: number;
	lastType: MemberEventType;
	lastChatMid: string;
}

export interface MemberEventBackfillState {
	phase: "prime" | "backward" | "complete";
	syncToken?: string;
	continuationToken?: string;
	scannedEvents: number;
	savedEvents: number;
	pages: number;
	updatedAt: string;
	completedAt?: string;
}

export interface MemberEventFlushResult {
	localFiles: number;
	remoteFiles: number;
	remotePending: number;
	remoteEnabled: boolean;
}

interface MemberEventFileMeta {
	path: string;
	date: string;
	count: number;
	firstAt?: number;
	lastAt?: number;
}

interface MemberEventManifestChat {
	chatMid: string;
	scopeMid: string;
	files: MemberEventFileMeta[];
	backfill?: MemberEventBackfillState;
}

interface MemberEventMemberIndex {
	scopeMid: string;
	mid: string;
	names: string[];
	currentName?: string;
	currentNameAt?: number;
	firstAt: number;
	lastAt: number;
	lastType: MemberEventType;
	lastChatMid: string;
}

interface MemberEventManifest {
	version: 1;
	format: "kbc-line-member-event-log";
	generatedAt: string;
	chats: MemberEventManifestChat[];
	members: MemberEventMemberIndex[];
}

interface MemberEventFile {
	version: 1;
	chatMid: string;
	scopeMid: string;
	date: string;
	events: StoredMemberEvent[];
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function emptyManifest(): MemberEventManifest {
	return {
		version: 1,
		format: "kbc-line-member-event-log",
		generatedAt: new Date().toISOString(),
		chats: [],
		members: [],
	};
}

function normalizedRoot(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "logs/member-event-log";
}

function safeSegment(value: string): string {
	return encodeURIComponent(value).replace(/%/g, "_");
}

function dateKey(at: number): string {
	const date = new Date(at + JST_OFFSET_MS);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function eventPath(event: Pick<ParsedMemberEvent, "chatMid" | "at">): string {
	const date = dateKey(event.at);
	const [year, month] = date.split("-");
	return `square/${safeSegment(event.chatMid)}/${year}/${month}/${date}.json`;
}

function localPath(relativePath: string): string {
	return path.join(appConfig.memberEventLogDir, ...relativePath.split("/"));
}

function remotePath(relativePath: string): string {
	return `${normalizedRoot(appConfig.memberEventLogGithubPath)}/${relativePath}`;
}

function cleanName(value: string | undefined): string | undefined {
	const name = value?.trim();
	if (!name || /^p[0-9a-f]{8,}$/i.test(name)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(name)) return undefined;
	if (/^[\p{C}\s]+$/u.test(name)) return undefined;
	return name;
}

function normalizeSearch(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function parseManifest(value: unknown): MemberEventManifest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const manifest = value as Partial<MemberEventManifest>;
	if (
		manifest.version !== 1 ||
		manifest.format !== "kbc-line-member-event-log" ||
		!Array.isArray(manifest.chats) ||
		!Array.isArray(manifest.members)
	) {
		return undefined;
	}
	return manifest as MemberEventManifest;
}

function parseEventFile(value: unknown, meta: MemberEventFileMeta, chat: MemberEventManifestChat): MemberEventFile {
	if (value && typeof value === "object") {
		const file = value as Partial<MemberEventFile>;
		if (file.version === 1 && Array.isArray(file.events)) {
			return {
				version: 1,
				chatMid: file.chatMid || chat.chatMid,
				scopeMid: file.scopeMid || chat.scopeMid,
				date: file.date || meta.date,
				events: file.events.filter((event): event is StoredMemberEvent =>
					Boolean(
						event &&
						typeof event === "object" &&
						["join", "leave", "kick"].includes(event.type) &&
						["square", "chat"].includes(event.scope) &&
						Number.isFinite(event.at) &&
						typeof event.mid === "string",
					)
				),
			};
		}
	}
	return {
		version: 1,
		chatMid: chat.chatMid,
		scopeMid: chat.scopeMid,
		date: meta.date,
		events: [],
	};
}

function eventSort(left: StoredMemberEvent, right: StoredMemberEvent): number {
	return left.at - right.at || left.mid.localeCompare(right.mid) || left.type.localeCompare(right.type);
}

class MemberEventLogStore {
	private manifest = emptyManifest();
	private readonly chatsByMid = new Map<string, MemberEventManifestChat>();
	private readonly membersByKey = new Map<string, MemberEventMemberIndex>();
	private readonly filesByPath = new Map<string, { chat: MemberEventManifestChat; meta: MemberEventFileMeta }>();
	private readonly loadedFiles = new Map<string, MemberEventFile>();
	private readonly fileShas = new Map<string, string | undefined>();
	private readonly dirtyPaths = new Set<string>();
	private readonly pendingRemotePaths = new Set<string>();
	private operationQueue: Promise<void> = Promise.resolve();
	private saveTimer: NodeJS.Timeout | undefined;
	private manifestDirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(appConfig.memberEventLogDir, { recursive: true });
		let loaded: MemberEventManifest | undefined;
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(remotePath("manifest.json"));
				if (remote) {
					loaded = parseManifest(JSON.parse(remote.content) as unknown);
					this.fileShas.set(remotePath("manifest.json"), remote.sha);
					if (loaded) await this.writeLocalJson("manifest.json", loaded);
				}
			} catch (error) {
				console.warn("[member-event-log] GitHub manifest restore failed", error);
			}
		}
		if (!loaded) {
			try {
				loaded = parseManifest(JSON.parse(await fs.readFile(localPath("manifest.json"), "utf8")) as unknown);
			} catch (error) {
				if (!this.isNotFoundError(error)) {
					console.warn("[member-event-log] local manifest restore failed", error);
				}
			}
		}
		this.manifest = loaded ?? emptyManifest();
		this.rebuildIndexes();
		if (!loaded) await this.writeManifestLocal();
		console.log(
			`[member-event-log] loaded ${this.manifest.chats.length} chat(s), ${this.manifest.members.length} member(s)`,
		);
	}

	async recordHistoryEvents(
		events: unknown[],
		fallback: MemberEventFallback = {},
	): Promise<MemberEventRecordResult> {
		const parsed = events.flatMap((event) => extractMemberEvents(event, fallback));
		if (parsed.length === 0) return { read: 0, added: 0, duplicates: 0 };
		return await this.recordParsedEvents(parsed);
	}

	async recordParsedEvents(events: ParsedMemberEvent[]): Promise<MemberEventRecordResult> {
		if (events.length === 0) return { read: 0, added: 0, duplicates: 0 };
		return await this.enqueue(async () => {
			let added = 0;
			const loadedPaths = new Set<string>();
			for (const original of events) {
				const memberKey = `${original.scopeMid}:${original.mid}`;
				const knownMember = this.membersByKey.get(memberKey);
				const event = {
					...original,
					name: cleanName(original.name) ?? knownMember?.currentName ?? knownMember?.names.at(-1),
				};
				const relativePath = eventPath(event);
				const { chat, meta } = this.getOrCreateFileMeta(event, relativePath);
				const file = await this.loadFile(relativePath, chat, meta);
				loadedPaths.add(relativePath);
				const key = memberEventIdentityKey(event);
				const existing = file.events.find((item) => memberEventIdentityKey(item) === key);
				if (existing) {
					if (!existing.name && event.name) {
						existing.name = event.name;
						this.markFileDirty(relativePath);
					}
					this.updateMemberIndex(event);
					continue;
				}
				file.events.push({
					type: event.type,
					scope: event.scope,
					at: event.at,
					mid: event.mid,
					...(event.name ? { name: event.name } : {}),
				});
				file.events.sort(eventSort);
				meta.count = file.events.length;
				meta.firstAt = file.events.at(0)?.at;
				meta.lastAt = file.events.at(-1)?.at;
				this.updateMemberIndex(event);
				this.markFileDirty(relativePath);
				added++;
			}
			for (const relativePath of loadedPaths) {
				if (!this.dirtyPaths.has(relativePath)) this.loadedFiles.delete(relativePath);
			}
			if (events.length > 0) this.scheduleSave();
			return {
				read: events.length,
				added,
				duplicates: events.length - added,
			};
		});
	}

	async getBackfillState(chatMid: string): Promise<MemberEventBackfillState | undefined> {
		await this.operationQueue.catch(() => {});
		const state = this.chatsByMid.get(chatMid)?.backfill;
		return state ? { ...state } : undefined;
	}

	async updateBackfillState(
		chatMid: string,
		scopeMid: string,
		state: MemberEventBackfillState,
	): Promise<void> {
		await this.enqueue(async () => {
			const chat = this.getOrCreateChat(chatMid, scopeMid);
			chat.backfill = { ...state };
			this.manifestDirty = true;
			this.scheduleSave();
		});
	}

	async searchMembers(
		destination: Pick<LineDestination, "kind" | "scopeMid">,
		query: string,
		limit = 20,
	): Promise<MemberEventSearchResult[]> {
		await this.operationQueue.catch(() => {});
		if (destination.kind !== "square") return [];
		const normalized = normalizeSearch(query);
		return this.manifest.members
			.filter((member) => member.scopeMid === destination.scopeMid)
			.filter((member) => {
				if (member.mid.toLowerCase() === query.trim().toLowerCase()) return true;
				return member.names.some((name) => normalizeSearch(name).includes(normalized));
			})
			.sort((left, right) => right.lastAt - left.lastAt)
			.slice(0, Math.max(1, limit))
			.map((member) => ({
				mid: member.mid,
				name: member.currentName ?? member.names.at(-1),
				names: [...member.names],
				lastAt: member.lastAt,
				lastType: member.lastType,
				lastChatMid: member.lastChatMid,
			}));
	}

	async checkpointLocal(): Promise<number> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		return await this.enqueue(async () => await this.persistLocal());
	}

	async flush(maxRemoteFiles = appConfig.memberEventLogRemoteFlushMaxFiles): Promise<MemberEventFlushResult> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		return await this.enqueue(async () => {
			const localFiles = await this.persistLocal();
			const remoteFiles = githubContentsClient.enabled
				? await this.flushRemote(maxRemoteFiles)
				: 0;
			return {
				localFiles,
				remoteFiles,
				remotePending: this.pendingRemotePaths.size,
				remoteEnabled: githubContentsClient.enabled,
			};
		});
	}

	pendingRemoteCount(): number {
		return this.pendingRemotePaths.size;
	}

	private getOrCreateChat(chatMid: string, scopeMid: string): MemberEventManifestChat {
		const existing = this.chatsByMid.get(chatMid);
		if (existing) {
			if (!existing.scopeMid && scopeMid) existing.scopeMid = scopeMid;
			return existing;
		}
		const chat: MemberEventManifestChat = { chatMid, scopeMid, files: [] };
		this.manifest.chats.push(chat);
		this.chatsByMid.set(chatMid, chat);
		this.manifestDirty = true;
		return chat;
	}

	private getOrCreateFileMeta(
		event: ParsedMemberEvent,
		relativePath: string,
	): { chat: MemberEventManifestChat; meta: MemberEventFileMeta } {
		const indexed = this.filesByPath.get(relativePath);
		if (indexed) return indexed;
		const chat = this.getOrCreateChat(event.chatMid, event.scopeMid);
		const meta: MemberEventFileMeta = {
			path: relativePath,
			date: dateKey(event.at),
			count: 0,
		};
		chat.files.push(meta);
		chat.files.sort((left, right) => left.date.localeCompare(right.date));
		const value = { chat, meta };
		this.filesByPath.set(relativePath, value);
		this.manifestDirty = true;
		return value;
	}

	private updateMemberIndex(event: ParsedMemberEvent): void {
		const key = `${event.scopeMid}:${event.mid}`;
		let member = this.membersByKey.get(key);
		if (!member) {
			member = {
				scopeMid: event.scopeMid,
				mid: event.mid,
				names: [],
				firstAt: event.at,
				lastAt: event.at,
				lastType: event.type,
				lastChatMid: event.chatMid,
			};
			this.manifest.members.push(member);
			this.membersByKey.set(key, member);
		}
		const name = cleanName(event.name);
		if (name && !member.names.includes(name)) member.names.push(name);
		if (name && (!member.currentNameAt || event.at >= member.currentNameAt)) {
			member.currentName = name;
			member.currentNameAt = event.at;
		}
		member.firstAt = Math.min(member.firstAt, event.at);
		if (event.at >= member.lastAt) {
			member.lastAt = event.at;
			member.lastType = event.type;
			member.lastChatMid = event.chatMid;
		}
		this.manifestDirty = true;
	}

	private async loadFile(
		relativePath: string,
		chat: MemberEventManifestChat,
		meta: MemberEventFileMeta,
	): Promise<MemberEventFile> {
		const loaded = this.loadedFiles.get(relativePath);
		if (loaded) return loaded;
		let raw: unknown;
		try {
			raw = JSON.parse(await fs.readFile(localPath(relativePath), "utf8")) as unknown;
		} catch (error) {
			if (!this.isNotFoundError(error)) throw error;
		}
		if (!raw && githubContentsClient.enabled) {
			const remote = await githubContentsClient.read(remotePath(relativePath));
			if (remote) {
				raw = JSON.parse(remote.content) as unknown;
				this.fileShas.set(remotePath(relativePath), remote.sha);
				await this.writeLocalJson(relativePath, raw);
			}
		}
		const file = parseEventFile(raw, meta, chat);
		this.loadedFiles.set(relativePath, file);
		return file;
	}

	private markFileDirty(relativePath: string): void {
		this.dirtyPaths.add(relativePath);
		this.manifestDirty = true;
	}

	private async persistLocal(): Promise<number> {
		let written = 0;
		const dirtyPaths = [...this.dirtyPaths];
		this.dirtyPaths.clear();
		for (const relativePath of dirtyPaths) {
			const file = this.loadedFiles.get(relativePath);
			if (!file) continue;
			await this.writeLocalJson(relativePath, file);
			this.loadedFiles.delete(relativePath);
			this.pendingRemotePaths.add(relativePath);
			written++;
		}
		if (this.manifestDirty || written > 0) {
			await this.writeManifestLocal();
			this.pendingRemotePaths.add("manifest.json");
			this.manifestDirty = false;
			written++;
		}
		return written;
	}

	private async flushRemote(maxFiles: number): Promise<number> {
		if (this.pendingRemotePaths.size === 0) return 0;
		const nonManifest = [...this.pendingRemotePaths]
			.filter((relativePath) => relativePath !== "manifest.json")
			.sort();
		const safeMaxFiles = Math.max(1, maxFiles);
		const paths: string[] = [];
		if (this.pendingRemotePaths.has("manifest.json")) paths.push("manifest.json");
		paths.push(...nonManifest.slice(0, safeMaxFiles));
		let written = 0;
		const errors: string[] = [];
		for (const relativePath of paths) {
			try {
				const content = await fs.readFile(localPath(relativePath), "utf8");
				const target = remotePath(relativePath);
				const sha = this.fileShas.get(target) ??
					await githubContentsClient.readSha(target).catch(() => undefined);
				const nextSha = await githubContentsClient.write(
					target,
					content,
					"Update LINE member event log",
					sha,
				);
				this.fileShas.set(target, nextSha);
				this.pendingRemotePaths.delete(relativePath);
				written++;
			} catch (error) {
				errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (errors.length > 0) {
			throw new Error(`member event GitHub sync failed after ${written} file(s): ${errors.slice(0, 3).join(" / ")}`);
		}
		return written;
	}

	private rebuildIndexes(): void {
		this.chatsByMid.clear();
		this.membersByKey.clear();
		this.filesByPath.clear();
		for (const chat of this.manifest.chats) {
			this.chatsByMid.set(chat.chatMid, chat);
			for (const meta of chat.files) this.filesByPath.set(meta.path, { chat, meta });
		}
		for (const member of this.manifest.members) {
			if (!member.currentName && member.names.length > 0) {
				member.currentName = member.names.at(-1);
			}
			if (member.currentName && !member.currentNameAt) member.currentNameAt = member.lastAt;
			this.membersByKey.set(`${member.scopeMid}:${member.mid}`, member);
		}
	}

	private async writeManifestLocal(): Promise<void> {
		this.manifest.generatedAt = new Date().toISOString();
		await this.writeLocalJson("manifest.json", this.manifest);
	}

	private async writeLocalJson(relativePath: string, value: unknown): Promise<void> {
		const filePath = localPath(relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const temporary = `${filePath}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
		await fs.rename(temporary, filePath);
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.checkpointLocal().catch((error) => {
				console.error("[member-event-log] local save failed", error);
			});
		}, appConfig.memberEventLogSaveDelayMs);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.operationQueue.then(operation, operation);
		this.operationQueue = run.then(() => undefined, () => undefined);
		return run;
	}

	private isNotFoundError(error: unknown): boolean {
		return Boolean(
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT",
		);
	}
}

export const memberEventLogStore = new MemberEventLogStore();
