import { memberEventLogStore } from "../memberEventLog/store.js";
import type { ParsedMemberEvent } from "../memberEventLog/events.js";
import { permissionStore } from "../permissions/store.js";
import {
	handleOpenChatMemberJoin,
	handleOpenChatMemberLeave,
	type OpenChatMemberJoinEvent,
	type OpenChatMemberLeaveEvent,
} from "./ocModeration.js";
import {
	handleOpenChatJoinEventMessage,
	handleOpenChatLeaveEventMessage,
} from "./ocJoinMessage.js";
import { ocModerationSettingsStore } from "./ocModerationSettings.js";

export type OpenChatMemberSignalOrigin =
	| "square-receiver"
	| "chat-poll"
	| "system-message"
	| "replay";

export type OpenChatMemberSignal =
	| {
		type: "join";
		event: OpenChatMemberJoinEvent;
		origin: OpenChatMemberSignalOrigin;
		ignoreBefore?: number;
		suppressActions?: boolean;
	}
	| {
		type: "leave";
		event: OpenChatMemberLeaveEvent;
		origin: OpenChatMemberSignalOrigin;
		ignoreBefore?: number;
		suppressActions?: boolean;
	};

export interface OpenChatMemberSignalHandlers {
	record(signal: OpenChatMemberSignal): Promise<void>;
	track(signal: OpenChatMemberSignal, suppressActions: boolean): Promise<void>;
	notify(signal: OpenChatMemberSignal, ignoreBefore?: number): Promise<void>;
}

export type OpenChatMemberSignalResult = "processed" | "duplicate";

const SIGNAL_DEDUPE_TTL_MS = 10 * 60_000;
const SIGNAL_TRANSITION_DEDUPE_MS = 30_000;
const SIGNAL_PRUNE_INTERVAL_MS = 60_000;
const SIGNAL_DEDUPE_MAX = 10_000;

function signalAt(signal: OpenChatMemberSignal): number {
	const value = signal.type === "join"
		? signal.event.joinedAt ?? signal.event.memberCreatedAt
		: signal.event.leftAt ?? signal.event.memberCreatedAt;
	return Number.isFinite(value) && value !== undefined && value > 0 ? value : Date.now();
}

function signalKey(signal: OpenChatMemberSignal): string {
	const event = signal.event;
	return [
		signal.type,
		event.source,
		event.squareMid,
		event.squareChatMid ?? "",
		event.memberMid,
		signalAt(signal),
	].join(":");
}

function transitionKey(signal: OpenChatMemberSignal): string {
	const event = signal.event;
	return [
		event.source,
		event.squareMid,
		event.squareChatMid ?? "",
		event.memberMid,
	].join(":");
}

function memberQueueKey(signal: OpenChatMemberSignal): string {
	return `${signal.event.squareMid}:${signal.event.memberMid}`;
}

function signalIsReplayed(signal: OpenChatMemberSignal): boolean {
	if (signal.suppressActions) return true;
	return signal.ignoreBefore !== undefined && signalAt(signal) < signal.ignoreBefore;
}

function signalToParsedEvent(signal: OpenChatMemberSignal): ParsedMemberEvent {
	const event = signal.event;
	const scope = event.source === "square-member" ? "square" : "chat";
	return {
		type: signal.type,
		scope,
		at: signalAt(signal),
		chatMid: scope === "square" ? event.squareMid : event.squareChatMid ?? event.squareMid,
		scopeMid: event.squareMid,
		mid: event.memberMid,
		name: event.displayName,
	};
}

function isBotStopped(signal: OpenChatMemberSignal): boolean {
	const event = signal.event;
	return permissionStore.isBotStopped({
		kind: "square",
		chatMid: event.squareChatMid ?? event.squareMid,
		chatType: "SQUARE",
	});
}

const defaultHandlers: OpenChatMemberSignalHandlers = {
	async record(signal) {
		await memberEventLogStore.recordParsedEvents([signalToParsedEvent(signal)]);
	},
	async track(signal, suppressActions) {
		if (signal.type === "join") {
			await handleOpenChatMemberJoin(signal.event, { suppressActions });
			return;
		}
		await handleOpenChatMemberLeave(signal.event, { suppressActions });
	},
	async notify(signal, ignoreBefore) {
		const event = signal.event;
		if (event.source !== "chat-member" || !event.squareChatMid || isBotStopped(signal)) return;
		if (signal.type === "join") {
			if (!ocModerationSettingsStore.joinMessage(event.squareChatMid)) return;
			await handleOpenChatJoinEventMessage(event, { ignoreBefore });
			return;
		}
		if (!ocModerationSettingsStore.leaveMessage(event.squareChatMid)) return;
		await handleOpenChatLeaveEventMessage(event, { ignoreBefore });
	},
};

export class OpenChatMemberSignalDispatcher {
	private readonly recentSignals = new Map<string, number>();
	private readonly recentTransitions = new Map<string, { type: "join" | "leave"; at: number; receivedAt: number }>();
	private readonly memberQueues = new Map<string, Promise<void>>();
	private lastPrunedAt = 0;

	constructor(private readonly handlers: OpenChatMemberSignalHandlers = defaultHandlers) {}

	async publish(signal: OpenChatMemberSignal): Promise<OpenChatMemberSignalResult> {
		const now = Date.now();
		this.stabilizeSignalTime(signal, now);
		this.pruneRecent(now);
		const key = signalKey(signal);
		const transition = this.recentTransitions.get(transitionKey(signal));
		const repeatedTransition = transition?.type === signal.type &&
			Math.abs(transition.at - signalAt(signal)) <= SIGNAL_TRANSITION_DEDUPE_MS;
		if (this.recentSignals.has(key) || repeatedTransition) {
			console.log("[oc-member-signal] duplicate skipped", {
				type: signal.type,
				origin: signal.origin,
				squareMid: signal.event.squareMid,
				squareChatMid: signal.event.squareChatMid,
				memberMid: signal.event.memberMid,
				at: signalAt(signal),
			});
			return "duplicate";
		}
		this.recentSignals.set(key, now);
		this.recentTransitions.set(transitionKey(signal), {
			type: signal.type,
			at: signalAt(signal),
			receivedAt: now,
		});

		const queueKey = memberQueueKey(signal);
		const previous = this.memberQueues.get(queueKey) ?? Promise.resolve();
		const operation = previous
			.catch(() => {})
			.then(async () => {
				await this.process(signal);
			});
		this.memberQueues.set(queueKey, operation);
		try {
			await operation;
			return "processed";
		} finally {
			if (this.memberQueues.get(queueKey) === operation) {
				this.memberQueues.delete(queueKey);
			}
		}
	}

	private async process(signal: OpenChatMemberSignal): Promise<void> {
		const replayed = signalIsReplayed(signal);
		console.log("[oc-member-signal] received", {
			type: signal.type,
			origin: signal.origin,
			source: signal.event.source,
			squareMid: signal.event.squareMid,
			squareChatMid: signal.event.squareChatMid,
			memberMid: signal.event.memberMid,
			at: signalAt(signal),
			replayed,
		});

		// 保存失敗が自動処分を止めないよう、記録処理だけ独立して走らせる。
		void this.handlers.record(signal).catch((error) => {
			console.error("[oc-member-signal] record handler failed", {
				type: signal.type,
				origin: signal.origin,
				memberMid: signal.event.memberMid,
				error,
			});
		});

		// 即抜け追跡と挨拶送信は独立した購読処理として同時に開始する。
		const tracking = this.handlers.track(signal, replayed).catch((error) => {
			console.error("[oc-member-signal] tracking handler failed", {
				type: signal.type,
				origin: signal.origin,
				memberMid: signal.event.memberMid,
				error,
			});
		});
		const notification = replayed
			? Promise.resolve()
			: this.handlers.notify(signal, signal.ignoreBefore).catch((error) => {
				console.error("[oc-member-signal] member message handler failed", {
					type: signal.type,
					origin: signal.origin,
					memberMid: signal.event.memberMid,
					error,
				});
			});
		await Promise.all([tracking, notification]);
	}

	private pruneRecent(now: number): void {
		if (
			now - this.lastPrunedAt < SIGNAL_PRUNE_INTERVAL_MS &&
			this.recentSignals.size <= SIGNAL_DEDUPE_MAX &&
			this.recentTransitions.size <= SIGNAL_DEDUPE_MAX
		) return;
		this.lastPrunedAt = now;
		const minimum = now - SIGNAL_DEDUPE_TTL_MS;
		for (const [key, receivedAt] of this.recentSignals) {
			if (receivedAt < minimum || this.recentSignals.size > SIGNAL_DEDUPE_MAX) {
				this.recentSignals.delete(key);
			}
		}
		for (const [key, transition] of this.recentTransitions) {
			if (transition.receivedAt < minimum || this.recentTransitions.size > SIGNAL_DEDUPE_MAX) {
				this.recentTransitions.delete(key);
			}
		}
	}

	private stabilizeSignalTime(signal: OpenChatMemberSignal, fallback: number): void {
		if (signal.type === "join") {
			if (signal.event.joinedAt === undefined && signal.event.memberCreatedAt === undefined) {
				signal.event.joinedAt = fallback;
			}
			return;
		}
		if (signal.event.leftAt === undefined) signal.event.leftAt = fallback;
	}
}

export const ocMemberSignalDispatcher = new OpenChatMemberSignalDispatcher();
