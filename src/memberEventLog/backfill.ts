import type { Client } from "@evex/linejs";
import type { ReplyableLineMessage } from "../commands/shared.js";
import { appConfig } from "../config.js";
import { getActiveHistoryJob, finishHistoryJob, tryStartHistoryJob } from "../messageLog/historyJobs.js";
import { messageLogStore } from "../messageLog/store.js";
import { extractMemberEvents, type ParsedMemberEvent } from "./events.js";
import {
	memberEventLogStore,
	type MemberEventBackfillState,
	type MemberEventRecordResult,
} from "./store.js";

interface FetchSquareChatEventsOptions {
	squareChatMid: string;
	syncToken?: string;
	continuationToken?: string;
	limit?: number;
	direction?: "FORWARD" | "BACKWARD";
	inclusive?: "NONE" | "ON" | "OFF";
	fetchType?: "DEFAULT" | "PREFETCH_BY_SERVER" | "PREFETCH_BY_CLIENT";
}

interface BackfillResult {
	scanned: number;
	saved: number;
	duplicates: number;
	pages: number;
	errors: number;
	completed: boolean;
}

const MAX_FORWARD_PAGES = 100_000;
const MAX_BACKWARD_PAGES = 100_000;
const LOCAL_CHECKPOINT_PAGES = 2;
const REMOTE_CHECKPOINT_PAGES = 5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const rest = seconds % 60;
	return [
		hours > 0 ? `${hours}時間` : "",
		minutes > 0 ? `${minutes}分` : "",
		`${rest}秒`,
	].filter(Boolean).join("");
}

function formatTime(at: number): string {
	const date = new Date(at + 9 * 60 * 60 * 1_000);
	const year = String(date.getUTCFullYear()).slice(-2);
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	return `${year}/${month}/${day} ${hours}:${minutes}`;
}

async function fetchEvents(
	client: Client,
	options: FetchSquareChatEventsOptions,
) {
	return await client.base.square.fetchSquareChatEvents(options as never);
}

async function fetchWithRetry(
	client: Client,
	options: FetchSquareChatEventsOptions,
	label: string,
	onError: (error: unknown) => void,
) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			return await fetchEvents(client, options);
		} catch (error) {
			onError(error);
			console.warn(`[member-event-log:backfill] ${label} attempt=${attempt}`, error);
			await sleep(appConfig.messageLogBackfillDelayMs * attempt);
		}
	}
	return undefined;
}

async function enrichNames(
	message: ReplyableLineMessage,
	result: ParsedMemberEvent[],
): Promise<ParsedMemberEvent[]> {
	const missing = [...new Set(result.filter((event) => !event.name).map((event) => event.mid))];
	if (missing.length === 0) return result;
	const names = await messageLogStore.getMemberNames(message.destination, missing);
	return result.map((event) => ({
		...event,
		name: event.name ?? names.get(event.mid),
	}));
}

async function recordPage(
	message: ReplyableLineMessage,
	events: unknown[],
): Promise<MemberEventRecordResult> {
	const parsed = events.flatMap((event) => extractMemberEvents(event, {
		chatMid: message.destination.chatMid,
		scopeMid: message.destination.scopeMid,
	}));
	return await memberEventLogStore.recordParsedEvents(await enrichNames(message, parsed));
}

async function persistProgress(
	message: ReplyableLineMessage,
	state: MemberEventBackfillState,
	syncRemote: boolean,
): Promise<void> {
	await memberEventLogStore.updateBackfillState(
		message.destination.chatMid,
		message.destination.scopeMid,
		state,
	);
	if (syncRemote) {
		await memberEventLogStore.flush().catch((error) => {
			console.warn("[member-event-log:backfill] checkpoint GitHub sync failed", error);
		});
	} else {
		await memberEventLogStore.checkpointLocal();
	}
}

async function backfillAll(message: ReplyableLineMessage): Promise<BackfillResult> {
	const stored = await memberEventLogStore.getBackfillState(message.destination.chatMid);
	if (stored?.phase === "complete") {
		return {
			scanned: stored.scannedEvents,
			saved: stored.savedEvents,
			duplicates: stored.scannedEvents - stored.savedEvents,
			pages: stored.pages,
			errors: 0,
			completed: true,
		};
	}
	let state: MemberEventBackfillState = stored ?? {
		phase: "prime",
		scannedEvents: 0,
		savedEvents: 0,
		pages: 0,
		updatedAt: new Date().toISOString(),
	};
	let errors = 0;
	const noteError = () => {
		errors++;
	};
	const apply = (eventsRead: number, result: MemberEventRecordResult) => {
		state.scannedEvents += eventsRead;
		state.savedEvents += result.added;
		state.pages += 1;
		state.updatedAt = new Date().toISOString();
	};
	const checkpointIfNeeded = async () => {
		const syncRemote = state.pages % REMOTE_CHECKPOINT_PAGES === 0;
		if (syncRemote || state.pages % LOCAL_CHECKPOINT_PAGES === 0) {
			await persistProgress(message, state, syncRemote);
		}
	};

	if (state.phase === "prime") {
		for (let page = 0; page < MAX_FORWARD_PAGES; page++) {
			const previousSyncToken = state.syncToken;
			const response = await fetchWithRetry(message.client, {
				squareChatMid: message.destination.chatMid,
				syncToken: state.syncToken,
				limit: 100,
				direction: "FORWARD",
				fetchType: "DEFAULT",
			}, `prime page ${page + 1}`, noteError);
			if (!response) {
				await persistProgress(message, state, true);
				return {
					scanned: state.scannedEvents,
					saved: state.savedEvents,
					duplicates: state.scannedEvents - state.savedEvents,
					pages: state.pages,
					errors,
					completed: false,
				};
			}
			state.syncToken = response.syncToken || state.syncToken;
			const events = (response.events ?? []) as unknown[];
			apply(events.length, await recordPage(message, events));
			if (
				events.length > 0 &&
				(!state.syncToken || (previousSyncToken && state.syncToken === previousSyncToken))
			) {
				errors++;
				console.warn("[member-event-log:backfill] prime sync token made no progress");
				await persistProgress(message, state, true);
				break;
			}
			if (events.length === 0) {
				state.phase = "backward";
				await persistProgress(message, state, true);
				break;
			}
			await checkpointIfNeeded();
			await sleep(appConfig.messageLogBackfillDelayMs);
		}
		if (state.phase === "prime") {
			await persistProgress(message, state, true);
			return {
				scanned: state.scannedEvents,
				saved: state.savedEvents,
				duplicates: state.scannedEvents - state.savedEvents,
				pages: state.pages,
				errors,
				completed: false,
			};
		}
	}

	if (!state.syncToken) {
		await persistProgress(message, state, true);
		return {
			scanned: state.scannedEvents,
			saved: state.savedEvents,
			duplicates: state.scannedEvents - state.savedEvents,
			pages: state.pages,
			errors,
			completed: false,
		};
	}

	for (let page = 0; page < MAX_BACKWARD_PAGES; page++) {
		const previousContinuationToken = state.continuationToken;
		const response = await fetchWithRetry(message.client, {
			squareChatMid: message.destination.chatMid,
			syncToken: state.syncToken,
			continuationToken: state.continuationToken,
			limit: 100,
			direction: "BACKWARD",
			inclusive: state.continuationToken ? "OFF" : "ON",
			fetchType: "DEFAULT",
		}, `backward page ${page + 1}`, noteError);
		if (!response) {
			await persistProgress(message, state, true);
			break;
		}
		state.syncToken = response.syncToken || state.syncToken;
		state.continuationToken = response.continuationToken || undefined;
		const events = (response.events ?? []) as unknown[];
		apply(events.length, await recordPage(message, events));
		if (
			previousContinuationToken &&
			state.continuationToken === previousContinuationToken
		) {
			errors++;
			console.warn("[member-event-log:backfill] continuation token made no progress");
			await persistProgress(message, state, true);
			break;
		}
		if (!state.continuationToken) {
			state.phase = "complete";
			state.completedAt = new Date().toISOString();
		}
		if (state.phase === "complete") await persistProgress(message, state, true);
		else await checkpointIfNeeded();
		if (state.phase === "complete") break;
		await sleep(appConfig.messageLogBackfillDelayMs);
	}

	await memberEventLogStore.flush().catch((error) => {
		console.warn("[member-event-log:backfill] final GitHub sync failed", error);
	});
	return {
		scanned: state.scannedEvents,
		saved: state.savedEvents,
		duplicates: state.scannedEvents - state.savedEvents,
		pages: state.pages,
		errors,
		completed: state.phase === "complete",
	};
}

export async function startMemberEventBackfill(message: ReplyableLineMessage): Promise<void> {
	if (message.destination.kind !== "square") {
		await message.send("!id log allはOpenChatでのみ使用できます。");
		return;
	}
	const active = getActiveHistoryJob();
	if (active) {
		await message.send([
			"現在、別の履歴取得が実行中です。",
			`実行者: ${active.type === "auto" ? "自動履歴保存" : active.requester}`,
			`経過: ${formatDuration(Date.now() - active.startedAt)}`,
			"完了後にもう一度実行してください。",
		].join("\n"));
		return;
	}
	const startedAt = Date.now();
	const requester = message.destination.senderName || message.destination.senderMid;
	const jobId = `member-event:${message.destination.chatMid}:${startedAt}`;
	if (!tryStartHistoryJob({
		id: jobId,
		key: `square:${message.destination.chatMid}`,
		requester,
		startedAt,
		type: "manual",
	})) {
		await message.send("現在、別の履歴取得が実行中です。完了後にもう一度実行してください。");
		return;
	}
	try {
		await message.send([
			"参加・退出・強制退会履歴の取得を開始しました。",
			"遡れる限界まで、バックグラウンドでゆっくり保存します。",
			"途中で停止した場合は、同じコマンドで続きから再開できます。",
		].join("\n"));
	} catch (error) {
		finishHistoryJob(jobId);
		throw error;
	}
	void backfillAll(message)
		.then(async (result) => {
			const label = `@${requester}`;
			const lines = [
				label,
				result.completed ? "メンバーイベント履歴の取得が完了しました。" : "履歴取得を途中地点で停止しました。再実行すると続きから再開します。",
				`確認したSquareイベント: ${result.scanned}`,
				`新規保存した参加・退出・強制退会: ${result.saved}`,
				`既存/対象外: ${result.duplicates}`,
				`取得ページ: ${result.pages}`,
				`途中エラー: ${result.errors}`,
				`完了時間: ${formatTime(Date.now())}`,
				`かかった時間: ${formatDuration(Date.now() - startedAt)}`,
			];
			const text = lines.join("\n");
			if (message.sendMention) {
				await message.sendMention(text, [{ start: 0, end: label.length, mid: message.destination.senderMid }]);
			} else {
				await message.send(text);
			}
		})
		.catch(async (error) => {
			console.error("[member-event-log:backfill] failed", error);
			await message.send(`メンバーイベント履歴の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
		})
		.finally(() => {
			finishHistoryJob(jobId);
		});
}
