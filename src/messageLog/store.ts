import fs from "node:fs/promises";
import path from "node:path";
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

interface MessageLogFile {
	version: 1;
	chats: StoredChat[];
}

const EMPTY_LOG: MessageLogFile = { version: 1, chats: [] };
const SAVE_DELAY_MS = 15_000;

function chatKey(value: Pick<StoredChat, "kind" | "chatMid">): string {
	return `${value.kind}:${value.chatMid}`;
}

function parseLog(value: unknown): MessageLogFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_LOG);
	const raw = value as Partial<MessageLogFile>;
	const chats = Array.isArray(raw.chats) ? raw.chats : [];
	return {
		version: 1,
		chats: chats.flatMap((chat) => {
			if (!chat || (chat.kind !== "talk" && chat.kind !== "square") ||
				typeof chat.chatMid !== "string" || typeof chat.scopeMid !== "string" ||
				!["USER", "GROUP", "ROOM", "SQUARE"].includes(String(chat.chatType))) return [];
			const messages = Array.isArray(chat.messages) ? chat.messages : [];
			return [{
				kind: chat.kind,
				chatMid: chat.chatMid,
				scopeMid: chat.scopeMid,
				chatType: chat.chatType,
				backfillCompletedAt: typeof chat.backfillCompletedAt === "string" ? chat.backfillCompletedAt : undefined,
				oldestMessageAt: Number.isFinite(chat.oldestMessageAt) ? Number(chat.oldestMessageAt) : undefined,
				messages: messages.flatMap((message) => {
					if (!message || typeof message.id !== "string" || typeof message.senderMid !== "string" ||
						typeof message.content !== "string") return [];
					const createdAt = Number(message.createdAt);
					if (!Number.isFinite(createdAt) || createdAt <= 0) return [];
					return [{
						id: message.id,
						kind: chat.kind,
						chatMid: chat.chatMid,
						scopeMid: chat.scopeMid,
						chatType: chat.chatType,
						senderMid: message.senderMid,
						senderName: typeof message.senderName === "string" ? message.senderName : undefined,
						createdAt,
						content: message.content,
						contentType: typeof message.contentType === "string" ? message.contentType : undefined,
					}];
				}),
				members: parseMembers(chat.members),
			}];
		}),
	};
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

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

class MessageLogStore {
	private data: MessageLogFile = structuredClone(EMPTY_LOG);
	private githubSha: string | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private dirty = false;

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.messageLogFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.messageLogGithubPath);
				if (remote) {
					this.data = parseLog(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[message-log] loaded ${this.countMessages()} message(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[message-log] GitHub restore failed", error);
			}
		}
		try {
			this.data = parseLog(JSON.parse(await fs.readFile(appConfig.messageLogFile, "utf8")));
		} catch {
			await this.writeLocal();
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
			if (changed) this.scheduleSave();
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
		this.scheduleSave();
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
					appConfig.messageLogGithubPath,
					`${JSON.stringify(snapshot, null, 2)}\n`,
					"Update LINE message log",
					this.githubSha,
				);
			}
		});
		this.saveQueue = operation.catch((error) => {
			console.error("[message-log] save failed", error);
			this.dirty = true;
			this.scheduleSave();
		});
		await operation;
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
		return chat;
	}

	private countMessages(): number {
		return this.data.chats.reduce((sum, chat) => sum + chat.messages.length, 0);
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush().catch((error) => {
				console.error("[message-log] scheduled save failed", error);
			});
		}, SAVE_DELAY_MS);
	}

	private async writeLocal(value: MessageLogFile = this.data): Promise<void> {
		const temporary = `${appConfig.messageLogFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.messageLogFile);
	}
}

export const messageLogStore = new MessageLogStore();
