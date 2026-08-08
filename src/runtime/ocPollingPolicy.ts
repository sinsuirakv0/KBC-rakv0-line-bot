import { appConfig } from "../config.js";

export interface OcPollingDecision {
	mode: "fixed";
	intervalMs: number;
}

/** OC専用運用では、参加・退出イベントを常に同じ間隔で監視する。 */
export function fixedOcPollingDecision(): OcPollingDecision {
	return {
		mode: "fixed",
		intervalMs: appConfig.ocMemberPollIntervalMs,
	};
}
