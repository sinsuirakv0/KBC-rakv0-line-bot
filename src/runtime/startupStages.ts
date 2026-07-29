export interface StartupTask {
	name: string;
	initialize(): Promise<void>;
}

export interface StartupStage {
	name: string;
	tasks: StartupTask[];
}

export interface StartupStagesOptions {
	concurrency?: number;
	pauseMs?: number;
	signal?: AbortSignal;
	onStage?(name: string, state: "start" | "complete"): void;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return;
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	await Promise.race([
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
		waitForAbort(signal),
	]);
}

async function runTask(task: StartupTask): Promise<void> {
	try {
		await task.initialize();
	} catch (error) {
		const wrapped = new Error(`Startup task failed: ${task.name}`, { cause: error });
		wrapped.name = "StartupTaskError";
		throw wrapped;
	}
}

export async function runStartupStages(
	stages: StartupStage[],
	options: StartupStagesOptions = {},
): Promise<void> {
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
	const pauseMs = Math.max(0, Math.floor(options.pauseMs ?? 200));
	for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
		if (options.signal?.aborted) return;
		const stage = stages[stageIndex];
		options.onStage?.(stage.name, "start");
		for (let offset = 0; offset < stage.tasks.length; offset += concurrency) {
			const batch = stage.tasks.slice(offset, offset + concurrency);
			await Promise.all(batch.map(runTask));
		}
		options.onStage?.(stage.name, "complete");
		if (stageIndex < stages.length - 1) await pause(pauseMs, options.signal);
	}
}
