import { appConfig } from "../config.js";

interface DeliveryTask<T> {
	operation: () => Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

export type ScheduleUpdateTestRunResult<T> =
	| { accepted: true; value: T }
	| { accepted: false };

export class ScheduleUpdateDeliveryCoordinator {
	private readonly notificationQueue: DeliveryTask<unknown>[] = [];
	private active = false;

	isBusy(): boolean {
		return this.active || this.notificationQueue.length > 0;
	}

	runNotification<T>(operation: () => Promise<T>): Promise<T> {
		return this.enqueueNotification(operation);
	}

	async tryRunTest<T>(
		operation: () => Promise<T>,
	): Promise<ScheduleUpdateTestRunResult<T>> {
		if (this.isBusy()) return { accepted: false };
		this.active = true;
		try {
			return {
				accepted: true,
				value: await operation(),
			};
		} finally {
			this.active = false;
			this.drain();
		}
	}

	private enqueueNotification<T>(operation: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.notificationQueue.push({
				operation,
				resolve: (value) => resolve(value as T),
				reject,
			});
			this.drain();
		});
	}

	private drain(): void {
		if (this.active) return;
		const task = this.notificationQueue.shift();
		if (!task) return;
		this.active = true;
		void Promise.resolve()
			.then(task.operation)
			.then(task.resolve, task.reject)
			.finally(() => {
				this.active = false;
				this.drain();
			});
	}
}

export async function waitScheduleUpdateSendInterval(): Promise<void> {
	if (appConfig.scheduleUpdateSendIntervalMs <= 0) return;
	await new Promise<void>((resolve) => {
		setTimeout(resolve, appConfig.scheduleUpdateSendIntervalMs);
	});
}

export const scheduleUpdateDeliveryCoordinator = new ScheduleUpdateDeliveryCoordinator();
