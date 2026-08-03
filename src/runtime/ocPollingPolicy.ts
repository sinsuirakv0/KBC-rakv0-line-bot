import { appConfig } from "../config.js";

export type OcPollingMode =
	| "inactive"
	| "command-boost"
	| "weekday-eco"
	| "quiet-eco"
	| "active";

export interface OcPollingDecision {
	mode: OcPollingMode;
	intervalMs: number;
	energySaving: boolean;
	recentMessageCount: number;
}

interface SquareActivity {
	messageTimes: number[];
	lastCommandAt: number;
}

function isWeekdayEcoPeriod(now: number): boolean {
	const jst = new Date(now + 9 * 60 * 60_000);
	const day = jst.getUTCDay();
	const hour = jst.getUTCHours();
	return day >= 1 && day <= 5 && hour >= 0 && hour < 15;
}

export class OcPollingActivityTracker {
	private readonly activityBySquare = new Map<string, SquareActivity>();

	recordMessage(squareMid: string, at = Date.now()): void {
		if (!squareMid || !Number.isFinite(at) || at <= 0) return;
		const activity = this.getActivity(squareMid);
		activity.messageTimes.push(at);
		this.prune(activity, at);
	}

	recordCommand(squareMid: string, at = Date.now()): void {
		if (!squareMid || !Number.isFinite(at) || at <= 0) return;
		const activity = this.getActivity(squareMid);
		activity.lastCommandAt = Math.max(activity.lastCommandAt, at);
	}

	decision(squareMid: string, featuresEnabled: boolean, now = Date.now()): OcPollingDecision {
		const activity = this.getActivity(squareMid);
		this.prune(activity, now);
		const recentMessageCount = activity.messageTimes.length;

		if (!featuresEnabled) {
			return {
				mode: "inactive",
				intervalMs: appConfig.ocMemberPollInactiveMs,
				energySaving: true,
				recentMessageCount,
			};
		}
		if (
			activity.lastCommandAt > 0 &&
			now - activity.lastCommandAt < appConfig.ocMemberPollCommandBoostMs
		) {
			return {
				mode: "command-boost",
				intervalMs: appConfig.ocMemberPollActiveMs,
				energySaving: false,
				recentMessageCount,
			};
		}
		if (isWeekdayEcoPeriod(now)) {
			return {
				mode: "weekday-eco",
				intervalMs: appConfig.ocMemberPollEcoMs,
				energySaving: true,
				recentMessageCount,
			};
		}
		if (recentMessageCount < appConfig.ocMemberPollQuietMessageThreshold) {
			return {
				mode: "quiet-eco",
				intervalMs: appConfig.ocMemberPollEcoMs,
				energySaving: true,
				recentMessageCount,
			};
		}
		return {
			mode: "active",
			intervalMs: appConfig.ocMemberPollActiveMs,
			energySaving: false,
			recentMessageCount,
		};
	}

	reset(): void {
		this.activityBySquare.clear();
	}

	private getActivity(squareMid: string): SquareActivity {
		let activity = this.activityBySquare.get(squareMid);
		if (!activity) {
			activity = { messageTimes: [], lastCommandAt: 0 };
			this.activityBySquare.set(squareMid, activity);
		}
		return activity;
	}

	private prune(activity: SquareActivity, now: number): void {
		const cutoff = now - appConfig.ocMemberPollQuietWindowMs;
		let removeCount = 0;
		while (
			removeCount < activity.messageTimes.length &&
			activity.messageTimes[removeCount] < cutoff
		) {
			removeCount++;
		}
		if (removeCount > 0) activity.messageTimes.splice(0, removeCount);
	}
}

export const ocPollingActivity = new OcPollingActivityTracker();
