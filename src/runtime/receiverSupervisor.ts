export interface ReceiverSupervisorOptions {
	name: string;
	parentSignal: AbortSignal;
	retryDelayMs: number;
	run(signal: AbortSignal): Promise<void>;
	onRestart?(detail: ReceiverRestartDetail): void;
}

export interface ReceiverRestartDetail {
	name: string;
	restartCount: number;
	requested: boolean;
	reason: unknown;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return;
	await Promise.race([
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
		waitForAbort(signal),
	]);
}

export class ReceiverSupervisor {
	private activeController: AbortController | undefined;
	private requestedReason: unknown;
	private restartCount = 0;
	private running = false;

	constructor(private readonly options: ReceiverSupervisorOptions) {}

	restart(reason: unknown): boolean {
		if (
			!this.activeController ||
			this.activeController.signal.aborted ||
			this.options.parentSignal.aborted
		) return false;
		this.requestedReason = reason;
		this.activeController.abort(reason);
		return true;
	}

	async run(): Promise<void> {
		if (this.running) throw new Error(`${this.options.name} receiver supervisor is already running`);
		this.running = true;
		try {
			while (!this.options.parentSignal.aborted) {
				const controller = new AbortController();
				const relayAbort = () => controller.abort(this.options.parentSignal.reason);
				this.options.parentSignal.addEventListener("abort", relayAbort, { once: true });
				this.activeController = controller;
				let failure: unknown;
				try {
					await this.options.run(controller.signal);
					if (!controller.signal.aborted) {
						failure = new Error(`${this.options.name} receiver stopped unexpectedly`);
					}
				} catch (error) {
					failure = error;
				} finally {
					this.options.parentSignal.removeEventListener("abort", relayAbort);
					if (this.activeController === controller) this.activeController = undefined;
				}
				if (this.options.parentSignal.aborted) break;
				const requested = this.requestedReason !== undefined;
				const reason = requested ? this.requestedReason : failure;
				this.requestedReason = undefined;
				this.restartCount += 1;
				this.options.onRestart?.({
					name: this.options.name,
					restartCount: this.restartCount,
					requested,
					reason,
				});
				await wait(requested ? 100 : this.options.retryDelayMs, this.options.parentSignal);
			}
		} finally {
			this.activeController = undefined;
			this.running = false;
		}
	}
}
