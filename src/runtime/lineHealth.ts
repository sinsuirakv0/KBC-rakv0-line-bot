export type LineHealthChannel = "talk" | "square" | "member-message";

interface ChannelHealth {
	startedAt?: number;
	lastSuccessAt?: number;
	lastEventAt?: number;
	lastHeartbeatAt?: number;
	lastErrorAt?: number;
	lastError?: string;
	consecutiveFailures: number;
}

export interface LineHealthChannelSnapshot extends ChannelHealth {
	stale: boolean;
}

export interface LineSessionEndSnapshot {
	endedAt: number;
	source: string;
	reason: string;
	durationMs: number;
}

export interface LineHealthSnapshot {
	sessionStartedAt?: number;
	sessionStarts: number;
	lastSessionEnd?: LineSessionEndSnapshot;
	talk: LineHealthChannelSnapshot;
	square: LineHealthChannelSnapshot;
	memberMessage: LineHealthChannelSnapshot;
}

const CHANNELS: LineHealthChannel[] = ["talk", "square", "member-message"];

function newChannelHealth(): ChannelHealth {
	return { consecutiveFailures: 0 };
}

function compactError(error: unknown): string {
	const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return value.replace(/\s+/g, " ").slice(0, 240);
}

class LineHealth {
	private sessionStartedAt: number | undefined;
	private sessionStarts = 0;
	private lastSessionEnd: LineSessionEndSnapshot | undefined;
	private readonly channels: Record<LineHealthChannel, ChannelHealth> = {
		talk: newChannelHealth(),
		square: newChannelHealth(),
		"member-message": newChannelHealth(),
	};

	startSession(now = Date.now()): void {
		this.sessionStartedAt = now;
		this.sessionStarts += 1;
		for (const channel of CHANNELS) {
			this.channels[channel] = {
				startedAt: now,
				lastHeartbeatAt: now,
				consecutiveFailures: 0,
			};
		}
	}

	endSession(source: string, error?: unknown, now = Date.now()): void {
		const startedAt = this.sessionStartedAt;
		this.lastSessionEnd = {
			endedAt: now,
			source,
			reason: error === undefined ? "正常終了" : compactError(error),
			durationMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
		};
		this.sessionStartedAt = undefined;
	}

	markSuccess(channel: LineHealthChannel, eventCount = 0, now = Date.now()): void {
		const state = this.channels[channel];
		state.lastSuccessAt = now;
		state.lastHeartbeatAt = now;
		state.consecutiveFailures = 0;
		state.lastError = undefined;
		if (eventCount > 0) state.lastEventAt = now;
	}

	markHeartbeat(channel: LineHealthChannel, now = Date.now(), clearFailures = false): void {
		const state = this.channels[channel];
		state.lastHeartbeatAt = now;
		if (clearFailures) {
			state.consecutiveFailures = 0;
			state.lastError = undefined;
		}
	}

	markError(channel: LineHealthChannel, error: unknown, now = Date.now()): void {
		const state = this.channels[channel];
		state.lastErrorAt = now;
		state.lastError = compactError(error);
		state.consecutiveFailures += 1;
	}

	isStale(channel: Exclude<LineHealthChannel, "member-message">, staleMs: number, now = Date.now()): boolean {
		if (!this.sessionStartedAt || staleMs <= 0) return false;
		const state = this.channels[channel];
		const lastActivityAt = Math.max(
			state.lastSuccessAt ?? 0,
			state.lastHeartbeatAt ?? 0,
			state.startedAt ?? 0,
			this.sessionStartedAt,
		);
		return now - lastActivityAt > staleMs;
	}

	snapshot(now = Date.now()): LineHealthSnapshot {
		const snapshotChannel = (channel: LineHealthChannel, staleMs?: number): LineHealthChannelSnapshot => {
			const state = this.channels[channel];
			return {
				...state,
				stale: channel === "member-message"
					? false
					: this.isStale(channel, staleMs ?? Number.POSITIVE_INFINITY, now),
			};
		};
		return {
			sessionStartedAt: this.sessionStartedAt,
			sessionStarts: this.sessionStarts,
			lastSessionEnd: this.lastSessionEnd,
			talk: snapshotChannel("talk"),
			square: snapshotChannel("square"),
			memberMessage: snapshotChannel("member-message"),
		};
	}
}

export const lineHealth = new LineHealth();
