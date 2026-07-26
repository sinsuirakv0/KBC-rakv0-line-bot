import { appConfig } from "../config.js";

type ForegroundPriority = "high" | "normal";

interface QueuedForegroundTask {
	label: string;
	priority: ForegroundPriority;
	enqueuedAt: number;
	operation: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

interface QueuedBackgroundTask {
	label: string;
	operation: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

export interface RuntimeWorkloadSnapshot {
	activeForeground: number;
	queuedForeground: number;
	maxForeground: number;
	lastForegroundAt: number;
	activeBackground?: string;
	queuedBackground: number;
	lastEventLoopLagMs: number;
}

export class ForegroundQueueFullError extends Error {
	constructor(readonly queueLength: number) {
		super("Foreground command queue is full");
		this.name = "ForegroundQueueFullError";
	}
}

class RuntimeWorkload {
	private activeForeground = 0;
	private readonly foregroundQueue: QueuedForegroundTask[] = [];
	private lastForegroundAt = 0;
	private activeBackground: string | undefined;
	private readonly backgroundQueue: QueuedBackgroundTask[] = [];
	private backgroundDrainTimer: NodeJS.Timeout | undefined;
	private lastEventLoopLagMs = 0;
	private lastHighEventLoopLagAt = 0;

	runForeground<T>(
		label: string,
		operation: () => Promise<T>,
		priority: ForegroundPriority = "normal",
	): Promise<T> {
		this.lastForegroundAt = Date.now();
		if (this.activeForeground < appConfig.commandMaxConcurrency) {
			return this.startForeground(label, operation, Date.now());
		}
		if (this.foregroundQueue.length >= appConfig.commandQueueLimit) {
			throw new ForegroundQueueFullError(this.foregroundQueue.length);
		}
		return new Promise<T>((resolve, reject) => {
			const task: QueuedForegroundTask = {
				label,
				priority,
				enqueuedAt: Date.now(),
				operation,
				resolve: (value) => resolve(value as T),
				reject,
			};
			if (priority === "high") {
				const firstNormal = this.foregroundQueue.findIndex((item) => item.priority === "normal");
				if (firstNormal >= 0) this.foregroundQueue.splice(firstNormal, 0, task);
				else this.foregroundQueue.push(task);
			} else {
				this.foregroundQueue.push(task);
			}
		});
	}

	canRunBackground(quietMs = appConfig.backgroundQuietMs, now = Date.now()): boolean {
		return this.activeForeground === 0 &&
			this.foregroundQueue.length === 0 &&
			(this.lastForegroundAt === 0 || now - this.lastForegroundAt >= quietMs) &&
			(
				this.lastHighEventLoopLagAt === 0 ||
				now - this.lastHighEventLoopLagAt >= appConfig.backgroundLagCooldownMs
			);
	}

	runBackground<T>(label: string, operation: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.backgroundQueue.push({
				label,
				operation,
				resolve: (value) => resolve(value as T),
				reject,
			});
			this.drainBackgroundQueue();
		});
	}

	observeEventLoopLag(lagMs: number, observedAt = Date.now()): void {
		this.lastEventLoopLagMs = Math.max(0, lagMs);
		if (this.lastEventLoopLagMs >= appConfig.backgroundMaxEventLoopLagMs) {
			this.lastHighEventLoopLagAt = observedAt;
		}
	}

	snapshot(): RuntimeWorkloadSnapshot {
		return {
			activeForeground: this.activeForeground,
			queuedForeground: this.foregroundQueue.length,
			maxForeground: appConfig.commandMaxConcurrency,
			lastForegroundAt: this.lastForegroundAt,
			activeBackground: this.activeBackground,
			queuedBackground: this.backgroundQueue.length,
			lastEventLoopLagMs: this.lastEventLoopLagMs,
		};
	}

	private startForeground<T>(label: string, operation: () => Promise<T>, enqueuedAt: number): Promise<T> {
		this.activeForeground += 1;
		this.lastForegroundAt = Date.now();
		const queueDelayMs = this.lastForegroundAt - enqueuedAt;
		if (queueDelayMs >= 1_000) {
			console.log(`[workload] foreground ${label} waited ${queueDelayMs}ms`);
		}
		return operation().finally(() => {
			this.activeForeground = Math.max(0, this.activeForeground - 1);
			this.lastForegroundAt = Date.now();
			this.drainForegroundQueue();
			this.scheduleBackgroundDrain();
		});
	}

	private drainForegroundQueue(): void {
		while (this.activeForeground < appConfig.commandMaxConcurrency && this.foregroundQueue.length > 0) {
			const task = this.foregroundQueue.shift();
			if (!task) return;
			void this.startForeground(task.label, task.operation, task.enqueuedAt)
				.then(task.resolve, task.reject);
		}
	}

	private drainBackgroundQueue(): void {
		if (this.activeBackground || this.backgroundQueue.length === 0) return;
		if (!this.canRunBackground()) {
			this.scheduleBackgroundDrain();
			return;
		}
		if (this.backgroundDrainTimer) {
			clearTimeout(this.backgroundDrainTimer);
			this.backgroundDrainTimer = undefined;
		}
		const task = this.backgroundQueue.shift();
		if (!task) return;
		this.activeBackground = task.label;
		const startedAt = Date.now();
		void task.operation()
			.then(task.resolve, task.reject)
			.finally(() => {
				const elapsedMs = Date.now() - startedAt;
				if (elapsedMs >= 5_000 || this.backgroundQueue.length > 0) {
					console.log(
						`[workload] background ${task.label} completed in ${elapsedMs}ms queue=${this.backgroundQueue.length}`,
					);
				}
				this.activeBackground = undefined;
				this.drainBackgroundQueue();
			});
	}

	private scheduleBackgroundDrain(): void {
		if (this.backgroundDrainTimer || this.activeBackground || this.backgroundQueue.length === 0) return;
		this.backgroundDrainTimer = setTimeout(() => {
			this.backgroundDrainTimer = undefined;
			this.drainBackgroundQueue();
		}, appConfig.backgroundRetryMs);
		this.backgroundDrainTimer.unref();
	}
}

export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export const runtimeWorkload = new RuntimeWorkload();
