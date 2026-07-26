import { appConfig } from "../config.js";
import { runtimeWorkload } from "../runtime/workload.js";
import { memberEventLogStore } from "./store.js";

function compactError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function startMemberEventLogRemoteSyncScheduler(signal: AbortSignal): void {
	let running = false;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;

	const schedule = (delayMs: number) => {
		if (stopped || signal.aborted) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(run, Math.max(1_000, delayMs));
	};

	const run = () => {
		if (stopped || signal.aborted) return;
		if (!runtimeWorkload.canRunBackground()) {
			schedule(appConfig.backgroundRetryMs);
			return;
		}
		if (running) {
			schedule(appConfig.memberEventLogRemoteSyncBacklogMs);
			return;
		}
		running = true;
		void runtimeWorkload.runBackground("member-event-log-github-sync", async () =>
			await memberEventLogStore.flush()
		)
			.then((result) => {
				if (result.remoteFiles > 0 || result.remotePending > 0) {
					console.log(
						`[member-event-log:remote-sync] uploaded=${result.remoteFiles} pending=${result.remotePending}`,
					);
				}
				schedule(
					result.remotePending > 0
						? appConfig.memberEventLogRemoteSyncBacklogMs
						: appConfig.memberEventLogRemoteSyncIntervalMs,
				);
			})
			.catch((error) => {
				console.warn("[member-event-log:remote-sync] failed", compactError(error));
				schedule(appConfig.memberEventLogRemoteSyncBacklogMs);
			})
			.finally(() => {
				running = false;
			});
	};

	schedule(appConfig.memberEventLogRemoteSyncIntervalMs);
	signal.addEventListener("abort", () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	}, { once: true });
}
