import type { Client } from "@evex/linejs";
import { permissionStore } from "../permissions/store.js";
import { pushSubscriptionStore } from "../subscriptions/store.js";

const EVENT_TYPES = new Set(["gatya", "sale", "item"]);
const TYPE_LABELS: Record<string, string> = {
	gatya: "ガチャ",
	sale: "セール",
	item: "アイテム",
};

export interface EventUpdatePayload {
	types?: unknown;
	detectedAt?: unknown;
	historyUrl?: unknown;
	phase?: unknown;
	hashes?: unknown;
	test?: unknown;
	testId?: unknown;
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

function notificationKey(payload: EventUpdatePayload, types: string[]): string {
	const hashes = payload.hashes && typeof payload.hashes === "object"
		? JSON.stringify(payload.hashes)
		: "";
	return hashes
		? `updated|${types.join(",")}|${hashes}`
		: `updated|${types.join(",")}|${String(payload.detectedAt ?? "")}|${String(payload.historyUrl ?? "")}`;
}

export async function notifyScheduleUpdate(
	client: Client,
	payload: EventUpdatePayload,
): Promise<{ sent: number; skipped: boolean }> {
	// The detected phase has no finalized history URL. Notify only after files are saved.
	if (payload.phase !== "updated") return { sent: 0, skipped: true };

	const types = normalizeTypes(payload.types);
	if (types.length === 0) throw new Error("updated types are empty");
	if (typeof payload.historyUrl !== "string" || !payload.historyUrl) {
		throw new Error("historyUrl is required for an updated notification");
	}

	const isTest = payload.test === true;
	const key = notificationKey(payload, types);
	if (!isTest && pushSubscriptionStore.hasNotified(key)) return { sent: 0, skipped: true };

	const text = [
		`${isTest ? "【テスト】" : ""}スケジュール更新を検知しました。`,
		`更新種類: ${types.map((type) => TYPE_LABELS[type] ?? type).join("、")}`,
		`検知時間: ${formatDetectedAt(payload.detectedAt)}`,
		`履歴: ${payload.historyUrl}`,
	].join("\n");

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
				await client.base.square.sendMessage({ squareChatMid: target.chatMid, text });
			} else {
				await client.base.talk.sendMessage({
					to: target.chatMid,
					text,
					e2ee: target.encrypted,
				});
			}
			sent++;
		} catch (error) {
			failures.push(`${target.kind}:${target.chatMid} ${String(error)}`);
		}
	}

	if ((sent > 0 || stopped > 0) && !isTest) await pushSubscriptionStore.markNotified(key);
	for (const failure of failures) console.error(`[event-update] delivery failed: ${failure}`);
	if (failures.length > 0 && sent === 0 && stopped === 0) throw new Error("all LINE notification deliveries failed");
	return { sent, skipped: false };
}
