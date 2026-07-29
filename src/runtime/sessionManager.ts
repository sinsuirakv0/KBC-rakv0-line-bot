import {
	type LoginRetryDecision,
	LoginRetryPolicy,
} from "./lineErrorPolicy.js";

export interface SessionManagerOptions<T> {
	signal: AbortSignal;
	retryPolicy: LoginRetryPolicy;
	stableResetMs: number;
	create(): Promise<T>;
	run(value: T, signal: AbortSignal): Promise<void>;
	onActiveChange?(value: T | null): void;
	beforeRetry?(): Promise<void>;
	onRetry?(decision: LoginRetryDecision): void;
	now?(): number;
	wait?(ms: number, signal: AbortSignal): Promise<void>;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return;
	await Promise.race([
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
		waitForAbort(signal),
	]);
}

export class SessionManager<T> {
	constructor(private readonly options: SessionManagerOptions<T>) {}

	async run(): Promise<void> {
		const now = this.options.now ?? Date.now;
		const wait = this.options.wait ?? defaultWait;
		while (!this.options.signal.aborted) {
			let connectedAt: number | undefined;
			let active = false;
			try {
				const value = await this.options.create();
				if (this.options.signal.aborted) break;
				connectedAt = now();
				active = true;
				this.options.onActiveChange?.(value);
				await this.options.run(value, this.options.signal);
				if (!this.options.signal.aborted) {
					throw new Error("LINE session ended unexpectedly");
				}
			} catch (error) {
				if (active) {
					active = false;
					this.options.onActiveChange?.(null);
				}
				if (this.options.signal.aborted) break;
				if (connectedAt !== undefined && now() - connectedAt >= this.options.stableResetMs) {
					this.options.retryPolicy.reset();
				}
				const decision = this.options.retryPolicy.next(error);
				this.options.onRetry?.(decision);
				await this.options.beforeRetry?.().catch(() => undefined);
				await wait(decision.delayMs, this.options.signal);
			} finally {
				if (active) this.options.onActiveChange?.(null);
			}
		}
		this.options.onActiveChange?.(null);
	}
}
