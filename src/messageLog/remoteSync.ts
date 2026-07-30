import { appConfig } from "../config.js";
import { messageLogStore } from "./store.js";
import { runtimeWorkload } from "../runtime/workload.js";

function compactError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function startMessageLogRemoteSyncScheduler(signal: AbortSignal): void {
	let stopped = false;
	let syncRunning = false;
	let syncTimer: NodeJS.Timeout | undefined;

	const scheduleSync = (delayMs: number) => {
		if (stopped || signal.aborted) return;
		if (syncTimer) clearTimeout(syncTimer);
		syncTimer = setTimeout(runSync, Math.max(1_000, delayMs));
	};

	const runSync = () => {
		if (stopped || signal.aborted) return;
		if (!runtimeWorkload.canRunBackground()) {
			scheduleSync(appConfig.backgroundRetryMs);
			return;
		}
		if (syncRunning) {
			scheduleSync(appConfig.messageLogRemoteSyncBacklogMs);
			return;
		}
		syncRunning = true;
		void runtimeWorkload.runBackground("message-log-github-sync", async () => {
			if (stopped || signal.aborted) return { remoteFiles: 0, remotePending: 0, localFiles: 0 };
			return await messageLogStore.flush();
		})
			.then((result) => {
				if (result.remoteFiles > 0 || result.remotePending > 0) {
					console.log(
						`[message-log:remote-sync] uploaded=${result.remoteFiles} pending=${result.remotePending}`,
					);
				}
				scheduleSync(
					result.remotePending > 0
						? appConfig.messageLogRemoteSyncBacklogMs
						: appConfig.messageLogRemoteSyncIntervalMs,
				);
			})
			.catch((error) => {
				console.warn("[message-log:remote-sync] failed", compactError(error));
				scheduleSync(appConfig.messageLogRemoteSyncBacklogMs);
			})
			.finally(() => {
				syncRunning = false;
			});
	};

	scheduleSync(appConfig.messageLogRemoteSyncIntervalMs);
	signal.addEventListener("abort", () => {
		stopped = true;
		if (syncTimer) clearTimeout(syncTimer);
	}, { once: true });
}
