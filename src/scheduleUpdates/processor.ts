import crypto from "node:crypto";

import type { Client } from "@evex/linejs";

import { appConfig } from "../config.js";
import { createSquareThreadWithRoot, sendSquareThreadText } from "../eventPush/squareThread.js";
import { permissionStore } from "../permissions/store.js";
import { lineApiNotificationScope, lineApiQueue } from "../runtime/lineApiQueue.js";
import { pushSubscriptionStore } from "../subscriptions/store.js";
import { fetchCurrentEventTsv } from "./ponos.js";
import {
	buildScheduleUpdatePreviewFromTsv,
	fetchPreviousEventTsv,
	type EventTsvTextByType,
	type EventTsvType,
	type ScheduleUpdatePreview,
} from "./preview.js";

const EVENT_TYPES = ["gatya", "sale", "item"] as const satisfies readonly EventTsvType[];
const ACTIVE_GROUP_SEC = 120;

interface ScheduleUpdateDetailRequest {
	detectedAt?: unknown;
	historyUrl: string;
}

const activeHistoryUnix = new Set<number>();
const completedHistoryUnix: Array<{ unix: number; expiresAt: number }> = [];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function historyUnixFromRequest(request: ScheduleUpdateDetailRequest): number | undefined {
	try {
		const value = Number(new URL(request.historyUrl).searchParams.get("tsv"));
		if (Number.isSafeInteger(value) && value > 0) return value;
	} catch {
		// URL以外の検知時刻を予備として使う。
	}
	if (typeof request.detectedAt !== "string" && typeof request.detectedAt !== "number") return undefined;
	const timestamp = new Date(request.detectedAt).getTime();
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : undefined;
}

function isNearbyHandled(historyUnix: number): boolean {
	const now = Date.now();
	while (completedHistoryUnix[0]?.expiresAt && completedHistoryUnix[0].expiresAt <= now) {
		completedHistoryUnix.shift();
	}
	return [...activeHistoryUnix].some((active) => Math.abs(active - historyUnix) <= ACTIVE_GROUP_SEC) ||
		completedHistoryUnix.some((completed) => Math.abs(completed.unix - historyUnix) <= ACTIVE_GROUP_SEC);
}

function rememberCompleted(historyUnix: number): void {
	completedHistoryUnix.push({
		unix: historyUnix,
		expiresAt: Date.now() + ACTIVE_GROUP_SEC * 1_000,
	});
}

function mergeTsvRounds(
	baseline: EventTsvTextByType,
	first: EventTsvTextByType,
	second: EventTsvTextByType,
): EventTsvTextByType {
	const current: EventTsvTextByType = {};
	for (const type of EVENT_TYPES) {
		const later = second[type];
		const earlier = first[type];
		if (typeof later === "string" && later !== baseline[type]) current[type] = later;
		else if (typeof earlier === "string" && earlier !== baseline[type]) current[type] = earlier;
		else if (typeof later === "string") current[type] = later;
	}
	return current;
}

function detailKey(preview: ScheduleUpdatePreview, current: EventTsvTextByType): string {
	const hash = crypto.createHash("sha256");
	for (const type of preview.sourceTypes) hash.update(`${type}\0${current[type] ?? ""}\0`);
	return `schedule-details|${hash.digest("hex").slice(0, 32)}`;
}

function detailRootText(preview: ScheduleUpdatePreview): string {
	return [
		"スケジュール更新詳細",
		`種類: ${preview.sourceTypes.join(",")}`,
		"更新内容をスレッドに送信します",
	].join("\n");
}

function detailMessages(preview: ScheduleUpdatePreview): string[] {
	if (preview.sections.length === 0) {
		return ["追加されたイベント\n\n追加は見つかりませんでした。"];
	}
	return preview.sections.map((section, index) =>
		`${index === 0 ? "追加されたイベント\n\n" : ""}${section.text}`
	);
}

async function sendTalkText(
	client: Client,
	target: { chatMid: string; encrypted: boolean },
	text: string,
): Promise<void> {
	await lineApiQueue.run(
		"schedule-update-details:talk",
		() => client.base.talk.sendMessage({ to: target.chatMid, text, e2ee: target.encrypted }),
		{
			priority: "critical",
			scope: lineApiNotificationScope("talk", target.chatMid),
		},
	);
}

async function deliverDetails(client: Client, preview: ScheduleUpdatePreview): Promise<number> {
	const rootText = detailRootText(preview);
	const messages = detailMessages(preview);
	let sent = 0;
	for (const target of pushSubscriptionStore.list()) {
		if (permissionStore.isBotStopped(target)) continue;
		try {
			if (target.kind === "square") {
				const queueOptions = {
					priority: "critical" as const,
					scope: lineApiNotificationScope("square", target.chatMid),
				};
				const thread = await createSquareThreadWithRoot(
					client,
					target.chatMid,
					rootText,
					queueOptions,
				);
				for (const message of messages) {
					await sendSquareThreadText(client, thread, message, queueOptions);
				}
			} else {
				await sendTalkText(client, target, rootText);
				for (const message of messages) await sendTalkText(client, target, message);
			}
			sent++;
		} catch (error) {
			console.error(`[schedule-update] detail delivery failed: ${target.kind}:${target.chatMid}`, error);
		}
	}
	return sent;
}

async function processDetails(
	client: Client,
	request: ScheduleUpdateDetailRequest,
	historyUnix: number,
): Promise<void> {
	const baseline = await fetchPreviousEventTsv(historyUnix, EVENT_TYPES);
	const first = await fetchCurrentEventTsv();
	let second = first;
	if (appConfig.scheduleUpdateSettleMs > 0) {
		await sleep(appConfig.scheduleUpdateSettleMs);
		try {
			second = await fetchCurrentEventTsv();
		} catch (error) {
			console.warn("[schedule-update] settled TSV fetch failed; using first fetch", error);
		}
	}
	const current = mergeTsvRounds(baseline, first, second);
	const preview = await buildScheduleUpdatePreviewFromTsv({
		historyUnix,
		current,
		previous: baseline,
	});
	if (preview.sourceTypes.length === 0) {
		console.warn("[schedule-update] no changed TSV found", { historyUnix, historyUrl: request.historyUrl });
		return;
	}

	const key = detailKey(preview, current);
	if (pushSubscriptionStore.hasNotified(key)) return;
	const sent = await deliverDetails(client, preview);
	if (sent > 0) await pushSubscriptionStore.markNotified(key);
	console.log("[schedule-update] details delivered", {
		historyUnix,
		types: preview.sourceTypes,
		sections: preview.sections.map((section) => `${section.type}:${section.count}`),
		sent,
	});
}

export function enqueueScheduleUpdateDetails(
	client: Client,
	request: ScheduleUpdateDetailRequest,
): boolean {
	const historyUnix = historyUnixFromRequest(request);
	if (!historyUnix || isNearbyHandled(historyUnix)) return false;
	activeHistoryUnix.add(historyUnix);
	void processDetails(client, request, historyUnix)
		.then(() => rememberCompleted(historyUnix))
		.catch((error) => console.error("[schedule-update] detail processing failed", error))
		.finally(() => activeHistoryUnix.delete(historyUnix));
	return true;
}
