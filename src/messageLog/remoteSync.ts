import { appConfig } from "../config.js";
import { messageLogStore } from "./store.js";

function compactError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function startMessageLogRemoteSyncScheduler(signal: AbortSignal): void {
	let stopped = false;
	let syncRunning = false;
	let syncTimer: NodeJS.Timeout | undefined;
	let reconcileTimer: NodeJS.Timeout | undefined;

	const scheduleSync = (delayMs: number) => {
		if (stopped || signal.aborted) return;
		if (syncTimer) clearTimeout(syncTimer);
		syncTimer = setTimeout(runSync, Math.max(1_000, delayMs));
	};

	const runSync = () => {
		if (stopped || signal.aborted) return;
		if (syncRunning) {
			scheduleSync(appConfig.messageLogRemoteSyncBacklogMs);
			return;
		}
		syncRunning = true;
		void messageLogStore.flush()
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

	if (appConfig.messageLogRemoteReconcileEnabled) {
		reconcileTimer = setTimeout(() => {
			if (stopped || signal.aborted) return;
			void messageLogStore.reconcileRemoteIndex()
				.then((result) => {
					console.log(
						`[message-log:reconcile] remote=${result.remoteFiles} chats=${result.discoveredChats} parts=${result.discoveredParts}`,
					);
					scheduleSync(1_000);
				})
				.catch((error) => {
					console.warn("[message-log:reconcile] failed", compactError(error));
				});
		}, Math.max(1_000, appConfig.messageLogRemoteReconcileDelayMs));
	}

	scheduleSync(appConfig.messageLogRemoteSyncIntervalMs);
	signal.addEventListener("abort", () => {
		stopped = true;
		if (syncTimer) clearTimeout(syncTimer);
		if (reconcileTimer) clearTimeout(reconcileTimer);
	}, { once: true });
}
