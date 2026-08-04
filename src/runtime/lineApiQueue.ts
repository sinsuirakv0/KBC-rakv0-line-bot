import { AsyncLocalStorage } from "node:async_hooks";
import { appConfig } from "../config.js";

export type LineApiPriority = "critical" | "high" | "normal";

export interface LineApiQueueRunOptions {
	priority?: LineApiPriority;
	scope?: string;
}

interface QueuedLineApiTask {
	label: string;
	priority: LineApiPriority;
	scope: string;
	sequence: number;
	operation: () => Promise<unknown>;
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

interface LineApiScopeQueue {
	critical: QueuedLineApiTask[];
	high: QueuedLineApiTask[];
	normal: QueuedLineApiTask[];
	active?: QueuedLineApiTask;
	activeStartedAt?: number;
	availableAt: number;
}

export interface LineApiQueueSnapshot {
	active?: string;
	activeCount: number;
	maxConcurrent: number;
	oldestActiveMs: number;
	pendingCritical: number;
	pendingHigh: number;
	pendingNormal: number;
}

export class LineApiQueueFullError extends Error {
	constructor(readonly pending: number) {
		super("LINE API queue is full");
		this.name = "LineApiQueueFullError";
	}
}

export class LineApiQueuePausedError extends Error {
	constructor(readonly reason: string) {
		super(`LINE API queue is paused: ${reason}`);
		this.name = "LineApiQueuePausedError";
	}
}

const priorityRank: Record<LineApiPriority, number> = {
	critical: 0,
	high: 1,
	normal: 2,
};

export function lineApiNotificationScope(kind: "square" | "talk", chatMid: string): string {
	return `notification:${kind}:${chatMid}`;
}

export class LineApiQueue {
	private readonly priorityContext = new AsyncLocalStorage<LineApiPriority>();
	private readonly scopes = new Map<string, LineApiScopeQueue>();
	private activeCount = 0;
	private sequence = 0;
	private pausedReason: string | undefined;

	withPriority<T>(priority: LineApiPriority, operation: () => Promise<T>): Promise<T> {
		return this.priorityContext.run(priority, operation);
	}

	run<T>(
		label: string,
		operation: () => Promise<T>,
		options?: LineApiPriority | LineApiQueueRunOptions,
	): Promise<T> {
		if (this.pausedReason) throw new LineApiQueuePausedError(this.pausedReason);
		const resolved = this.resolveOptions(options);
		const pending = this.pendingCount();
		const queueLimit = appConfig.lineApiQueueLimit;
		const criticalReserve = Math.min(
			queueLimit - 1,
			appConfig.lineApiCriticalPriorityReserve,
		);
		const highReserve = Math.min(
			Math.max(0, queueLimit - criticalReserve - 1),
			appConfig.lineApiHighPriorityReserve,
		);
		const acceptedLimit = resolved.priority === "critical"
			? queueLimit
			: resolved.priority === "high"
				? queueLimit - criticalReserve
				: queueLimit - criticalReserve - highReserve;
		if (pending >= acceptedLimit) throw new LineApiQueueFullError(pending);

		return new Promise<T>((resolve, reject) => {
			const task: QueuedLineApiTask = {
				label,
				priority: resolved.priority,
				scope: resolved.scope,
				sequence: this.sequence++,
				operation,
				resolve: (value) => resolve(value as T),
				reject,
			};
			const queue = this.scopeQueue(resolved.scope);
			if (task.priority === "critical") queue.critical.push(task);
			else if (task.priority === "high") queue.high.push(task);
			else queue.normal.push(task);
			this.drain();
		});
	}

	isPaused(): boolean {
		return this.pausedReason !== undefined;
	}

	pause(reason: string): void {
		const normalizedReason = reason.trim() || "session-unavailable";
		if (this.pausedReason) return;
		this.pausedReason = normalizedReason;
		let cancelled = 0;
		for (const queue of this.scopes.values()) {
			const pending = [...queue.critical, ...queue.high, ...queue.normal];
			queue.critical.length = 0;
			queue.high.length = 0;
			queue.normal.length = 0;
			for (const task of pending) {
				cancelled += 1;
				task.reject(new LineApiQueuePausedError(normalizedReason));
			}
		}
		console.warn("[line-api] queue paused", { reason: normalizedReason, cancelled });
	}

	resume(): void {
		if (!this.pausedReason) return;
		const reason = this.pausedReason;
		this.pausedReason = undefined;
		console.log("[line-api] queue resumed", { reason });
		this.cleanupScopes();
		this.drain();
	}

	snapshot(now = Date.now()): LineApiQueueSnapshot {
		const active = [...this.scopes.values()]
			.filter((queue): queue is LineApiScopeQueue & { active: QueuedLineApiTask; activeStartedAt: number } =>
				queue.active !== undefined && queue.activeStartedAt !== undefined,
			)
			.sort((left, right) => left.activeStartedAt - right.activeStartedAt);
		return {
			active: active[0]?.active.label,
			activeCount: this.activeCount,
			maxConcurrent: appConfig.lineApiMaxConcurrent,
			oldestActiveMs: active.length === 0 ? 0 : Math.max(0, now - active[0].activeStartedAt),
			pendingCritical: this.pendingCount("critical"),
			pendingHigh: this.pendingCount("high"),
			pendingNormal: this.pendingCount("normal"),
		};
	}

	private resolveOptions(options?: LineApiPriority | LineApiQueueRunOptions): Required<LineApiQueueRunOptions> {
		if (typeof options === "string") {
			return { priority: options, scope: "global" };
		}
		return {
			priority: options?.priority ?? this.priorityContext.getStore() ?? "normal",
			scope: options?.scope?.trim() || "global",
		};
	}

	private scopeQueue(scope: string): LineApiScopeQueue {
		let queue = this.scopes.get(scope);
		if (!queue) {
			queue = { critical: [], high: [], normal: [], availableAt: 0 };
			this.scopes.set(scope, queue);
		}
		return queue;
	}

	private pendingCount(priority?: LineApiPriority): number {
		let count = 0;
		for (const queue of this.scopes.values()) {
			if (!priority || priority === "critical") count += queue.critical.length;
			if (!priority || priority === "high") count += queue.high.length;
			if (!priority || priority === "normal") count += queue.normal.length;
		}
		return count;
	}

	private drain(): void {
		if (this.pausedReason) return;
		while (this.activeCount < appConfig.lineApiMaxConcurrent) {
			const selected = this.nextTask(Date.now());
			if (!selected) return;
			const criticalReserve = Math.min(
				Math.max(0, appConfig.lineApiMaxConcurrent - 1),
				appConfig.lineApiCriticalConcurrencyReserve,
			);
			const ordinaryLimit = appConfig.lineApiMaxConcurrent - criticalReserve;
			if (selected.task.priority !== "critical" && this.activeCount >= ordinaryLimit) return;
			this.dequeue(selected.queue, selected.task.priority);
			this.start(selected.queue, selected.task);
		}
	}

	private nextTask(now: number): { queue: LineApiScopeQueue; task: QueuedLineApiTask } | undefined {
		let selected: { queue: LineApiScopeQueue; task: QueuedLineApiTask } | undefined;
		for (const queue of this.scopes.values()) {
			if (queue.active || queue.availableAt > now) continue;
			const task = queue.critical[0] ?? queue.high[0] ?? queue.normal[0];
			if (!task) continue;
			if (
				!selected ||
				priorityRank[task.priority] < priorityRank[selected.task.priority] ||
				(task.priority === selected.task.priority && task.sequence < selected.task.sequence)
			) {
				selected = { queue, task };
			}
		}
		return selected;
	}

	private dequeue(queue: LineApiScopeQueue, priority: LineApiPriority): void {
		if (priority === "critical") queue.critical.shift();
		else if (priority === "high") queue.high.shift();
		else queue.normal.shift();
	}

	private start(queue: LineApiScopeQueue, task: QueuedLineApiTask): void {
		queue.active = task;
		queue.activeStartedAt = Date.now();
		this.activeCount += 1;
		let wasSlow = false;
		const slowTimer = setTimeout(() => {
			wasSlow = true;
			console.warn("[line-api] slow operation", {
				label: task.label,
				scope: task.scope,
				elapsedMs: Date.now() - (queue.activeStartedAt ?? Date.now()),
				pending: this.pendingCount(),
			});
		}, appConfig.lineApiStallWarnMs);
		slowTimer.unref?.();

		void Promise.resolve()
			.then(() => {
				if (this.pausedReason) throw new LineApiQueuePausedError(this.pausedReason);
				return task.operation();
			})
			.then(task.resolve, task.reject)
			.finally(() => {
				clearTimeout(slowTimer);
				if (wasSlow) {
					console.warn("[line-api] slow operation completed", {
						label: task.label,
						scope: task.scope,
						elapsedMs: Date.now() - (queue.activeStartedAt ?? Date.now()),
					});
				}
				queue.active = undefined;
				queue.activeStartedAt = undefined;
				this.activeCount -= 1;
				queue.availableAt = Date.now() + appConfig.lineApiSendIntervalMs;
				if (appConfig.lineApiSendIntervalMs <= 0) {
					this.cleanupScopes();
					this.drain();
					return;
				}
				const timer = setTimeout(() => {
					this.cleanupScopes();
					this.drain();
				}, appConfig.lineApiSendIntervalMs);
				timer.unref?.();
			});
	}

	private cleanupScopes(): void {
		const now = Date.now();
		for (const [scope, queue] of this.scopes) {
			if (
				!queue.active &&
				queue.critical.length === 0 &&
				queue.high.length === 0 &&
				queue.normal.length === 0 &&
				queue.availableAt <= now
			) {
				this.scopes.delete(scope);
			}
		}
	}
}

export const lineApiQueue = new LineApiQueue();
