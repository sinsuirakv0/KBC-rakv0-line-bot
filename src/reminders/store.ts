import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LineDestination } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface PushReminder {
	id: string;
	kind: "talk" | "square";
	chatMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	encrypted: boolean;
	userMid: string;
	userName?: string;
	message: string;
	remindAt: string;
	createdAt: string;
}

interface ReminderFile {
	version: 1;
	reminders: PushReminder[];
}

const EMPTY: ReminderFile = { version: 1, reminders: [] };

function isChatType(value: unknown): value is PushReminder["chatType"] {
	return value === "USER" || value === "GROUP" || value === "ROOM" || value === "SQUARE";
}

function parseData(value: unknown): ReminderFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY);
	const raw = value as Partial<ReminderFile>;
	const reminders = Array.isArray(raw.reminders)
		? raw.reminders.filter((item): item is PushReminder => {
			if (!item || typeof item !== "object") return false;
			const reminder = item as Partial<PushReminder>;
			return typeof reminder.id === "string" &&
				(reminder.kind === "talk" || reminder.kind === "square") &&
				typeof reminder.chatMid === "string" &&
				isChatType(reminder.chatType) &&
				typeof reminder.userMid === "string" &&
				typeof reminder.message === "string" &&
				typeof reminder.remindAt === "string" &&
				typeof reminder.createdAt === "string" &&
				Number.isFinite(Date.parse(reminder.remindAt));
		})
		: [];
	return {
		version: 1,
		reminders: reminders
			.map((item) => ({
				...item,
				encrypted: Boolean(item.encrypted),
				userName: typeof item.userName === "string" ? item.userName : undefined,
			}))
			.sort((left, right) => Date.parse(left.remindAt) - Date.parse(right.remindAt)),
	};
}

class PushReminderStore {
	private data: ReminderFile = structuredClone(EMPTY);
	private githubSha: string | undefined;
	private saveQueue: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		await fs.mkdir(path.dirname(appConfig.pushRemindersFile), { recursive: true });
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.pushRemindersGithubPath);
				if (remote) {
					this.data = parseData(JSON.parse(remote.content));
					this.githubSha = remote.sha;
					await this.writeLocal();
					console.log(`[push:reminder] restored ${this.data.reminders.length} reminder(s) from GitHub`);
					return;
				}
			} catch (error) {
				console.warn("[push:reminder] GitHub restore failed; using local storage", error);
			}
		}

		try {
			this.data = parseData(JSON.parse(await fs.readFile(appConfig.pushRemindersFile, "utf8")));
		} catch {
			await this.writeLocal();
		}
		console.log(`[push:reminder] loaded ${this.data.reminders.length} reminder(s)`);
	}

	listDue(now: Date): PushReminder[] {
		const nowMs = now.getTime();
		return this.data.reminders
			.filter((item) => Date.parse(item.remindAt) <= nowMs)
			.map((item) => ({ ...item }));
	}

	async add(input: {
		destination: LineDestination;
		remindAt: Date;
		message: string;
	}): Promise<PushReminder> {
		const reminder: PushReminder = {
			id: randomUUID(),
			kind: input.destination.kind,
			chatMid: input.destination.chatMid,
			chatType: input.destination.chatType,
			encrypted: input.destination.encrypted,
			userMid: input.destination.senderMid,
			userName: input.destination.senderName,
			message: input.message,
			remindAt: input.remindAt.toISOString(),
			createdAt: new Date().toISOString(),
		};
		this.data.reminders.push(reminder);
		this.data.reminders.sort((left, right) => Date.parse(left.remindAt) - Date.parse(right.remindAt));
		await this.save();
		return { ...reminder };
	}

	async remove(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const targets = new Set(ids);
		const before = this.data.reminders.length;
		this.data.reminders = this.data.reminders.filter((item) => !targets.has(item.id));
		if (this.data.reminders.length === before) return;
		await this.save();
	}

	private async save(): Promise<void> {
		await this.enqueue(async () => {
			await this.writeLocal();
			if (githubContentsClient.enabled) {
				this.githubSha = await githubContentsClient.write(
					appConfig.pushRemindersGithubPath,
					`${JSON.stringify(this.data, null, 2)}\n`,
					"Update LINE push reminders",
					this.githubSha,
				);
			}
		});
	}

	private async enqueue(operation: () => Promise<void>): Promise<void> {
		const current = this.saveQueue.then(operation);
		this.saveQueue = current.catch(() => {});
		await current;
	}

	private async writeLocal(): Promise<void> {
		const temporary = `${appConfig.pushRemindersFile}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
		await fs.rename(temporary, appConfig.pushRemindersFile);
	}
}

export const pushReminderStore = new PushReminderStore();
