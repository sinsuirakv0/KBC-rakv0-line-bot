import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { LineDestination } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface StoredMessageLog {
	id: string;
	kind: "talk" | "square";
	chatMid: string;
	scopeMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	senderMid: string;
	senderName?: string;
	createdAt: number;
	content: string;
	contentType?: string;
	metadata?: Record<string, unknown>;
}

export type StoredMemberState = "JOINED" | "LEFT" | "KICK_OUT" | "BANNED" | "UNKNOWN";

export interface StoredMemberProfile {
	mid: string;
	currentName?: string;
	names: string[];
	state: StoredMemberState;
	role?: string;
	firstSeenAt: string;
	lastSeenAt: string;
	lastMessageAt?: number;
	messageCount: number;
	sources: string[];
	extra?: Record<string, unknown>;
}

export interface MemberProfileInput {
	kind: "talk" | "square";
	chatMid: string;
	scopeMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	mid: string;
	name?: string;
	state?: StoredMemberState;
	role?: string;
	seenAt?: number;
	lastMessageAt?: number;
	messageCountDelta?: number;
	source?: string;
	extra?: Record<string, unknown>;
}

export interface MessageLogFlushResult {
	localFiles: number;
	remoteFiles: number;
	remoteEnabled: boolean;
	remoteSkipped: boolean;
}

interface StoredChat {
	kind: "talk" | "square";
	chatMid: string;
	scopeMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	backfillCompletedAt?: string;
	oldestMessageAt?: number;
	messages: StoredMessageLog[];
	members: StoredMemberProfile[];
}

interface LegacyMessageLogFile {
	version: 1;
	chats: StoredChat[];
}

interface MessageLogManifest {
	version: 2;
	format: "kbc-line-message-log";
	generatedAt: string;
	chats: MessageLogManifestChat[];
}

interface MessageLogManifestChat {
	kind: "talk" | "square";
	chatMid: string;
	scopeMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	backfillCompletedAt?: string;
	oldestMessageAt?: number;
	membersPath: string;
	parts: MessageLogPartMeta[];
}

interface MessageLogPartMeta {
	path: string;
	date: string;
	part: number;
	count: number;
	firstCreatedAt?: number;
	lastCreatedAt?: number;
	bytes: number;
}

interface MessageLogPartFile {
	version: 2;
	kind: "talk" | "square";
	chatMid: string;
	scopeMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	date: string;
	part: number;
	messages: StoredMessageLog[];
}

interface MessageLogMembersFile {
	version: 2;
	kind: "talk" | "square";
	chatMid: string;
	scopeMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	members: StoredMemberProfile[];
}

const EMPTY_LEGACY_LOG: LegacyMessageLogFile = { version: 1, chats: [] };
const SAVE_DELAY_MS = 15_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function chatKey(value: Pick<StoredChat, "kind" | "chatMid">): string {
	return `${value.kind}:${value.chatMid}`;
}

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function normalizedRoot(value: string): string {
	const trimmed = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (trimmed.endsWith(".json")) return trimmed.slice(0, -".json".length);
	return trimmed || "logs/message-log";
}

function localRoot(): string {
	return appConfig.messageLogDir;
}

function remoteRoot(): string {
	return normalizedRoot(appConfig.messageLogGithubPath);
}

function safeSegment(value: string): string {
	return encodeURIComponent(value).replace(/%/g, "_");
}

function chatFolder(chat: Pick<StoredChat, "kind" | "chatType">): string {
	if (chat.kind === "square") return "square";
	return chat.chatType.toLowerCase();
}

function jstDateKey(createdAt: number): string {
	const date = new Date(createdAt + JST_OFFSET_MS);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function datePathParts(dateKey: string): { year: string; month: string } {
	return {
		year: dateKey.slice(0, 4),
		month: dateKey.slice(5, 7),
	};
}

function relativeChatRoot(chat: Pick<StoredChat, "kind" | "chatType" | "chatMid">): string {
	return `${chatFolder(chat)}/${safeSegment(chat.chatMid)}`;
}

function relativeMembersPath(chat: Pick<StoredChat, "kind" | "chatType" | "chatMid">): string {
	return `${relativeChatRoot(chat)}/members.json`;
}

function relativePartPath(chat: Pick<StoredChat, "kind" | "chatType" | "chatMid">, dateKey: string, part: number): string {
	const { year, month } = datePathParts(dateKey);
	return `${relativeChatRoot(chat)}/${year}/${month}/${dateKey}.${String(part).padStart(4, "0")}.json`;
}

function localPathFor(relativePath: string): string {
	return path.join(localRoot(), ...relativePath.split("/"));
}

function remotePathFor(relativePath: string): string {
	return `${remoteRoot()}/${relativePath}`;
}

function parseMembers(value: unknown): StoredMemberProfile[] {
	const members = Array.isArray(value) ? value : [];
	return members.flatMap((member) => {
		const raw = member as Partial<StoredMemberProfile> | undefined;
		if (!raw || typeof raw.mid !== "string") return [];
		const names = Array.isArray(raw.names)
			? raw.names.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
			: [];
		const firstSeenAt = typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : new Date().toISOString();
		const lastSeenAt = typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : firstSeenAt;
		const state = ["JOINED", "LEFT", "KICK_OUT", "BANNED", "UNKNOWN"].includes(String(raw.state))
			? raw.state as StoredMemberState
			: "UNKNOWN";
		return [{
			mid: raw.mid,
			currentName: typeof raw.currentName === "string" ? raw.currentName : names.at(-1),
			names,
			state,
			role: typeof raw.role === "string" ? raw.role : undefined,
			firstSeenAt,
			lastSeenAt,
			lastMessageAt: Number.isFinite(raw.lastMessageAt) ? Number(raw.lastMessageAt) : undefined,
			messageCount: Number.isInteger(raw.messageCount) && (raw.messageCount ?? 0) >= 0 ? raw.messageCount as number : 0,
			sources: Array.isArray(raw.sources)
				? [...new Set(raw.sources.filter((source): source is string => typeof source === "string"))]
				: [],
			extra: raw.extra && typeof raw.extra === "object" ? raw.extra : undefined,
		}];
	});
}

function parseMessage(message: unknown, chat: Pick<StoredChat, "kind" | "chatMid" | "scopeMid" | "chatType">): StoredMessageLog | undefined {
	const raw = message as Partial<StoredMessageLog> | undefined;
	if (!raw || typeof raw.id !== "string" || typeof raw.senderMid !== "string" || typeof raw.content !== "string") {
		return undefined;
	}
	const createdAt = Number(raw.createdAt);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
	return {
		id: raw.id,
		kind: chat.kind,
		chatMid: chat.chatMid,
		scopeMid: chat.scopeMid,
		chatType: chat.chatType,
		senderMid: raw.senderMid,
		senderName: typeof raw.senderName === "string" ? raw.senderName : undefined,
		createdAt,
		content: raw.content,
		contentType: typeof raw.contentType === "string" ? raw.contentType : undefined,
		metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : undefined,
	};
}

function parseLegacyLog(value: unknown): LegacyMessageLogFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_LEGACY_LOG);
	const raw = value as Partial<LegacyMessageLogFile>;
	const chats = Array.isArray(raw.chats) ? raw.chats : [];
	return {
		version: 1,
		chats: chats.flatMap((chat) => {
			if (!chat || (chat.kind !== "talk" && chat.kind !== "square") ||
				typeof chat.chatMid !== "string" || typeof chat.scopeMid !== "string" ||
				!["USER", "GROUP", "ROOM", "SQUARE"].includes(String(chat.chatType))) return [];
			const base = {
				kind: chat.kind,
				chatMid: chat.chatMid,
				scopeMid: chat.scopeMid,
				chatType: chat.chatType,
			};
			return [{
				...base,
				backfillCompletedAt: typeof chat.backfillCompletedAt === "string" ? chat.backfillCompletedAt : undefined,
				oldestMessageAt: Number.isFinite(chat.oldestMessageAt) ? Number(chat.oldestMessageAt) : undefined,
				messages: (Array.isArray(chat.messages) ? chat.messages : []).flatMap((message) => {
					const parsed = parseMessage(message, base);
					return parsed ? [parsed] : [];
				}),
				members: parseMembers(chat.members),
			}];
		}),
	};
}

function decodeWrappedJson(content: string): unknown {
	const parsed = JSON.parse(content) as unknown;
	if (parsed && typeof parsed === "object") {
		const raw = parsed as { encoding?: unknown; data?: unknown };
		if (raw.encoding === "gzip+base64") {
			if (typeof raw.data !== "string") throw new Error("Compressed message log has no data");
			return JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8")) as unknown;
		}
	}
	return parsed;
}

function encodeWrappedJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function bytesOfJson(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sortMessages(messages: StoredMessageLog[]): StoredMessageLog[] {
	return [...messages].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function dedupeMessages(messages: StoredMessageLog[]): StoredMessageLog[] {
	const map = new Map<string, StoredMessageLog>();
	for (const message of sortMessages(messages)) {
		map.set(message.id, message);
	}
	return [...map.values()];
}

function partFile(
	chat: Pick<StoredChat, "kind" | "chatMid" | "scopeMid" | "chatType">,
	date: string,
	part: number,
	messages: StoredMessageLog[],
): MessageLogPartFile {
	return {
		version: 2,
		kind: chat.kind,
		chatMid: chat.chatMid,
		scopeMid: chat.scopeMid,
		chatType: chat.chatType,
		date,
		part,
		messages,
	};
}

function membersFile(chat: Pick<StoredChat, "kind" | "chatMid" | "scopeMid" | "chatType" | "members">): MessageLogMembersFile {
	return {
		version: 2,
		kind: chat.kind,
		chatMid: chat.chatMid,
		scopeMid: chat.scopeMid,
		chatType: chat.chatType,
		members: chat.members,
	};
}

class MessageLogStore {
	private data: LegacyMessageLogFile = structuredClone(EMPTY_LEGACY_LOG);
	private fileShas = new Map<string, string | undefined>();
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;
	private remoteFlushSuspendCount = 0;
	private autoFlushSuspendCount = 0;
	private dirtyDates = new Set<string>();
	private dirtyMembers = new Set<string>();
	private importedLegacy = false;

	async initialize(): Promise<void> {
		await fs.mkdir(localRoot(), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				if (await this.restoreSplitFromGitHub()) {
					console.log(`[message-log] loaded ${this.countMessages()} message(s) from split GitHub storage`);
					return;
				}
			} catch (error) {
				console.warn("[message-log] split GitHub restore failed", error);
			}
			try {
				const legacy = await githubContentsClient.read(appConfig.messageLogGithubPath);
				if (legacy) {
					this.data = parseLegacyLog(decodeWrappedJson(legacy.content));
					this.importedLegacy = true;
					this.markAllDirty();
					await this.writeSplitLocal();
					console.log(`[message-log] imported ${this.countMessages()} legacy message(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[message-log] legacy GitHub restore failed", error);
			}
		}
		try {
			if (await this.restoreSplitFromLocal()) {
				console.log(`[message-log] loaded ${this.countMessages()} message(s) from split local storage`);
				return;
			}
		} catch (error) {
			if (!this.isNotFoundError(error)) {
				console.warn("[message-log] split local restore failed", error);
			}
		}
		try {
			this.data = parseLegacyLog(JSON.parse(await fs.readFile(appConfig.messageLogFile, "utf8")) as unknown);
			this.importedLegacy = true;
			this.markAllDirty();
			await this.writeSplitLocal();
		} catch {
			await this.writeManifestLocal(this.buildPersistence().manifest);
		}
		console.log(`[message-log] loaded ${this.countMessages()} message(s)`);
	}

	record(message: StoredMessageLog): boolean {
		if (!message.id || !message.chatMid || !message.senderMid || !message.content) return false;
		const chat = this.getOrCreateChat(message);
		const existing = chat.messages.find((item) => item.id === message.id);
		if (existing) {
			let changed = false;
			if (!existing.senderName && message.senderName) {
				existing.senderName = message.senderName;
				changed = true;
			}
			if (existing.content !== message.content && message.content) {
				existing.content = message.content;
				changed = true;
			}
			if (changed) {
				this.markMessageDirty(existing);
				this.scheduleSave();
			}
			return false;
		}
		this.recordMember({
			kind: message.kind,
			chatMid: message.chatMid,
			scopeMid: message.scopeMid,
			chatType: message.chatType,
			mid: message.senderMid,
			name: message.senderName,
			state: "JOINED",
			seenAt: message.createdAt,
			lastMessageAt: message.createdAt,
			messageCountDelta: 1,
			source: "message",
		}, false);
		chat.messages.push({ ...message });
		if (!chat.oldestMessageAt || message.createdAt < chat.oldestMessageAt) {
			chat.oldestMessageAt = message.createdAt;
		}
		this.markMessageDirty(message);
		this.scheduleSave();
		return true;
	}

	recordMember(input: MemberProfileInput, schedule = true): void {
		if (!input.mid || !input.chatMid || !input.scopeMid) return;
		const chat = this.getOrCreateChat({
			id: "",
			kind: input.kind,
			chatMid: input.chatMid,
			scopeMid: input.scopeMid,
			chatType: input.chatType,
			senderMid: input.mid,
			createdAt: input.seenAt ?? Date.now(),
			content: "(member)",
		});
		const seenAt = new Date(input.seenAt ?? Date.now()).toISOString();
		let member = chat.members.find((item) => item.mid === input.mid);
		if (!member) {
			member = {
				mid: input.mid,
				currentName: input.name,
				names: input.name ? [input.name] : [],
				state: input.state ?? "UNKNOWN",
				role: input.role,
				firstSeenAt: seenAt,
				lastSeenAt: seenAt,
				lastMessageAt: input.lastMessageAt,
				messageCount: 0,
				sources: [],
				extra: input.extra,
			};
			chat.members.push(member);
		}
		if (input.name?.trim()) {
			member.currentName = input.name;
			if (!member.names.includes(input.name)) member.names.push(input.name);
		}
		if (input.state) member.state = input.state;
		if (input.role) member.role = input.role;
		if (input.lastMessageAt && (!member.lastMessageAt || input.lastMessageAt > member.lastMessageAt)) {
			member.lastMessageAt = input.lastMessageAt;
		}
		if (input.messageCountDelta) member.messageCount += input.messageCountDelta;
		if (input.source && !member.sources.includes(input.source)) member.sources.push(input.source);
		if (input.extra) member.extra = { ...(member.extra ?? {}), ...input.extra };
		if (seenAt < member.firstSeenAt) member.firstSeenAt = seenAt;
		if (seenAt > member.lastSeenAt) member.lastSeenAt = seenAt;
		this.dirtyMembers.add(chatKey(chat));
		if (schedule) this.scheduleSave();
	}

	recordMany(messages: StoredMessageLog[]): number {
		let added = 0;
		for (const message of messages) {
			if (this.record(message)) added++;
		}
		return added;
	}

	search(
		destination: Pick<LineDestination, "kind" | "chatMid">,
		query: string,
		senderMid?: string,
		limit = 1000,
	): StoredMessageLog[] {
		const chat = this.data.chats.find((item) => chatKey(item) === chatKey(destination));
		if (!chat) return [];
		const normalizedQuery = normalizeText(query);
		return chat.messages
			.filter((message) => !senderMid || message.senderMid === senderMid)
			.filter((message) => normalizeText(message.content).includes(normalizedQuery))
			.sort((left, right) => right.createdAt - left.createdAt)
			.slice(0, limit)
			.map((message) => ({ ...message }));
	}

	markBackfillComplete(destination: Pick<LineDestination, "kind" | "chatMid">, oldestMessageAt?: number): void {
		const chat = this.data.chats.find((item) => chatKey(item) === chatKey(destination));
		if (!chat) return;
		chat.backfillCompletedAt = new Date().toISOString();
		if (oldestMessageAt) chat.oldestMessageAt = oldestMessageAt;
		this.dirtyMembers.add(chatKey(chat));
		this.scheduleSave();
	}

	async flush(): Promise<MessageLogFlushResult> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (!this.dirty) {
			await this.saveQueue;
			return {
				localFiles: 0,
				remoteFiles: 0,
				remoteEnabled: githubContentsClient.enabled,
				remoteSkipped: false,
			};
		}
		this.dirty = false;
		const dirtyDates = new Set(this.dirtyDates);
		const dirtyMembers = new Set(this.dirtyMembers);
		this.dirtyDates.clear();
		this.dirtyMembers.clear();
		if (this.importedLegacy || dirtyDates.size === 0 && dirtyMembers.size === 0) {
			this.markAllDirty();
			for (const item of this.dirtyDates) dirtyDates.add(item);
			for (const item of this.dirtyMembers) dirtyMembers.add(item);
			this.dirtyDates.clear();
			this.dirtyMembers.clear();
			this.importedLegacy = false;
		}
		const persistence = this.buildPersistence();
		const operation = this.saveQueue.then(async (): Promise<MessageLogFlushResult> => {
			const localFiles = await this.writeSplitLocal(persistence, dirtyDates, dirtyMembers);
			let remoteFiles = 0;
			let remoteSkipped = false;
			if (githubContentsClient.enabled && this.remoteFlushSuspendCount === 0) {
				remoteFiles = await this.writeSplitRemote(persistence, dirtyDates, dirtyMembers);
			} else if (githubContentsClient.enabled) {
				remoteSkipped = true;
				this.dirty = true;
				for (const item of dirtyDates) this.dirtyDates.add(item);
				for (const item of dirtyMembers) this.dirtyMembers.add(item);
			}
			return {
				localFiles,
				remoteFiles,
				remoteEnabled: githubContentsClient.enabled,
				remoteSkipped,
			};
		});
		this.saveQueue = operation.then(() => undefined).catch((error) => {
			console.error("[message-log] save failed", error);
			this.dirty = true;
			for (const item of dirtyDates) this.dirtyDates.add(item);
			for (const item of dirtyMembers) this.dirtyMembers.add(item);
			this.scheduleSave();
		});
		return await operation;
	}

	async checkpointLocal(): Promise<void> {
		const dirtyDates = new Set(this.dirtyDates);
		const dirtyMembers = new Set(this.dirtyMembers);
		if (dirtyDates.size === 0 && dirtyMembers.size === 0) return;
		await this.writeSplitLocal(this.buildPersistence(), dirtyDates, dirtyMembers);
	}

	suspendRemoteFlush(): () => void {
		this.remoteFlushSuspendCount += 1;
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			this.remoteFlushSuspendCount = Math.max(0, this.remoteFlushSuspendCount - 1);
		};
	}

	suspendAutoFlush(): () => void {
		this.autoFlushSuspendCount += 1;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			this.autoFlushSuspendCount = Math.max(0, this.autoFlushSuspendCount - 1);
		};
	}

	private async restoreSplitFromGitHub(): Promise<boolean> {
		const manifestPath = remotePathFor("manifest.json");
		const remote = await githubContentsClient.read(manifestPath);
		if (!remote) return false;
		this.fileShas.set(manifestPath, remote.sha);
		const manifest = this.parseManifest(decodeWrappedJson(remote.content));
		this.data = await this.loadManifest(manifest, async (relativePath) => {
			const filePath = remotePathFor(relativePath);
			const file = await githubContentsClient.read(filePath);
			if (!file) throw new Error(`Missing remote message log file: ${filePath}`);
			this.fileShas.set(filePath, file.sha);
			return decodeWrappedJson(file.content);
		});
		await this.writeSplitLocal(this.buildPersistence());
		return true;
	}

	private async restoreSplitFromLocal(): Promise<boolean> {
		const manifestFile = localPathFor("manifest.json");
		const manifest = this.parseManifest(JSON.parse(await fs.readFile(manifestFile, "utf8")) as unknown);
		this.data = await this.loadManifest(manifest, async (relativePath) => {
			return JSON.parse(await fs.readFile(localPathFor(relativePath), "utf8")) as unknown;
		});
		return true;
	}

	private isNotFoundError(error: unknown): boolean {
		return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
	}

	private parseManifest(value: unknown): MessageLogManifest {
		const raw = value as Partial<MessageLogManifest> | undefined;
		if (!raw || raw.version !== 2 || raw.format !== "kbc-line-message-log" || !Array.isArray(raw.chats)) {
			throw new Error("Invalid message log manifest");
		}
		return {
			version: 2,
			format: "kbc-line-message-log",
			generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date().toISOString(),
			chats: raw.chats.flatMap((chat) => {
				if (!chat || (chat.kind !== "talk" && chat.kind !== "square") ||
					typeof chat.chatMid !== "string" || typeof chat.scopeMid !== "string" ||
					!["USER", "GROUP", "ROOM", "SQUARE"].includes(String(chat.chatType)) ||
					typeof chat.membersPath !== "string" || !Array.isArray(chat.parts)) return [];
				return [{
					kind: chat.kind,
					chatMid: chat.chatMid,
					scopeMid: chat.scopeMid,
					chatType: chat.chatType,
					backfillCompletedAt: typeof chat.backfillCompletedAt === "string" ? chat.backfillCompletedAt : undefined,
					oldestMessageAt: Number.isFinite(chat.oldestMessageAt) ? Number(chat.oldestMessageAt) : undefined,
					membersPath: chat.membersPath,
					parts: chat.parts.flatMap((part) => {
						if (!part || typeof part.path !== "string" || typeof part.date !== "string") return [];
						return [{
							path: part.path,
							date: part.date,
							part: Number(part.part) || 1,
							count: Number(part.count) || 0,
							firstCreatedAt: Number.isFinite(part.firstCreatedAt) ? Number(part.firstCreatedAt) : undefined,
							lastCreatedAt: Number.isFinite(part.lastCreatedAt) ? Number(part.lastCreatedAt) : undefined,
							bytes: Number(part.bytes) || 0,
						}];
					}),
				}];
			}),
		};
	}

	private async loadManifest(
		manifest: MessageLogManifest,
		readJson: (relativePath: string) => Promise<unknown>,
	): Promise<LegacyMessageLogFile> {
		const chats: StoredChat[] = [];
		for (const manifestChat of manifest.chats) {
			const membersRaw = await readJson(manifestChat.membersPath).catch(() => undefined);
			const membersFileRaw = membersRaw as Partial<MessageLogMembersFile> | undefined;
			const members = parseMembers(membersFileRaw?.members);
			const messages: StoredMessageLog[] = [];
			for (const part of manifestChat.parts) {
				const raw = await readJson(part.path);
				const file = raw as Partial<MessageLogPartFile>;
				const base = {
					kind: manifestChat.kind,
					chatMid: manifestChat.chatMid,
					scopeMid: manifestChat.scopeMid,
					chatType: manifestChat.chatType,
				};
				for (const message of Array.isArray(file.messages) ? file.messages : []) {
					const parsed = parseMessage(message, base);
					if (parsed) messages.push(parsed);
				}
			}
			chats.push({
				kind: manifestChat.kind,
				chatMid: manifestChat.chatMid,
				scopeMid: manifestChat.scopeMid,
				chatType: manifestChat.chatType,
				backfillCompletedAt: manifestChat.backfillCompletedAt,
				oldestMessageAt: manifestChat.oldestMessageAt,
				messages: dedupeMessages(messages),
				members,
			});
		}
		return { version: 1, chats };
	}

	private buildPersistence(): {
		manifest: MessageLogManifest;
		parts: Map<string, MessageLogPartFile>;
		members: Map<string, MessageLogMembersFile>;
		partDates: Map<string, string>;
		memberChats: Map<string, string>;
	} {
		const parts = new Map<string, MessageLogPartFile>();
		const members = new Map<string, MessageLogMembersFile>();
		const partDates = new Map<string, string>();
		const memberChats = new Map<string, string>();
		const manifest: MessageLogManifest = {
			version: 2,
			format: "kbc-line-message-log",
			generatedAt: new Date().toISOString(),
			chats: [],
		};

		for (const chat of this.data.chats) {
			const chatParts: MessageLogPartMeta[] = [];
			const byDate = new Map<string, StoredMessageLog[]>();
			for (const message of dedupeMessages(chat.messages)) {
				const date = jstDateKey(message.createdAt);
				const bucket = byDate.get(date) ?? [];
				bucket.push(message);
				byDate.set(date, bucket);
			}
			for (const [date, dateMessages] of [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
				let part = 1;
				let current: StoredMessageLog[] = [];
				const flushPart = () => {
					if (current.length === 0) return;
					const relativePath = relativePartPath(chat, date, part);
					const file = partFile(chat, date, part, current);
					const bytes = bytesOfJson(file);
					parts.set(relativePath, file);
					partDates.set(relativePath, `${chatKey(chat)}|${date}`);
					chatParts.push({
						path: relativePath,
						date,
						part,
						count: current.length,
						firstCreatedAt: current.at(0)?.createdAt,
						lastCreatedAt: current.at(-1)?.createdAt,
						bytes,
					});
					part += 1;
					current = [];
				};
				for (const message of sortMessages(dateMessages)) {
					const candidate = [...current, message];
					if (current.length > 0 && bytesOfJson(partFile(chat, date, part, candidate)) > appConfig.messageLogPartMaxBytes) {
						flushPart();
					}
					current.push(message);
				}
				flushPart();
			}
			const membersPath = relativeMembersPath(chat);
			members.set(membersPath, membersFile(chat));
			memberChats.set(membersPath, chatKey(chat));
			manifest.chats.push({
				kind: chat.kind,
				chatMid: chat.chatMid,
				scopeMid: chat.scopeMid,
				chatType: chat.chatType,
				backfillCompletedAt: chat.backfillCompletedAt,
				oldestMessageAt: chat.oldestMessageAt,
				membersPath,
				parts: chatParts,
			});
		}
		return { manifest, parts, members, partDates, memberChats };
	}

	private async writeSplitLocal(
		persistence = this.buildPersistence(),
		dirtyDates?: Set<string>,
		dirtyMembers?: Set<string>,
	): Promise<number> {
		let written = 0;
		await this.writeManifestLocal(persistence.manifest);
		written += 1;
		for (const [relativePath, file] of persistence.parts) {
			const dirtyKey = persistence.partDates.get(relativePath);
			if (dirtyDates && dirtyKey && !dirtyDates.has(dirtyKey)) continue;
			await this.writeLocalJson(relativePath, file);
			written += 1;
		}
		for (const [relativePath, file] of persistence.members) {
			const dirtyKey = persistence.memberChats.get(relativePath);
			if (dirtyMembers && dirtyKey && !dirtyMembers.has(dirtyKey)) continue;
			await this.writeLocalJson(relativePath, file);
			written += 1;
		}
		return written;
	}

	private async writeSplitRemote(
		persistence: ReturnType<MessageLogStore["buildPersistence"]>,
		dirtyDates: Set<string>,
		dirtyMembers: Set<string>,
	): Promise<number> {
		let written = 0;
		for (const [relativePath, file] of persistence.parts) {
			const dirtyKey = persistence.partDates.get(relativePath);
			if (dirtyKey && !dirtyDates.has(dirtyKey)) continue;
			await this.writeRemoteJson(relativePath, file);
			written += 1;
		}
		for (const [relativePath, file] of persistence.members) {
			const dirtyKey = persistence.memberChats.get(relativePath);
			if (dirtyKey && !dirtyMembers.has(dirtyKey)) continue;
			await this.writeRemoteJson(relativePath, file);
			written += 1;
		}
		await this.writeRemoteJson("manifest.json", persistence.manifest);
		written += 1;
		return written;
	}

	private async writeManifestLocal(manifest: MessageLogManifest): Promise<void> {
		await this.writeLocalJson("manifest.json", manifest);
	}

	private async writeLocalJson(relativePath: string, value: unknown): Promise<void> {
		const filePath = localPathFor(relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const temporary = `${filePath}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, filePath);
	}

	private async writeRemoteJson(relativePath: string, value: unknown): Promise<void> {
		const filePath = remotePathFor(relativePath);
		const sha = this.fileShas.get(filePath);
		const nextSha = await githubContentsClient.write(
			filePath,
			encodeWrappedJson(value),
			"Update LINE message log",
			sha,
		);
		this.fileShas.set(filePath, nextSha);
	}

	private getOrCreateChat(message: StoredMessageLog): StoredChat {
		const existing = this.data.chats.find((item) => chatKey(item) === chatKey(message));
		if (existing) return existing;
		const chat: StoredChat = {
			kind: message.kind,
			chatMid: message.chatMid,
			scopeMid: message.scopeMid,
			chatType: message.chatType,
			messages: [],
			members: [],
		};
		this.data.chats.push(chat);
		this.dirtyMembers.add(chatKey(chat));
		return chat;
	}

	private markMessageDirty(message: StoredMessageLog): void {
		this.dirtyDates.add(`${chatKey(message)}|${jstDateKey(message.createdAt)}`);
	}

	private markAllDirty(): void {
		for (const chat of this.data.chats) {
			this.dirtyMembers.add(chatKey(chat));
			for (const message of chat.messages) {
				this.markMessageDirty(message);
			}
		}
		this.dirty = true;
	}

	private countMessages(): number {
		return this.data.chats.reduce((sum, chat) => sum + chat.messages.length, 0);
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.autoFlushSuspendCount > 0) return;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush().catch((error) => {
				console.error("[message-log] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}
}

export const messageLogStore = new MessageLogStore();
