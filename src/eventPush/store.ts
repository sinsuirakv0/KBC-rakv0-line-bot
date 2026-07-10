import fs from "node:fs/promises";
import path from "node:path";
import type { LineDestination } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { githubContentsClient } from "../storage/githubContents.js";

export interface EventPushSubscription {
	kind: "talk" | "square";
	chatMid: string;
	chatType: "USER" | "GROUP" | "ROOM" | "SQUARE";
	encrypted: boolean;
	eventIds: number[];
	advanceMinutesByEvent: Record<string, number>;
	allEvents: boolean;
	daily: boolean;
	registeredBy: string;
	updatedAt: string;
}

interface SubscriptionFile {
	version: 3;
	subscriptions: EventPushSubscription[];
}

interface NotificationStateFile {
	version: 1;
	notifiedKeys: string[];
}

const EMPTY_SUBSCRIPTIONS: SubscriptionFile = { version: 3, subscriptions: [] };
const EMPTY_STATE: NotificationStateFile = { version: 1, notifiedKeys: [] };

function targetKey(target: Pick<LineDestination, "kind" | "chatMid">): string {
	return `${target.kind}:${target.chatMid}`;
}

function parseSubscriptions(value: unknown): SubscriptionFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_SUBSCRIPTIONS);
	const raw = value as { subscriptions?: unknown };
	const subscriptions = Array.isArray(raw.subscriptions)
		? raw.subscriptions.filter((item): item is Record<string, unknown> =>
			Boolean(item && typeof item === "object" &&
				typeof (item as Record<string, unknown>).chatMid === "string" &&
				((item as Record<string, unknown>).kind === "talk" ||
					(item as Record<string, unknown>).kind === "square")))
		: [];
	return {
		version: 3,
		subscriptions: subscriptions.map((item) => {
			const eventIds = [...new Set(
				(Array.isArray(item.eventIds) ? item.eventIds : [])
					.filter((eventId): eventId is number => Number.isSafeInteger(eventId)),
			)].sort((a, b) => a - b);
			const rawAdvanceMinutes = item.advanceMinutesByEvent;
			const advanceMinutesByEvent: Record<string, number> = {};
			if (rawAdvanceMinutes && typeof rawAdvanceMinutes === "object" && !Array.isArray(rawAdvanceMinutes)) {
				for (const eventId of eventIds) {
					const minutes = (rawAdvanceMinutes as Record<string, unknown>)[String(eventId)];
					if (Number.isSafeInteger(minutes) && (minutes as number) > 0) {
						advanceMinutesByEvent[String(eventId)] = minutes as number;
					}
				}
			}
			return {
				kind: item.kind as EventPushSubscription["kind"],
				chatMid: item.chatMid as string,
				chatType: item.chatType as EventPushSubscription["chatType"],
				encrypted: Boolean(item.encrypted),
				eventIds,
				advanceMinutesByEvent,
				allEvents: item.allEvents === true,
				daily: item.daily === true,
				registeredBy: typeof item.registeredBy === "string" ? item.registeredBy : "",
				updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
			};
		}),
	};
}

function parseState(value: unknown): NotificationStateFile {
	if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE);
	const raw = value as Partial<NotificationStateFile>;
	return {
		version: 1,
		notifiedKeys: Array.isArray(raw.notifiedKeys)
			? raw.notifiedKeys.filter((key): key is string => typeof key === "string").slice(-5_000)
			: [],
	};
}

class EventPushStore {
	private subscriptions: SubscriptionFile = structuredClone(EMPTY_SUBSCRIPTIONS);
	private state: NotificationStateFile = structuredClone(EMPTY_STATE);
	private subscriptionsSha: string | undefined;
	private stateSha: string | undefined;
	private saveQueue: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		await Promise.all([
			fs.mkdir(path.dirname(appConfig.eventPushSubscriptionsFile), { recursive: true }),
			fs.mkdir(path.dirname(appConfig.eventPushStateFile), { recursive: true }),
		]);
		await Promise.all([this.loadSubscriptions(), this.loadState()]);
		console.log(`[push:event] loaded ${this.subscriptions.subscriptions.length} subscription(s)`);
	}

	list(): EventPushSubscription[] {
		return this.subscriptions.subscriptions.map((item) => ({
			...item,
			eventIds: [...item.eventIds],
			advanceMinutesByEvent: { ...item.advanceMinutesByEvent },
		}));
	}

	get(destination: Pick<LineDestination, "kind" | "chatMid">): EventPushSubscription | undefined {
		const key = targetKey(destination);
		const found = this.subscriptions.subscriptions.find((item) => targetKey(item) === key);
		return found
			? {
				...found,
				eventIds: [...found.eventIds],
				advanceMinutesByEvent: { ...found.advanceMinutesByEvent },
			}
			: undefined;
	}

	async registerDestination(destination: LineDestination): Promise<void> {
		const current = this.get(destination);
		await this.upsert(
			destination,
			current?.eventIds ?? [],
			current?.advanceMinutesByEvent ?? {},
			current?.allEvents ?? false,
			current?.daily ?? false,
		);
	}

	async addId(
		destination: LineDestination,
		eventId: number,
		advanceMinutes?: number,
	): Promise<number[]> {
		const current = this.get(destination);
		const eventIds = [...new Set([...(current?.eventIds ?? []), eventId])].sort((a, b) => a - b);
		const advanceMinutesByEvent = { ...(current?.advanceMinutesByEvent ?? {}) };
		if (advanceMinutes !== undefined) {
			advanceMinutesByEvent[String(eventId)] = advanceMinutes;
		}
		await this.upsert(
			destination,
			eventIds,
			advanceMinutesByEvent,
			current?.allEvents ?? false,
			current?.daily ?? false,
		);
		return eventIds;
	}

	async setAllEvents(destination: LineDestination, enabled: boolean): Promise<"updated" | "unchanged"> {
		const current = this.get(destination);
		if (!current && !enabled) return "unchanged";
		if (current?.allEvents === enabled) return "unchanged";
		await this.upsert(
			destination,
			current?.eventIds ?? [],
			current?.advanceMinutesByEvent ?? {},
			enabled,
			current?.daily ?? false,
		);
		return "updated";
	}

	async setDaily(destination: LineDestination, enabled: boolean): Promise<"updated" | "unchanged"> {
		const current = this.get(destination);
		if (!current && !enabled) return "unchanged";
		if (current?.daily === enabled) return "unchanged";
		await this.upsert(
			destination,
			current?.eventIds ?? [],
			current?.advanceMinutesByEvent ?? {},
			current?.allEvents ?? false,
			enabled,
		);
		return "updated";
	}

	async remove(destination: Pick<LineDestination, "kind" | "chatMid">): Promise<boolean> {
		const key = targetKey(destination);
		const before = this.subscriptions.subscriptions.length;
		this.subscriptions.subscriptions = this.subscriptions.subscriptions
			.filter((item) => targetKey(item) !== key);
		if (this.subscriptions.subscriptions.length === before) return false;
		await this.saveSubscriptions();
		return true;
	}

	async removeId(
		destination: Pick<LineDestination, "kind" | "chatMid">,
		eventId: number,
	): Promise<"removed" | "not-found"> {
		const current = this.get(destination);
		if (!current) return "not-found";
		if (!current.eventIds.includes(eventId)) return "not-found";
		const remaining = current.eventIds.filter((id) => id !== eventId);
		const advanceMinutesByEvent = { ...current.advanceMinutesByEvent };
		delete advanceMinutesByEvent[String(eventId)];
		this.subscriptions.subscriptions = this.subscriptions.subscriptions.map((item) =>
			targetKey(item) === targetKey(destination)
				? {
					...item,
					eventIds: remaining,
					advanceMinutesByEvent,
					updatedAt: new Date().toISOString(),
				}
				: item
		);
		await this.saveSubscriptions();
		return "removed";
	}

	hasNotified(key: string): boolean {
		return this.state.notifiedKeys.includes(key);
	}

	async markNotified(keys: string[]): Promise<void> {
		const additions = keys.filter((key) => !this.state.notifiedKeys.includes(key));
		if (additions.length === 0) return;
		this.state.notifiedKeys.push(...additions);
		this.state.notifiedKeys = this.state.notifiedKeys.slice(-5_000);
		await this.saveState();
	}

	private async upsert(
		destination: LineDestination,
		eventIds: number[],
		advanceMinutesByEvent: Record<string, number>,
		allEvents: boolean,
		daily: boolean,
	): Promise<void> {
		const key = targetKey(destination);
		const value: EventPushSubscription = {
			kind: destination.kind,
			chatMid: destination.chatMid,
			chatType: destination.chatType,
			encrypted: destination.encrypted,
			eventIds,
			advanceMinutesByEvent,
			allEvents,
			daily,
			registeredBy: destination.senderMid,
			updatedAt: new Date().toISOString(),
		};
		const index = this.subscriptions.subscriptions.findIndex((item) => targetKey(item) === key);
		if (index === -1) this.subscriptions.subscriptions.push(value);
		else this.subscriptions.subscriptions[index] = value;
		await this.saveSubscriptions();
	}

	private async loadSubscriptions(): Promise<void> {
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.eventPushSubscriptionsGithubPath);
				if (remote) {
					this.subscriptions = parseSubscriptions(JSON.parse(remote.content));
					this.subscriptionsSha = remote.sha;
					await this.writeLocal(appConfig.eventPushSubscriptionsFile, this.subscriptions);
					return;
				}
			} catch (error) {
				console.warn("[push:event] GitHub subscription restore failed", error);
			}
		}
		try {
			this.subscriptions = parseSubscriptions(
				JSON.parse(await fs.readFile(appConfig.eventPushSubscriptionsFile, "utf8")),
			);
		} catch {
			await this.writeLocal(appConfig.eventPushSubscriptionsFile, this.subscriptions);
		}
	}

	private async loadState(): Promise<void> {
		if (githubContentsClient.enabled) {
			try {
				const remote = await githubContentsClient.read(appConfig.eventPushStateGithubPath);
				if (remote) {
					this.state = parseState(JSON.parse(remote.content));
					this.stateSha = remote.sha;
					await this.writeLocal(appConfig.eventPushStateFile, this.state);
					return;
				}
			} catch (error) {
				console.warn("[push:event] GitHub state restore failed", error);
			}
		}
		try {
			this.state = parseState(JSON.parse(await fs.readFile(appConfig.eventPushStateFile, "utf8")));
		} catch {
			await this.writeLocal(appConfig.eventPushStateFile, this.state);
		}
	}

	private async saveSubscriptions(): Promise<void> {
		await this.enqueue(async () => {
			await this.writeLocal(appConfig.eventPushSubscriptionsFile, this.subscriptions);
			if (githubContentsClient.enabled) {
				this.subscriptionsSha = await githubContentsClient.write(
					appConfig.eventPushSubscriptionsGithubPath,
					`${JSON.stringify(this.subscriptions, null, 2)}\n`,
					"Update LINE event-start subscriptions",
					this.subscriptionsSha,
				);
			}
		});
	}

	private async saveState(): Promise<void> {
		await this.enqueue(async () => {
			await this.writeLocal(appConfig.eventPushStateFile, this.state);
			if (githubContentsClient.enabled) {
				this.stateSha = await githubContentsClient.write(
					appConfig.eventPushStateGithubPath,
					`${JSON.stringify(this.state, null, 2)}\n`,
					"Update LINE event-start notification state",
					this.stateSha,
				);
			}
		});
	}

	private async enqueue(operation: () => Promise<void>): Promise<void> {
		const current = this.saveQueue.then(operation);
		this.saveQueue = current.catch(() => {});
		await current;
	}

	private async writeLocal(filePath: string, value: unknown): Promise<void> {
		const temporary = `${filePath}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.rename(temporary, filePath);
	}
}

export const eventPushStore = new EventPushStore();
