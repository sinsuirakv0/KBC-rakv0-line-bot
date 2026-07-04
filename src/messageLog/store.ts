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

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function emptyManifest(): MessageLogManifest {
	return {
		version: 2,
		format: "kbc-line-message-log",
		generatedAt: new Date().toISOString(),
		chats: [],
	};
}

function chatKey(value: Pick<StoredChat, "kind" | "chatMid">): string {
	return `${value.kind}:${value.chatMid}`;
}

function bucketKey(value: Pick<StoredChat, "kind" | "chatMid">, date: string): string {
	return `${chatKey(value)}|${date}`;
}

function splitBucketKey(value: string): { key: string; date: string } {
	const index = value.lastIndexOf("|");
	return { key: value.slice(0, index), date: value.slice(index + 1) };
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

function encodeWrappedJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
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

function bytesOfJson(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sortMessages(messages: StoredMessageLog[]): StoredMessageLog[] {
	return [...messages].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function sortMessagesDesc(messages: StoredMessageLog[]): StoredMessageLog[] {
	return [...messages].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
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
	if (!value || typeof value !== "object") return { version: 1, chats: [] };
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
	private manifest: MessageLogManifest = emptyManifest();
	private chatsByKey = new Map<string, StoredChat>();
	private manifestChatsByKey = new Map<string, MessageLogManifestChat>();
	private messagesByChat = new Map<string, Map<string, StoredMessageLog>>();
	private membersLoaded = new Set<string>();
	private fileShas = new Map<string, string | undefined>();
	private pendingRemotePaths = new Set<string>();
	private dirtyMessages = new Map<string, Map<string, StoredMessageLog>>();
	private dirtyMembers = new Set<string>();
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;
	private remoteFlushSuspendCount = 0;
	private autoFlushSuspendCount = 0;
	private importedLegacy = false;

	async initialize(): Promise<void> {
		await fs.mkdir(localRoot(), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				if (await this.restoreManifestFromGitHub()) {
					console.log(`[message-log] loaded manifest from GitHub (${this.manifest.chats.length} chat(s)); message parts are lazy-loaded`);
					this.warmLowPriorityLocalCache();
					return;
				}
			} catch (error) {
				console.warn("[message-log] GitHub manifest restore failed", error);
			}
		}
		try {
			if (await this.restoreManifestFromLocal()) {
				console.log(`[message-log] loaded local manifest (${this.manifest.chats.length} chat(s)); message parts are lazy-loaded`);
				return;
			}
		} catch (error) {
			if (!this.isNotFoundError(error)) console.warn("[message-log] local manifest restore failed", error);
		}
		try {
			const legacy = parseLegacyLog(JSON.parse(await fs.readFile(appConfig.messageLogFile, "utf8")) as unknown);
			await this.importLegacy(legacy);
			console.log(`[message-log] imported ${legacy.chats.reduce((sum, chat) => sum + chat.messages.length, 0)} legacy message(s)`);
			return;
		} catch {
			await this.writeManifestLocal();
		}
		console.log("[message-log] initialized empty lazy storage");
	}

	record(message: StoredMessageLog): boolean {
		if (!message.id || !message.chatMid || !message.senderMid || !message.content) return false;
		const chat = this.getOrCreateChat(message);
		const key = chatKey(chat);
		const messagesById = this.messagesByChat.get(key) ?? new Map<string, StoredMessageLog>();
		this.messagesByChat.set(key, messagesById);
		const existing = messagesById.get(message.id);
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

		const stored = { ...message };
		chat.messages.push(stored);
		messagesById.set(stored.id, stored);
		if (!chat.oldestMessageAt || stored.createdAt < chat.oldestMessageAt) {
			chat.oldestMessageAt = stored.createdAt;
			this.getOrCreateManifestChat(chat).oldestMessageAt = stored.createdAt;
		}
		this.markMessageDirty(stored);
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

	async search(
		destination: Pick<LineDestination, "kind" | "chatMid">,
		query: string,
		senderMid?: string,
		limit = 1000,
	): Promise<StoredMessageLog[]> {
		const chat = this.chatsByKey.get(chatKey(destination));
		const manifestChat = this.manifestChatsByKey.get(chatKey(destination));
		if (!chat && !manifestChat) return [];
		const normalizedQuery = normalizeText(query);
		const rows: StoredMessageLog[] = [];
		const seen = new Set<string>();
		const consider = (message: StoredMessageLog) => {
			if (seen.has(message.id)) return;
			seen.add(message.id);
			if (senderMid && message.senderMid !== senderMid) return;
			if (!normalizeText(message.content).includes(normalizedQuery)) return;
			rows.push({ ...message });
		};

		for (const message of sortMessagesDesc(chat?.messages ?? [])) {
			consider(message);
			if (rows.length >= limit) return rows;
		}

		const parts = [...(manifestChat?.parts ?? [])]
			.sort((left, right) => (right.lastCreatedAt ?? 0) - (left.lastCreatedAt ?? 0));
		for (const part of parts) {
			const file = await this.readPartFile(part.path, manifestChat);
			if (!file) continue;
			for (const message of sortMessagesDesc(file.messages)) {
				consider(message);
				if (rows.length >= limit) return rows;
			}
		}
		return rows;
	}

	markBackfillComplete(destination: Pick<LineDestination, "kind" | "chatMid">, oldestMessageAt?: number): void {
		const chat = this.chatsByKey.get(chatKey(destination));
		if (!chat) return;
		const now = new Date().toISOString();
		chat.backfillCompletedAt = now;
		if (oldestMessageAt) chat.oldestMessageAt = oldestMessageAt;
		const manifestChat = this.getOrCreateManifestChat(chat);
		manifestChat.backfillCompletedAt = now;
		if (oldestMessageAt) manifestChat.oldestMessageAt = oldestMessageAt;
		this.dirtyMembers.add(chatKey(chat));
		this.dirty = true;
		this.scheduleSave();
	}

	async flush(): Promise<MessageLogFlushResult> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		const operation = this.saveQueue.then(async (): Promise<MessageLogFlushResult> => {
			const localFiles = await this.persistLocalDirty();
			let remoteFiles = 0;
			let remoteSkipped = false;
			if (githubContentsClient.enabled && this.remoteFlushSuspendCount === 0) {
				remoteFiles = await this.flushPendingRemote();
			} else if (githubContentsClient.enabled && this.pendingRemotePaths.size > 0) {
				remoteSkipped = true;
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
			this.scheduleSave();
		});
		return await operation;
	}

	async checkpointLocal(): Promise<void> {
		await this.persistLocalDirty();
	}

	async flushLocalOnly(): Promise<number> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		return await this.persistLocalDirty();
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

	private async restoreManifestFromGitHub(): Promise<boolean> {
		const manifestPath = remotePathFor("manifest.json");
		const remote = await githubContentsClient.read(manifestPath);
		if (!remote) return false;
		this.fileShas.set(manifestPath, remote.sha);
		this.setManifest(this.parseManifest(decodeWrappedJson(remote.content)));
		await this.writeManifestLocal();
		return true;
	}

	private async restoreManifestFromLocal(): Promise<boolean> {
		const manifest = this.parseManifest(JSON.parse(await fs.readFile(localPathFor("manifest.json"), "utf8")) as unknown);
		this.setManifest(manifest);
		return true;
	}

	private setManifest(manifest: MessageLogManifest): void {
		this.manifest = manifest;
		this.chatsByKey.clear();
		this.manifestChatsByKey.clear();
		this.messagesByChat.clear();
		this.membersLoaded.clear();
		for (const manifestChat of manifest.chats) {
			const chat: StoredChat = {
				kind: manifestChat.kind,
				chatMid: manifestChat.chatMid,
				scopeMid: manifestChat.scopeMid,
				chatType: manifestChat.chatType,
				backfillCompletedAt: manifestChat.backfillCompletedAt,
				oldestMessageAt: manifestChat.oldestMessageAt,
				messages: [],
				members: [],
			};
			const key = chatKey(chat);
			this.chatsByKey.set(key, chat);
			this.manifestChatsByKey.set(key, manifestChat);
			this.messagesByChat.set(key, new Map());
		}
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

	private async importLegacy(legacy: LegacyMessageLogFile): Promise<void> {
		this.manifest = emptyManifest();
		this.chatsByKey.clear();
		this.manifestChatsByKey.clear();
		this.messagesByChat.clear();
		this.membersLoaded.clear();
		for (const chat of legacy.chats) {
			const stored = this.getOrCreateChat({
				id: "",
				kind: chat.kind,
				chatMid: chat.chatMid,
				scopeMid: chat.scopeMid,
				chatType: chat.chatType,
				senderMid: "",
				createdAt: Date.now(),
				content: "(chat)",
			});
			stored.backfillCompletedAt = chat.backfillCompletedAt;
			stored.oldestMessageAt = chat.oldestMessageAt;
			stored.members = chat.members;
			this.membersLoaded.add(chatKey(stored));
			for (const message of chat.messages) this.record(message);
			this.dirtyMembers.add(chatKey(stored));
		}
		this.importedLegacy = true;
		await this.persistLocalDirty();
	}

	private async persistLocalDirty(): Promise<number> {
		if (!this.dirty && this.dirtyMessages.size === 0 && this.dirtyMembers.size === 0 && !this.importedLegacy) {
			return 0;
		}
		let written = 0;
		const dirtyMessages = new Map(this.dirtyMessages);
		const dirtyMembers = new Set(this.dirtyMembers);
		this.dirtyMessages.clear();
		this.dirtyMembers.clear();
		this.dirty = false;
		this.importedLegacy = false;

		for (const [rawBucketKey, messagesById] of dirtyMessages) {
			const { key, date } = splitBucketKey(rawBucketKey);
			const chat = this.chatsByKey.get(key);
			if (!chat || messagesById.size === 0) continue;
			const manifestChat = this.getOrCreateManifestChat(chat);
			let part = Math.max(0, ...manifestChat.parts.filter((item) => item.date === date).map((item) => item.part)) + 1;
			let current: StoredMessageLog[] = [];
			const flushPart = async () => {
				if (current.length === 0) return;
				const relativePath = relativePartPath(chat, date, part);
				const file = partFile(chat, date, part, sortMessages(current));
				await this.writeLocalJson(relativePath, file);
				const meta: MessageLogPartMeta = {
					path: relativePath,
					date,
					part,
					count: file.messages.length,
					firstCreatedAt: file.messages.at(0)?.createdAt,
					lastCreatedAt: file.messages.at(-1)?.createdAt,
					bytes: bytesOfJson(file),
				};
				manifestChat.parts.push(meta);
				this.pendingRemotePaths.add(relativePath);
				written += 1;
				part += 1;
				current = [];
			};
			for (const message of sortMessages([...messagesById.values()])) {
				const candidate = [...current, message];
				if (current.length > 0 && bytesOfJson(partFile(chat, date, part, candidate)) > appConfig.messageLogPartMaxBytes) {
					await flushPart();
				}
				current.push(message);
			}
			await flushPart();
			const flushedIds = new Set(messagesById.keys());
			chat.messages = chat.messages.filter((message) => !flushedIds.has(message.id));
			const indexedMessages = this.messagesByChat.get(key);
			for (const id of flushedIds) indexedMessages?.delete(id);
		}

		for (const key of dirtyMembers) {
			const chat = this.chatsByKey.get(key);
			if (!chat) continue;
			await this.ensureMembersLoaded(chat);
			const relativePath = relativeMembersPath(chat);
			await this.writeLocalJson(relativePath, membersFile(chat));
			this.pendingRemotePaths.add(relativePath);
			written += 1;
		}

		if (written > 0 || dirtyMembers.size > 0 || dirtyMessages.size > 0) {
			await this.writeManifestLocal();
			this.pendingRemotePaths.add("manifest.json");
			written += 1;
		}
		return written;
	}

	private async flushPendingRemote(): Promise<number> {
		if (this.pendingRemotePaths.size === 0) return 0;
		let written = 0;
		const paths = [...this.pendingRemotePaths].sort((left, right) => {
			if (left === "manifest.json") return 1;
			if (right === "manifest.json") return -1;
			return left.localeCompare(right);
		});
		for (const relativePath of paths) {
			const content = await fs.readFile(localPathFor(relativePath), "utf8");
			const filePath = remotePathFor(relativePath);
			const nextSha = await githubContentsClient.write(
				filePath,
				content,
				"Update LINE message log",
				this.fileShas.get(filePath),
			);
			this.fileShas.set(filePath, nextSha);
			this.pendingRemotePaths.delete(relativePath);
			written += 1;
		}
		return written;
	}

	private async readPartFile(relativePath: string, manifestChat?: MessageLogManifestChat): Promise<MessageLogPartFile | undefined> {
		const raw = await this.readJson(relativePath);
		if (!raw) return undefined;
		const base = manifestChat ?? this.manifest.chats.find((chat) => chat.parts.some((part) => part.path === relativePath));
		if (!base) return undefined;
		const file = raw as Partial<MessageLogPartFile>;
		return {
			version: 2,
			kind: base.kind,
			chatMid: base.chatMid,
			scopeMid: base.scopeMid,
			chatType: base.chatType,
			date: typeof file.date === "string" ? file.date : "",
			part: Number(file.part) || 1,
			messages: (Array.isArray(file.messages) ? file.messages : []).flatMap((message) => {
				const parsed = parseMessage(message, base);
				return parsed ? [parsed] : [];
			}),
		};
	}

	private async ensureMembersLoaded(chat: StoredChat): Promise<void> {
		const key = chatKey(chat);
		if (this.membersLoaded.has(key)) return;
		const raw = await this.readJson(relativeMembersPath(chat));
		const existingMembers = parseMembers((raw as Partial<MessageLogMembersFile> | undefined)?.members);
		const merged = new Map<string, StoredMemberProfile>();
		for (const member of existingMembers) merged.set(member.mid, member);
		for (const member of chat.members) merged.set(member.mid, this.mergeMember(merged.get(member.mid), member));
		chat.members = [...merged.values()];
		this.membersLoaded.add(key);
	}

	private mergeMember(existing: StoredMemberProfile | undefined, next: StoredMemberProfile): StoredMemberProfile {
		if (!existing) return next;
		return {
			...existing,
			...next,
			names: [...new Set([...existing.names, ...next.names])],
			messageCount: Math.max(existing.messageCount, next.messageCount),
			sources: [...new Set([...existing.sources, ...next.sources])],
			firstSeenAt: existing.firstSeenAt < next.firstSeenAt ? existing.firstSeenAt : next.firstSeenAt,
			lastSeenAt: existing.lastSeenAt > next.lastSeenAt ? existing.lastSeenAt : next.lastSeenAt,
			lastMessageAt: Math.max(existing.lastMessageAt ?? 0, next.lastMessageAt ?? 0) || undefined,
			extra: { ...(existing.extra ?? {}), ...(next.extra ?? {}) },
		};
	}

	private async readJson(relativePath: string): Promise<unknown | undefined> {
		try {
			return JSON.parse(await fs.readFile(localPathFor(relativePath), "utf8")) as unknown;
		} catch (error) {
			if (!this.isNotFoundError(error)) throw error;
		}
		if (!githubContentsClient.enabled) return undefined;
		const remote = await githubContentsClient.read(remotePathFor(relativePath));
		if (!remote) return undefined;
		this.fileShas.set(remotePathFor(relativePath), remote.sha);
		const parsed = decodeWrappedJson(remote.content);
		await this.writeLocalJson(relativePath, parsed);
		return parsed;
	}

	private getOrCreateChat(message: StoredMessageLog): StoredChat {
		const key = chatKey(message);
		const existing = this.chatsByKey.get(key);
		if (existing) return existing;
		const chat: StoredChat = {
			kind: message.kind,
			chatMid: message.chatMid,
			scopeMid: message.scopeMid,
			chatType: message.chatType,
			messages: [],
			members: [],
		};
		this.chatsByKey.set(key, chat);
		this.messagesByChat.set(key, new Map());
		this.getOrCreateManifestChat(chat);
		this.dirtyMembers.add(key);
		return chat;
	}

	private getOrCreateManifestChat(chat: Pick<StoredChat, "kind" | "chatMid" | "scopeMid" | "chatType" | "backfillCompletedAt" | "oldestMessageAt">): MessageLogManifestChat {
		const key = chatKey(chat);
		const existing = this.manifestChatsByKey.get(key);
		if (existing) return existing;
		const manifestChat: MessageLogManifestChat = {
			kind: chat.kind,
			chatMid: chat.chatMid,
			scopeMid: chat.scopeMid,
			chatType: chat.chatType,
			backfillCompletedAt: chat.backfillCompletedAt,
			oldestMessageAt: chat.oldestMessageAt,
			membersPath: relativeMembersPath(chat),
			parts: [],
		};
		this.manifest.chats.push(manifestChat);
		this.manifestChatsByKey.set(key, manifestChat);
		return manifestChat;
	}

	private markMessageDirty(message: StoredMessageLog): void {
		const date = jstDateKey(message.createdAt);
		const key = bucketKey(message, date);
		const messages = this.dirtyMessages.get(key) ?? new Map<string, StoredMessageLog>();
		messages.set(message.id, message);
		this.dirtyMessages.set(key, messages);
		this.dirty = true;
	}

	private async writeManifestLocal(): Promise<void> {
		this.manifest.generatedAt = new Date().toISOString();
		await this.writeLocalJson("manifest.json", this.manifest);
	}

	private async writeLocalJson(relativePath: string, value: unknown): Promise<void> {
		const filePath = localPathFor(relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const temporary = `${filePath}.tmp`;
		await fs.writeFile(temporary, encodeWrappedJson(value), "utf8");
		await fs.rename(temporary, filePath);
	}

	private warmLowPriorityLocalCache(): void {
		setTimeout(() => {
			void this.writeManifestLocal().catch((error) => {
				console.warn("[message-log] low priority manifest cache failed", error);
			});
		}, 5_000);
	}

	private isNotFoundError(error: unknown): boolean {
		return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.autoFlushSuspendCount > 0) return;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flushLocalOnly().catch((error) => {
				console.error("[message-log] scheduled save failed", error);
			});
		}, appConfig.messageLogAutoFlushMs);
	}
}

export const messageLogStore = new MessageLogStore();
