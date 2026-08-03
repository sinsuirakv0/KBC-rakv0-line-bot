export interface DeferredSyncOptions {
	label: string;
	operation(): Promise<void>;
	retryMs?: number;
}

export class DeferredSync {
	private requestedRevision = 0;
	private completedRevision = 0;
	private running: Promise<void> | undefined;
	private retryTimer: NodeJS.Timeout | undefined;

	constructor(private readonly options: DeferredSyncOptions) {}

	schedule(): void {
		this.requestedRevision += 1;
		this.start();
	}

	private start(): void {
		if (this.running || this.retryTimer || this.completedRevision >= this.requestedRevision) return;
		const running = this.drain();
		this.running = running;
		void running.finally(() => {
			if (this.running === running) this.running = undefined;
			if (!this.retryTimer && this.completedRevision < this.requestedRevision) this.start();
		});
	}

	private async drain(): Promise<void> {
		while (this.completedRevision < this.requestedRevision) {
			const targetRevision = this.requestedRevision;
			try {
				await this.options.operation();
				this.completedRevision = targetRevision;
			} catch (error) {
				console.warn(`[deferred-sync] ${this.options.label} failed; retry scheduled`, error);
				this.scheduleRetry();
				return;
			}
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.start();
		}, Math.max(1_000, this.options.retryMs ?? 30_000));
		this.retryTimer.unref?.();
	}
}
