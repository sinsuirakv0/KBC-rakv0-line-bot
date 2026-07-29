import { AsyncLocalStorage } from "node:async_hooks";
import { appConfig } from "../config.js";

export type LineApiPriority = "high" | "normal";

interface QueuedLineApiTask {
	label: string;
	priority: LineApiPriority;
	operation: () => Promise<unknown>;
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

export interface LineApiQueueSnapshot {
	active?: string;
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
	private readonly highQueue: QueuedLineApiTask[] = [];
	private readonly normalQueue: QueuedLineApiTask[] = [];
	private active: string | undefined;

	withPriority<T>(priority: LineApiPriority, operation: () => Promise<T>): Promise<T> {
		return this.priorityContext.run(priority, operation);
	}

	run<T>(
		label: string,
		operation: () => Promise<T>,
		priority = this.priorityContext.getStore() ?? "normal",
	): Promise<T> {
		const pending = this.highQueue.length + this.normalQueue.length;
		const highReserve = Math.min(
			appConfig.lineApiQueueLimit - 1,
			appConfig.lineApiHighPriorityReserve,
		);
		const acceptedLimit = priority === "high"
			? appConfig.lineApiQueueLimit
			: appConfig.lineApiQueueLimit - highReserve;
		if (pending >= acceptedLimit) throw new LineApiQueueFullError(pending);
		return new Promise<T>((resolve, reject) => {
			const task: QueuedLineApiTask = {
				label,
				priority,
				operation,
				resolve: (value) => resolve(value as T),
				reject,
			};
			if (priority === "high") this.highQueue.push(task);
			else this.normalQueue.push(task);
			this.drain();
		});
	}

	snapshot(): LineApiQueueSnapshot {
		return {
			active: this.active,
			pendingHigh: this.highQueue.length,
			pendingNormal: this.normalQueue.length,
		};
	}

	private drain(): void {
		if (this.active) return;
		const task = this.highQueue.shift() ?? this.normalQueue.shift();
		if (!task) return;
		this.active = task.label;
		void task.operation()
			.then(task.resolve, task.reject)
			.finally(() => {
				const finish = () => {
					this.active = undefined;
					this.drain();
				};
				if (appConfig.lineApiSendIntervalMs <= 0) finish();
				else setTimeout(finish, appConfig.lineApiSendIntervalMs);
			});
	}
}

export const lineApiQueue = new LineApiQueue();
