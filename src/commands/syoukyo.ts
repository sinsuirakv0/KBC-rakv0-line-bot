import type { Client } from "@evex/linejs";
import {
	permissionDeniedText,
	permissionStore,
	targetFromDestination,
} from "../permissions/store.js";
import { lineApiQueue } from "../runtime/lineApiQueue.js";
import type { LineCommand } from "./shared.js";

type SquareRole = string | number | undefined;

interface EmergencyTarget {
	squareChatMid: string;
	squareMid: string;
	name: string;
}

interface PurgeResult {
	found: number;
	banned: number;
	protected: number;
	failed: Array<{ mid: string; error: string }>;
	stopped: boolean;
	elapsedMs: number;
}

interface HistoryMessageTarget {
	messageId: string;
	threadMid: string;
}

interface MessageCleanupResult {
	scannedEvents: number;
	foundMessages: number;
	deletedMessages: number;
	failed: Array<{ messageId: string; error: string }>;
	reachedSixMonths: boolean;
	reachedHistoryEnd: boolean;
	stopped: boolean;
	elapsedMs: number;
}

interface EmergencyJob {
	targetChatMid: string;
	sourceKey: string;
	actorMid: string;
	controller: AbortController;
	stopMessageIds: Set<string>;
}

interface FetchSquareChatEventsOptions {
	squareChatMid: string;
	syncToken?: string;
	continuationToken?: string;
	limit: number;
	direction: "FORWARD" | "BACKWARD";
	inclusive?: "ON" | "OFF";
	fetchType: "DEFAULT";
}

const MAX_SWEEPS = 3;
const WORKER_COUNT = 2;
const MESSAGE_DELETE_BATCH_SIZE = 40;
const SIX_MONTH_HISTORY_MAX_PAGES = 100_000;
const FORWARD_SYNC_MAX_PAGES = 1_000;
const activeEmergencyTargets = new Map<string, EmergencyJob>();
const emergencyStopSessions = new Map<string, EmergencyJob>();

function destinationKey(message: Parameters<LineCommand["execute"]>[0]["message"]): string {
	return `${message.destination.kind}:${message.destination.chatMid}`;
}

function registerStopMessage(job: EmergencyJob, messageId: string | undefined): void {
	if (!messageId) return;
	job.stopMessageIds.add(messageId);
	emergencyStopSessions.set(messageId, job);
}

function releaseEmergencyJob(job: EmergencyJob): void {
	if (activeEmergencyTargets.get(job.targetChatMid) === job) {
		activeEmergencyTargets.delete(job.targetChatMid);
	}
	for (const messageId of job.stopMessageIds) {
		if (emergencyStopSessions.get(messageId) === job) emergencyStopSessions.delete(messageId);
	}
}

export async function handleSyoukyoStopReply(
	messageText: string,
	message: Parameters<LineCommand["execute"]>[0]["message"],
): Promise<boolean> {
	const normalized = messageText.normalize("NFKC").trim().toLowerCase();
	if ((normalized !== "停止" && normalized !== "stop") || !message.replyToMessageId) return false;
	const job = emergencyStopSessions.get(message.replyToMessageId);
	if (!job || activeEmergencyTargets.get(job.targetChatMid) !== job) return false;
	if (job.sourceKey !== destinationKey(message)) return false;
	const currentTarget = targetFromDestination(message.destination);
	if (
		message.destination.senderMid !== job.actorMid &&
		(!currentTarget || !permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "mod"))
	) {
		return false;
	}
	job.controller.abort();
	for (const messageId of job.stopMessageIds) emergencyStopSessions.delete(messageId);
	await message.send("緊急処理の停止を受け付けました。現在の処理単位が完了次第停止します。");
	return true;
}

export function isGeneralSquareRole(role: SquareRole): boolean {
	return role === 10 || role === "MEMBER" || String(role) === "10";
}

function roleRank(role: SquareRole): number {
	if (role === 1 || role === "ADMIN" || String(role) === "1") return 3;
	if (role === 2 || role === "CO_ADMIN" || String(role) === "2") return 2;
	if (isGeneralSquareRole(role)) return 1;
	return 0;
}

function isJoinedState(state: unknown): boolean {
	return state === 1 || state === "JOINED" || String(state) === "1";
}

function isBannedState(state: unknown): boolean {
	return state === 6 || state === "BANNED" || String(state) === "6";
}

function compactError(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function parseEmergencyTargetMid(args: string[]): string | undefined {
	if (!["men", "mes"].includes(args[0]?.toLowerCase() ?? "") || args.length !== 2) return undefined;
	const raw = args[1]?.trim() ?? "";
	const value = raw.toLowerCase().startsWith("talkid:") ? raw.slice(raw.indexOf(":") + 1) : raw;
	return value.startsWith("m") ? value : undefined;
}

async function resolveEmergencyTarget(client: Client, squareChatMid: string): Promise<{
	target: EmergencyTarget;
	botRole: SquareRole;
	requiredKickRole: SquareRole;
	requiredDeleteRole: SquareRole;
}> {
	const chatResponse = await lineApiQueue.run(
		"syoukyo:resolve-chat",
		() => client.base.square.getSquareChat({ squareChatMid }),
		{ priority: "high", scope: `syoukyo:${squareChatMid}` },
	);
	const raw = chatResponse as unknown as {
		squareChat?: { squareChatMid?: unknown; squareMid?: unknown; name?: unknown };
		squareChatMember?: { squareMemberMid?: unknown };
	};
	const squareMid = typeof raw.squareChat?.squareMid === "string" ? raw.squareChat.squareMid : "";
	const selfMid = typeof raw.squareChatMember?.squareMemberMid === "string"
		? raw.squareChatMember.squareMemberMid
		: "";
	if (!squareMid || !selfMid) throw new Error("対象OCへの参加情報を取得できませんでした");

	const [selfResponse, authorityResponse] = await Promise.all([
		lineApiQueue.run(
			"syoukyo:resolve-self",
			() => client.base.square.getSquareMember({ squareMemberMid: selfMid }),
			{ priority: "high", scope: `syoukyo:self:${squareMid}` },
		),
		lineApiQueue.run(
			"syoukyo:resolve-authority",
			() => client.base.square.getSquareAuthority({ request: { squareMid } }),
			{ priority: "high", scope: `syoukyo:authority:${squareMid}` },
		),
	]);
	return {
		target: {
			squareChatMid,
			squareMid,
			name: typeof raw.squareChat?.name === "string" && raw.squareChat.name.trim()
				? raw.squareChat.name.trim()
				: "名前未取得のOC",
		},
		botRole: selfResponse.squareMember.role,
		requiredKickRole: authorityResponse.authority.removeSquareMember,
		requiredDeleteRole: authorityResponse.authority.deleteSquareChatOrPost,
	};
}

async function listGeneralMembers(
	client: Client,
	squareMid: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const mids = new Set<string>();
	const seenTokens = new Set<string>();
	let continuationToken: string | undefined;
	for (;;) {
		if (signal?.aborted) break;
		const response = await lineApiQueue.run(
			"syoukyo:list-members",
			() => client.base.square.searchSquareMembers({
				request: {
					squareMid,
					searchOption: {
						membershipState: "JOINED",
						memberRoles: ["MEMBER"],
						displayName: "",
						ableToReceiveMessage: "NONE",
						ableToReceiveFriendRequest: "NONE",
						chatMidToExcludeMembers: "",
						includingMe: false,
						excludeBlockedMembers: false,
						includingMeOnlyMatch: false,
					},
					continuationToken,
					limit: 100,
				},
			}),
			{ priority: "high", scope: `syoukyo:list:${squareMid}` },
		);
		for (const member of response.members) {
			if (isGeneralSquareRole(member.role)) mids.add(member.squareMemberMid);
		}
		const nextToken = response.continuationToken || undefined;
		if (!nextToken) break;
		if (seenTokens.has(nextToken)) throw new Error("メンバー一覧のページ情報が循環しました");
		seenTokens.add(nextToken);
		continuationToken = nextToken;
	}
	return [...mids];
}

async function banIfStillGeneral(client: Client, squareMid: string, memberMid: string): Promise<"banned" | "protected"> {
	const scope = `syoukyo:kick:${memberMid}`;
	const current = await lineApiQueue.run(
		"syoukyo:check-member",
		() => client.base.square.getSquareMember({ squareMemberMid: memberMid }),
		{ priority: "high", scope },
	);
	const member = current.squareMember;
	if (member.squareMid !== squareMid || !isGeneralSquareRole(member.role) || !isJoinedState(member.membershipState)) {
		return "protected";
	}
	const response = await lineApiQueue.run(
		"syoukyo:ban-member",
		() => client.base.square.updateSquareMember({
			request: {
				updatedAttrs: [5],
				updatedPreferenceAttrs: [],
				squareMember: {
					...member,
					membershipState: "BANNED",
				},
			},
		}),
		{ priority: "high", scope },
	);
	if (!isBannedState(response.squareMember?.membershipState)) {
		throw new Error(`再参加禁止を確認できませんでした: ${String(response.squareMember?.membershipState)}`);
	}
	return "banned";
}

async function runWorkers<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
	let index = 0;
	await Promise.all(Array.from({ length: Math.min(WORKER_COUNT, items.length) }, async () => {
		for (;;) {
			const currentIndex = index++;
			if (currentIndex >= items.length) return;
			await worker(items[currentIndex]);
		}
	}));
}

async function purgeGeneralMembers(client: Client, squareMid: string, signal: AbortSignal): Promise<PurgeResult> {
	const startedAt = Date.now();
	const attempted = new Set<string>();
	const failed: PurgeResult["failed"] = [];
	let found = 0;
	let banned = 0;
	let protectedCount = 0;

	for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
		if (signal.aborted) break;
		const members = (await listGeneralMembers(client, squareMid, signal))
			.filter((mid) => !attempted.has(mid));
		if (members.length === 0) break;
		found += members.length;
		for (const mid of members) attempted.add(mid);
		await runWorkers(members, async (mid) => {
			if (signal.aborted) return;
			try {
				const result = await banIfStillGeneral(client, squareMid, mid);
				if (result === "banned") banned++;
				else protectedCount++;
			} catch (error) {
				failed.push({ mid, error: compactError(error) });
			}
		});
	}

	return {
		found,
		banned,
		protected: protectedCount,
		failed,
		stopped: signal.aborted,
		elapsedMs: Date.now() - startedAt,
	};
}

function sixMonthsAgo(now: Date): number {
	const cutoff = new Date(now);
	cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
	return cutoff.getTime();
}

function numberTime(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") return undefined;
	const result = Number(value);
	return Number.isFinite(result) && result > 0 ? result : undefined;
}

export function messageTargetsFromEvent(
	event: unknown,
	targetChatMid: string,
	cutoffAt: number,
): HistoryMessageTarget[] {
	if (!event || typeof event !== "object") return [];
	const rawEvent = event as {
		createdTime?: unknown;
		payload?: Record<string, unknown>;
	};
	const payloads = rawEvent.payload ?? {};
	const candidates = [
		payloads.receiveMessage,
		payloads.sendMessage,
		payloads.notificationMessage,
		payloads.notificationThreadMessage,
		payloads.mutateMessage,
	];
	const results: HistoryMessageTarget[] = [];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const raw = candidate as {
			squareChatMid?: unknown;
			chatMid?: unknown;
			threadMid?: unknown;
			squareMessage?: { message?: { id?: unknown; createdTime?: unknown } };
		};
		const chatMid = typeof raw.squareChatMid === "string"
			? raw.squareChatMid
			: typeof raw.chatMid === "string" ? raw.chatMid : "";
		const messageId = typeof raw.squareMessage?.message?.id === "string"
			? raw.squareMessage.message.id
			: "";
		const createdAt = numberTime(raw.squareMessage?.message?.createdTime) ?? numberTime(rawEvent.createdTime);
		if (chatMid !== targetChatMid || !messageId || !createdAt || createdAt < cutoffAt) continue;
		results.push({
			messageId,
			threadMid: typeof raw.threadMid === "string" ? raw.threadMid : "",
		});
	}
	return results;
}

function oldestEventTime(events: unknown[]): number | undefined {
	let oldest: number | undefined;
	for (const event of events) {
		const createdAt = numberTime((event as { createdTime?: unknown })?.createdTime);
		if (createdAt !== undefined && (oldest === undefined || createdAt < oldest)) oldest = createdAt;
	}
	return oldest;
}

async function fetchHistoryPage(
	client: Client,
	options: FetchSquareChatEventsOptions,
) {
	return await lineApiQueue.run(
		"syoukyo:fetch-history",
		() => client.base.square.fetchSquareChatEvents(options as never),
		{ priority: "high", scope: `syoukyo:history:${options.squareChatMid}` },
	);
}

async function synchronizeHistoryCursor(
	client: Client,
	squareChatMid: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	let syncToken: string | undefined;
	for (let page = 0; page < FORWARD_SYNC_MAX_PAGES; page++) {
		if (signal.aborted) return undefined;
		const previousToken = syncToken;
		const response = await fetchHistoryPage(client, {
			squareChatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken || syncToken;
		if (response.events.length === 0 && syncToken) return syncToken;
		if (!syncToken || syncToken === previousToken) break;
	}
	throw new Error("履歴の現在地点まで同期できませんでした");
}

async function destroyMessageBatch(
	client: Client,
	squareChatMid: string,
	threadMid: string,
	messageIds: string[],
	failed: MessageCleanupResult["failed"],
	signal: AbortSignal,
): Promise<number> {
	if (messageIds.length === 0 || signal.aborted) return 0;
	try {
		await lineApiQueue.run(
			"syoukyo:destroy-messages",
			() => client.base.square.destroyMessages({
				request: { squareChatMid, messageIds, threadMid },
			}),
			{
				priority: "high",
				scope: `syoukyo:destroy:${squareChatMid}:${threadMid || "main"}:${messageIds[0]}`,
			},
		);
		return messageIds.length;
	} catch (error) {
		if (messageIds.length > 1) {
			const middle = Math.ceil(messageIds.length / 2);
			const [left, right] = await Promise.all([
				destroyMessageBatch(client, squareChatMid, threadMid, messageIds.slice(0, middle), failed, signal),
				destroyMessageBatch(client, squareChatMid, threadMid, messageIds.slice(middle), failed, signal),
			]);
			return left + right;
		}
		failed.push({ messageId: messageIds[0], error: compactError(error) });
		return 0;
	}
}

async function destroyMessageTargets(
	client: Client,
	squareChatMid: string,
	targets: HistoryMessageTarget[],
	failed: MessageCleanupResult["failed"],
	signal: AbortSignal,
): Promise<number> {
	const byThread = new Map<string, string[]>();
	for (const target of targets) {
		const ids = byThread.get(target.threadMid) ?? [];
		ids.push(target.messageId);
		byThread.set(target.threadMid, ids);
	}
	const batches: Array<{ threadMid: string; messageIds: string[] }> = [];
	for (const [threadMid, ids] of byThread) {
		for (let index = 0; index < ids.length; index += MESSAGE_DELETE_BATCH_SIZE) {
			batches.push({ threadMid, messageIds: ids.slice(index, index + MESSAGE_DELETE_BATCH_SIZE) });
		}
	}
	let deleted = 0;
	await runWorkers(batches, async (batch) => {
		if (signal.aborted) return;
		deleted += await destroyMessageBatch(
			client,
			squareChatMid,
			batch.threadMid,
			batch.messageIds,
			failed,
			signal,
		);
	});
	return deleted;
}

async function cleanupSquareMessages(
	client: Client,
	squareChatMid: string,
	onProgress: (
		result: Pick<MessageCleanupResult, "scannedEvents" | "foundMessages" | "deletedMessages">,
	) => Promise<void>,
	signal: AbortSignal,
): Promise<MessageCleanupResult> {
	const startedAt = Date.now();
	const cutoffAt = sixMonthsAgo(new Date());
	let syncToken = await synchronizeHistoryCursor(client, squareChatMid, signal);
	const seenMessageIds = new Set<string>();
	const seenTokens = new Set<string>();
	const failed: MessageCleanupResult["failed"] = [];
	let continuationToken: string | undefined;
	let scannedEvents = 0;
	let foundMessages = 0;
	let deletedMessages = 0;
	let reachedSixMonths = false;
	let reachedHistoryEnd = false;
	let lastProgressAt = Date.now();

	for (let page = 0; page < SIX_MONTH_HISTORY_MAX_PAGES; page++) {
		if (signal.aborted || !syncToken) break;
		const response = await fetchHistoryPage(client, {
			squareChatMid,
			syncToken,
			continuationToken,
			limit: 100,
			direction: "BACKWARD",
			inclusive: page === 0 ? "ON" : "OFF",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken || syncToken;
		const events = response.events as unknown[];
		scannedEvents += events.length;
		const pageTargets = events
			.flatMap((event) => messageTargetsFromEvent(event, squareChatMid, cutoffAt))
			.filter((target) => {
				if (seenMessageIds.has(target.messageId)) return false;
				seenMessageIds.add(target.messageId);
				return true;
			});
		foundMessages += pageTargets.length;
		deletedMessages += await destroyMessageTargets(
			client,
			squareChatMid,
			pageTargets,
			failed,
			signal,
		);
		if (signal.aborted) break;

		const oldestAt = oldestEventTime(events);
		if (oldestAt !== undefined && oldestAt < cutoffAt) {
			reachedSixMonths = true;
			break;
		}
		const nextToken = response.continuationToken || undefined;
		if (!nextToken) {
			reachedHistoryEnd = true;
			break;
		}
		if (seenTokens.has(nextToken)) throw new Error("履歴のページ情報が循環しました");
		seenTokens.add(nextToken);
		continuationToken = nextToken;

		if (Date.now() - lastProgressAt >= 30_000 || scannedEvents % 1_000 === 0) {
			await onProgress({ scannedEvents, foundMessages, deletedMessages });
			lastProgressAt = Date.now();
		}
	}

	return {
		scannedEvents,
		foundMessages,
		deletedMessages,
		failed,
		reachedSixMonths,
		reachedHistoryEnd,
		stopped: signal.aborted,
		elapsedMs: Date.now() - startedAt,
	};
}

function elapsedText(elapsedMs: number): string {
	const seconds = Math.floor(elapsedMs / 1_000);
	return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

function helpText(): string {
	return [
		"!syoukyo men <トークMID>",
		"  指定したOCの一般メンバーを一括で再参加禁止にします。",
		"!syoukyo mes <トークMID>",
		"  指定したOCの過去6か月分のメッセージを削除します。",
		"  対象OCとは別のトークから、BOTモデレーター以上が実行してください。",
	].join("\n");
}

export const syoukyoCommand: LineCommand = {
	name: "syoukyo",
	policy: { priority: "high", progress: "none" },
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help" || args.length === 0) {
			await message.send(helpText());
			return;
		}

		const targetChatMid = parseEmergencyTargetMid(args);
		if (!targetChatMid) {
			await message.send(helpText());
			return;
		}
		// 対象トーク内からの実行には一切応答しない。
		if (message.destination.chatMid === targetChatMid) return;

		const currentTarget = targetFromDestination(message.destination);
		if (!currentTarget || !permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "mod")) {
			await message.send(permissionDeniedText("mod"));
			return;
		}
		if (activeEmergencyTargets.has(targetChatMid)) {
			await message.send("この対象トークでは、すでに緊急処理が実行中です。");
			return;
		}
		const job: EmergencyJob = {
			targetChatMid,
			sourceKey: destinationKey(message),
			actorMid: message.destination.senderMid,
			controller: new AbortController(),
			stopMessageIds: new Set(),
		};
		activeEmergencyTargets.set(targetChatMid, job);

		try {
			const resolved = await resolveEmergencyTarget(message.client, targetChatMid);
			const action = args[0].toLowerCase();
			const requiredRole = action === "mes" ? resolved.requiredDeleteRole : resolved.requiredKickRole;
			if (roleRank(resolved.botRole) < roleRank(requiredRole)) {
				await message.send([
					`緊急${action === "mes" ? "メッセージ削除" : "再参加禁止"}を開始できませんでした。`,
					`対象: ${resolved.target.name}`,
					`Botに${action === "mes" ? "メッセージ削除" : "再参加禁止"}権限がありません。`,
				].join("\n"));
				return;
			}
			if (action === "mes") {
				const startMessageId = await message.send([
					"緊急メッセージ削除を開始しました。",
					`対象: ${resolved.target.name}`,
					`トークMID: ${resolved.target.squareChatMid}`,
					"Botの自動返信を含む、取得可能な過去6か月分を削除します。",
					"停止するには、このメッセージに「停止」とリプライしてください。",
				].join("\n"));
				registerStopMessage(job, startMessageId);
				const result = await cleanupSquareMessages(
					message.client,
					resolved.target.squareChatMid,
					async (progress) => {
						await message.send(
							`メッセージ削除中: 履歴${progress.scannedEvents}件確認 / ${progress.deletedMessages}/${progress.foundMessages}件削除`,
						);
					},
					job.controller.signal,
				);
				const failureLines = result.failed.slice(0, 10)
					.map((item) => `- ${item.messageId}: ${item.error}`);
				await message.send([
					result.stopped
						? "緊急メッセージ削除を停止しました。"
						: "緊急メッセージ削除が完了しました。",
					`対象: ${resolved.target.name}`,
					`履歴確認: ${result.scannedEvents}イベント`,
					`対象メッセージ: ${result.foundMessages}件`,
					`削除成功: ${result.deletedMessages}件`,
					`失敗: ${result.failed.length}件`,
					`停止地点: ${
						result.stopped
							? "停止リクエスト"
							: result.reachedSixMonths
							? "6か月前"
							: result.reachedHistoryEnd ? "取得可能な履歴の末尾" : "処理上限"
					}`,
					`所要時間: ${elapsedText(result.elapsedMs)}`,
					failureLines.length > 0 ? "\n失敗内容:\n" + failureLines.join("\n") : "",
					result.failed.length > failureLines.length
						? `ほか${result.failed.length - failureLines.length}件の失敗があります。`
						: "",
				].filter(Boolean).join("\n"));
				return;
			}

			const startMessageId = await message.send([
				"緊急再参加禁止を開始しました。",
				`対象: ${resolved.target.name}`,
				`トークMID: ${resolved.target.squareChatMid}`,
				"停止するには、このメッセージに「停止」とリプライしてください。",
			].join("\n"));
			registerStopMessage(job, startMessageId);
			const result = await purgeGeneralMembers(
				message.client,
				resolved.target.squareMid,
				job.controller.signal,
			);
			const failureLines = result.failed.slice(0, 10).map((item) => `- ${item.mid}: ${item.error}`);
			await message.send([
				result.stopped ? "緊急再参加禁止を停止しました。" : "緊急再参加禁止が完了しました。",
				`対象: ${resolved.target.name}`,
				`一般メンバー検出: ${result.found}人`,
				`再参加禁止成功: ${result.banned}人`,
				`権限変更・退出済み: ${result.protected}人`,
				`失敗: ${result.failed.length}人`,
				`所要時間: ${elapsedText(result.elapsedMs)}`,
				failureLines.length > 0 ? "\n失敗内容:\n" + failureLines.join("\n") : "",
				result.failed.length > failureLines.length
					? `ほか${result.failed.length - failureLines.length}件の失敗があります。`
					: "",
			].filter(Boolean).join("\n"));
		} catch (error) {
			console.error("[syoukyo] emergency cleanup failed", error);
			await message.send(`緊急処理に失敗しました: ${compactError(error)}`);
		} finally {
			releaseEmergencyJob(job);
		}
	},
};
