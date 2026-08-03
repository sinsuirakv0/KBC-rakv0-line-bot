import type { Client } from "@evex/linejs";
import { permissionStore } from "../permissions/store.js";
import { lineApiNotificationScope, lineApiQueue } from "../runtime/lineApiQueue.js";
import { enqueueScheduleUpdateDetails } from "../scheduleUpdates/processor.js";
import { pushSubscriptionStore } from "../subscriptions/store.js";

const EVENT_TYPES = new Set(["gatya", "sale", "item"]);
const TYPE_LABELS: Record<string, string> = {
	gatya: "ガチャ",
	sale: "セール",
	item: "アイテム",
};
const DETECTION_GROUP_SEC = 120;
const recentDetectionUnix: number[] = [];

export interface EventUpdatePayload {
	types?: unknown;
	detectedAt?: unknown;
	historyUrl?: unknown;
	phase?: unknown;
	hashes?: unknown;
	test?: unknown;
	testId?: unknown;
	summaryOnly?: unknown;
}

function normalizeTypes(value: unknown): string[] {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	return [...new Set(raw.map(String).map((item) => item.trim()).filter((item) => EVENT_TYPES.has(item)))];
}

function formatDetectedAt(value: unknown): string {
	const parsed = typeof value === "string" || typeof value === "number"
		? new Date(value)
		: new Date();
	const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
	return new Intl.DateTimeFormat("ja-JP", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(date);
}

function historyUnix(payload: EventUpdatePayload): number | undefined {
	if (typeof payload.historyUrl === "string") {
		try {
			const value = Number(new URL(payload.historyUrl).searchParams.get("tsv"));
			if (Number.isSafeInteger(value) && value > 0) return value;
		} catch {
			// 検知時刻を予備として使う。
		}
	}
	if (typeof payload.detectedAt !== "string" && typeof payload.detectedAt !== "number") return undefined;
	const timestamp = new Date(payload.detectedAt).getTime();
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : undefined;
}

function isNearbyDetection(unix: number | undefined): boolean {
	return unix !== undefined && recentDetectionUnix.some((value) =>
		Math.abs(value - unix) <= DETECTION_GROUP_SEC
	);
}

function rememberDetection(unix: number | undefined): void {
	if (unix === undefined || isNearbyDetection(unix)) return;
	recentDetectionUnix.push(unix);
	while (recentDetectionUnix.length > 20) recentDetectionUnix.shift();
}

function notificationKey(payload: EventUpdatePayload, types: string[], phase: "detected" | "updated"): string {
	if (phase === "detected") {
		return `detected|${historyUnix(payload) ?? String(payload.detectedAt ?? payload.historyUrl ?? "")}`;
	}
	const hashes = payload.hashes && typeof payload.hashes === "object"
		? JSON.stringify(payload.hashes)
		: "";
	return hashes
		? `updated|${types.join(",")}|${hashes}`
		: `updated|${types.join(",")}|${String(payload.detectedAt ?? "")}|${String(payload.historyUrl ?? "")}`;
}

async function deliverText(
	client: Client,
	text: string,
): Promise<{ sent: number; stopped: number; failures: string[] }> {
	let sent = 0;
	let stopped = 0;
	const failures: string[] = [];
	for (const target of pushSubscriptionStore.list()) {
		try {
			if (permissionStore.isBotStopped(target)) {
				stopped++;
				continue;
			}
			if (target.kind === "square") {
				await lineApiQueue.run(
					"event-update:square",
					() => client.base.square.sendMessage({ squareChatMid: target.chatMid, text }),
					{
						priority: "critical",
						scope: lineApiNotificationScope("square", target.chatMid),
					},
				);
			} else {
				await lineApiQueue.run(
					"event-update:talk",
					() => client.base.talk.sendMessage({
						to: target.chatMid,
						text,
						e2ee: target.encrypted,
					}),
					{
						priority: "critical",
						scope: lineApiNotificationScope("talk", target.chatMid),
					},
				);
			}
			sent++;
		} catch (error) {
			failures.push(`${target.kind}:${target.chatMid} ${String(error)}`);
		}
	}
	return { sent, stopped, failures };
}

export async function notifyScheduleUpdate(
	client: Client,
	payload: EventUpdatePayload,
): Promise<{ sent: number; skipped: boolean }> {
	const phase = payload.phase === "detected" ? "detected" : "updated";
	const isTest = payload.test === true;
	const types = normalizeTypes(payload.types);
	if (typeof payload.historyUrl !== "string" || !payload.historyUrl) {
		throw new Error("historyUrl is required for an event notification");
	}
	if (phase === "updated" && !isTest) return { sent: 0, skipped: true };
	if (phase === "updated" && types.length === 0) throw new Error("updated types are empty");

	const key = notificationKey(payload, types, phase);
	const detectedUnix = historyUnix(payload);
	const duplicate = !isTest && (
		pushSubscriptionStore.hasNotified(key) ||
		(phase === "detected" && isNearbyDetection(detectedUnix))
	);
	if (duplicate) {
		if (phase === "detected" && pushSubscriptionStore.list().length > 0) {
			enqueueScheduleUpdateDetails(client, {
				detectedAt: payload.detectedAt,
				historyUrl: payload.historyUrl,
			});
		}
		return { sent: 0, skipped: true };
	}

	const text = phase === "detected"
		? [
			`${isTest ? "【テスト】" : ""}スケジュール更新`,
			`検知時間: ${formatDetectedAt(payload.detectedAt)}`,
			payload.historyUrl,
		].join("\n")
		: [
			"【テスト】スケジュール更新を検知しました。",
			`更新種類: ${types.map((type) => TYPE_LABELS[type] ?? type).join("、")}`,
			`検知時間: ${formatDetectedAt(payload.detectedAt)}`,
			`履歴: ${payload.historyUrl}`,
		].join("\n");

	const { sent, stopped, failures } = await deliverText(client, text);

	if ((sent > 0 || stopped > 0) && !isTest) {
		await pushSubscriptionStore.markNotified(key);
		if (phase === "detected") rememberDetection(detectedUnix);
	}
	for (const failure of failures) console.error(`[event-update] delivery failed: ${failure}`);
	if (failures.length > 0 && sent === 0 && stopped === 0) throw new Error("all LINE notification deliveries failed");
	if (phase === "detected" && !isTest && (sent > 0 || stopped > 0)) {
		enqueueScheduleUpdateDetails(client, {
			detectedAt: payload.detectedAt,
			historyUrl: payload.historyUrl,
		});
	}
	return { sent, skipped: false };
}
