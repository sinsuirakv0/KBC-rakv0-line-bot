import { AsyncLocalStorage } from "node:async_hooks";
import { appConfig } from "../config.js";

export type LineApiPriority = "high" | "normal";

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
	pendingHigh: number;
	pendingNormal: number;
}

export class LineApiQueueFullError extends Error {
	constructor(readonly pending: number) {
		super("LINE API queue is full");
		this.name = "LineApiQueueFullError";
	}
}

class LineApiQueue {
	private readonly priorityContext = new AsyncLocalStorage<LineApiPriority>();
	private readonly scopes = new Map<string, LineApiScopeQueue>();
	private activeCount = 0;
	private sequence = 0;

	withPriority<T>(priority: LineApiPriority, operation: () => Promise<T>): Promise<T> {
		return this.priorityContext.run(priority, operation);
	}

	run<T>(
		label: string,
		operation: () => Promise<T>,
		options?: LineApiPriority | LineApiQueueRunOptions,
	): Promise<T> {
		const resolved = this.resolveOptions(options);
		const pending = this.pendingCount();
		const highReserve = Math.min(
			appConfig.lineApiQueueLimit - 1,
			appConfig.lineApiHighPriorityReserve,
		);
		const acceptedLimit = resolved.priority === "high"
			? appConfig.lineApiQueueLimit
			: appConfig.lineApiQueueLimit - highReserve;
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
			if (task.priority === "high") queue.high.push(task);
			else queue.normal.push(task);
			this.drain();
		});
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
			queue = { high: [], normal: [], availableAt: 0 };
			this.scopes.set(scope, queue);
		}
		return queue;
	}

	private pendingCount(priority?: LineApiPriority): number {
		let count = 0;
		for (const queue of this.scopes.values()) {
			if (!priority || priority === "high") count += queue.high.length;
			if (!priority || priority === "normal") count += queue.normal.length;
		}
		return count;
	}

	private drain(): void {
		while (this.activeCount < appConfig.lineApiMaxConcurrent) {
			const selected = this.nextTask(Date.now());
			if (!selected) return;
			this.start(selected.queue, selected.task);
		}
	}

	private nextTask(now: number): { queue: LineApiScopeQueue; task: QueuedLineApiTask } | undefined {
		let selected: { queue: LineApiScopeQueue; task: QueuedLineApiTask } | undefined;
		for (const queue of this.scopes.values()) {
			if (queue.active || queue.availableAt > now) continue;
			const task = queue.high[0] ?? queue.normal[0];
			if (!task) continue;
			if (
				!selected ||
				(task.priority === "high" && selected.task.priority !== "high") ||
				(task.priority === selected.task.priority && task.sequence < selected.task.sequence)
			) {
				selected = { queue, task };
			}
		}
		if (!selected) return undefined;
		if (selected.task.priority === "high") selected.queue.high.shift();
		else selected.queue.normal.shift();
		return selected;
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
			.then(task.operation)
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
			if (!queue.active && queue.high.length === 0 && queue.normal.length === 0 && queue.availableAt <= now) {
				this.scopes.delete(scope);
			}
		}
	}
}

export const lineApiQueue = new LineApiQueue();
