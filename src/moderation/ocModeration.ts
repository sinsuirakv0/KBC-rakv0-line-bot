import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import type { ReplyableLineMessage } from "../commands/shared.js";
import { ocKickHistoryStore } from "./ocKickHistory.js";
import { ocMemberActivityStore, type OcLeaveDecisionInfo, type OcMemberActivity } from "./ocMemberActivity.js";
import {
	ocModerationCasesStore,
	type OcModerationCaseStatus,
	type OcModerationCaseType,
} from "./ocModerationCases.js";
import { permissionStore, targetFromDestination, type PermissionTarget } from "../permissions/store.js";
import { ocModerationSettingsStore } from "./ocModerationSettings.js";

type SquareRole = string | number | undefined;

export interface OpenChatModerationMessage {
	client: Client;
	squareChatMid: string;
	squareMid: string;
	senderMid: string;
	messageId: string;
	text?: string;
	contentType?: string | number;
	contentMetadata?: Record<string, string>;
	createdAt?: number;
}

export interface OpenChatPostModerationEvent {
	client: Client;
	squareMid: string;
	notificationPostType?: string | number;
	text?: string;
	actionUri?: string;
}

export interface OpenChatNoteStatusModerationEvent {
	client: Client;
	squareMid: string;
}

export interface OpenChatMemberJoinEvent {
	client: Client;
	squareMid: string;
	squareChatMid?: string;
	memberMid: string;
	displayName?: string;
	joinedAt?: number;
	source: "square-member" | "chat-member";
}

export interface OpenChatMemberLeaveEvent {
	client: Client;
	squareMid: string;
	squareChatMid?: string;
	memberMid: string;
	displayName?: string;
	leftAt?: number;
	clearAllChats?: boolean;
	source: "square-member" | "chat-member";
}

interface SquareMemberSummary {
	role: SquareRole;
	displayName?: string;
}

interface SquareMessageRef {
	squareChatMid: string;
	messageId: string;
}

interface MediaHistoryItem extends SquareMessageRef {
	timestamp: number;
	groupId?: string;
	groupSeq?: number;
}

interface MediaBurstDecision {
	shouldDelete: boolean;
	shouldWarn: boolean;
	reason: "group-total" | "window";
	targets: MediaHistoryItem[];
}

interface NotePostCandidate {
	postId: string;
	text: string;
}

const LINE_ME_URL_PATTERN = /(?:https?:\/\/|www\.)?\bline\.me(?:[/?#:]|\b)|https?:\/\/\S*line\.me\S*/i;
const LINK_DELETE_NOTICE = [
	"このOCではトークでの宣伝が許可されていません。",
	"ノートの宣伝用ノートにお願いします。",
].join("\n");
const MEDIA_BURST_WINDOW_MS = positiveNumber(appConfig.ocMediaBurstWindowMs, 30_000, 1_000);
const MEDIA_BURST_LIMIT = positiveNumber(appConfig.ocMediaBurstLimit, 7, 1);
const DANGER_WORD_WINDOW_MS = 2 * 60_000;
const LEFT_SOON_AUTO_BAN_MS = 5 * 60_000;
const LEFT_SOON_REVIEW_MS = 30 * 60_000;
const COHORT_JOIN_WINDOW_MS = 2 * 60_000;
const COHORT_MIN_MEMBERS = 3;
const COHORT_WATCH_MS = 30 * 60_000;
const ROLE_CACHE_MS = 5 * 60_000;
const POST_NOTIFICATION_SKIP_TYPES = new Set<string>([
	"3",
	"4",
	"5",
	"6",
	"POST_LIKE",
	"POST_COMMENT",
	"POST_COMMENT_MENTION",
	"POST_COMMENT_LIKE",
]);

const ROLE_ORDER = new Map<string, number>([
	["ADMIN", 3],
	["1", 3],
	["CO_ADMIN", 2],
	["2", 2],
	["MEMBER", 1],
	["10", 1],
]);

const memberCache = new Map<string, { summary: SquareMemberSummary; expiresAt: number }>();
const mediaBurstHistory = new Map<string, MediaHistoryItem[]>();
const mediaGroupWarnings = new Map<string, number>();
const mediaWindowWarnings = new Map<string, number>();
const handledMessageIds = new Map<string, number>();
const handledPostIds = new Map<string, number>();
const noteScanRequests = new Map<string, Promise<boolean>>();
const noteScanLastStartedAt = new Map<string, number>();
const loggedMediaTypes = new Set<string>();
const loggedCohorts = new Set<string>();

function positiveNumber(value: number, fallback: number, minimum: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.floor(value));
}

function roleRank(role: SquareRole): number {
	return ROLE_ORDER.get(String(role ?? "")) ?? 0;
}

function isSquareMemberMid(mid: string): boolean {
	return mid.startsWith("p");
}

function isSquareBotStopped(squareChatMid: string | undefined): boolean {
	const target = {
		kind: "square" as const,
		chatMid: squareChatMid ?? "__unknown_square_chat__",
		chatType: "SQUARE" as const,
	};
	const status = permissionStore.botStopStatus(target);
	return status.allStopped || (squareChatMid !== undefined && status.targetStopped);
}

function isImageOrVideo(contentType: string | number | undefined): boolean {
	return contentType === 1 ||
		contentType === 2 ||
		contentType === 21 ||
		contentType === "IMAGE" ||
		contentType === "VIDEO" ||
		contentType === "EXTIMAGE";
}

function containsLineMeUrl(text: string | undefined): boolean {
	if (!text) return false;
	return LINE_ME_URL_PATTERN.test(text);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteTimestamp(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? value : Date.now();
}

function isoFromTimestamp(value: number | undefined): string {
	return new Date(finiteTimestamp(value)).toISOString();
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "不明";
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}秒`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

function displayNameText(name: string | undefined): string {
	return cleanDisplayName(name) ?? "(名前なし)";
}

function compactError(error: unknown): string {
	if (!error || typeof error !== "object") return String(error);
	const raw = error as { name?: string; message?: string; code?: string | number; status?: string | number; reason?: string };
	return raw.message || raw.reason || raw.name || String(raw.code ?? raw.status ?? "不明なエラー");
}

function dangerWord(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const normalized = text.normalize("NFKC");
	const match = normalized.match(/チート|代行/u);
	return match?.[0];
}

function containsUrlLike(text: string | undefined): boolean {
	if (!text) return false;
	return /https?:\/\/|www\.|line\.me|discord\.gg|openchat|オプチャ|招待/u.test(text.normalize("NFKC"));
}

function mediaBurstKey(message: OpenChatModerationMessage): string {
	return `${message.squareMid}:${message.senderMid}`;
}

function messageRefKey(ref: SquareMessageRef): string {
	return `${ref.squareChatMid}:${ref.messageId}`;
}

function wasHandled(message: OpenChatModerationMessage): boolean {
	return handledMessageIds.has(messageRefKey(message));
}

function rememberHandled(ref: SquareMessageRef): void {
	const now = Date.now();
	handledMessageIds.set(messageRefKey(ref), now);
	if (handledMessageIds.size < 5_000) return;
	const minimum = now - 10 * 60_000;
	for (const [key, handledAt] of handledMessageIds) {
		if (handledAt < minimum) handledMessageIds.delete(key);
	}
}

function postKey(squareMid: string, postId: string): string {
	return `${squareMid}:${postId}`;
}

function wasPostHandled(squareMid: string, postId: string): boolean {
	return handledPostIds.has(postKey(squareMid, postId));
}

function rememberHandledPost(squareMid: string, postId: string): void {
	const now = Date.now();
	handledPostIds.set(postKey(squareMid, postId), now);
	if (handledPostIds.size < 2_000) return;
	const minimum = now - 30 * 60_000;
	for (const [key, handledAt] of handledPostIds) {
		if (handledAt < minimum) handledPostIds.delete(key);
	}
}

function numericMetadata(metadata: Record<string, string> | undefined, key: string): number | undefined {
	const raw = metadata?.[key];
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function mediaGroupId(message: OpenChatModerationMessage): string | undefined {
	const value = message.contentMetadata?.GID;
	return value && value.trim() ? value : undefined;
}

function mediaGroupTotal(message: OpenChatModerationMessage): number | undefined {
	return numericMetadata(message.contentMetadata, "GTOTAL");
}

function mediaGroupSeq(message: OpenChatModerationMessage): number | undefined {
	return numericMetadata(message.contentMetadata, "GSEQ");
}

function mediaHistoryItem(message: OpenChatModerationMessage): MediaHistoryItem {
	return {
		squareChatMid: message.squareChatMid,
		messageId: message.messageId,
		timestamp: finiteTimestamp(message.createdAt),
		groupId: mediaGroupId(message),
		groupSeq: mediaGroupSeq(message),
	};
}

function mediaWarningKey(message: OpenChatModerationMessage, groupId: string): string {
	return `${message.squareMid}:${message.senderMid}:${groupId}`;
}

function rememberMediaGroupWarning(message: OpenChatModerationMessage, groupId: string): boolean {
	const key = mediaWarningKey(message, groupId);
	const warned = mediaGroupWarnings.has(key);
	mediaGroupWarnings.set(key, Date.now());
	if (mediaGroupWarnings.size >= 1_000) {
		const minimum = Date.now() - MEDIA_BURST_WINDOW_MS;
		for (const [itemKey, warnedAt] of mediaGroupWarnings) {
			if (warnedAt < minimum) mediaGroupWarnings.delete(itemKey);
		}
	}
	return !warned;
}

function rememberMediaWindowWarning(message: OpenChatModerationMessage): boolean {
	const key = mediaBurstKey(message);
	const warnedAt = mediaWindowWarnings.get(key);
	const now = Date.now();
	mediaWindowWarnings.set(key, now);
	if (mediaWindowWarnings.size >= 1_000) {
		const minimum = now - MEDIA_BURST_WINDOW_MS;
		for (const [itemKey, warnedAtValue] of mediaWindowWarnings) {
			if (warnedAtValue < minimum) mediaWindowWarnings.delete(itemKey);
		}
	}
	return warnedAt === undefined || warnedAt < now - MEDIA_BURST_WINDOW_MS;
}

function mediaOverflowTargets(items: MediaHistoryItem[]): MediaHistoryItem[] {
	return [...items]
		.sort((a, b) => a.timestamp - b.timestamp)
		.slice(Math.max(0, MEDIA_BURST_LIMIT - 1));
}

function mediaGroupOverflowTargets(items: MediaHistoryItem[]): MediaHistoryItem[] {
	if (items.some((item) => item.groupSeq !== undefined)) {
		return items.filter((item) => (item.groupSeq ?? 0) >= MEDIA_BURST_LIMIT);
	}
	return mediaOverflowTargets(items);
}

function mediaBurstDecision(message: OpenChatModerationMessage): MediaBurstDecision {
	const timestamp = finiteTimestamp(message.createdAt);
	const minimum = timestamp - MEDIA_BURST_WINDOW_MS;
	const key = mediaBurstKey(message);
	const current = mediaHistoryItem(message);
	const recent = (mediaBurstHistory.get(key) ?? [])
		.filter((item) => item.timestamp >= minimum);
	if (!recent.some((item) => messageRefKey(item) === messageRefKey(current))) {
		recent.push(current);
	}
	mediaBurstHistory.set(key, recent);
	pruneMediaBurstHistory(timestamp);

	const groupId = current.groupId;
	const groupTotal = mediaGroupTotal(message);
	if (groupId && groupTotal !== undefined && groupTotal >= MEDIA_BURST_LIMIT) {
		const targets = mediaGroupOverflowTargets(recent.filter((item) => item.groupId === groupId));
		if (targets.length === 0) {
			return {
				shouldDelete: false,
				shouldWarn: false,
				reason: "group-total",
				targets: [],
			};
		}
		return {
			shouldDelete: true,
			shouldWarn: rememberMediaGroupWarning(message, groupId),
			reason: "group-total",
			targets,
		};
	}

	if (recent.length >= MEDIA_BURST_LIMIT) {
		return {
			shouldDelete: true,
			shouldWarn: rememberMediaWindowWarning(message),
			reason: "window",
			targets: mediaOverflowTargets(recent),
		};
	}

	return {
		shouldDelete: false,
		shouldWarn: false,
		reason: "window",
		targets: [],
	};
}

function pruneMediaBurstHistory(now: number): void {
	if (mediaBurstHistory.size < 1_000) return;
	const minimum = now - MEDIA_BURST_WINDOW_MS;
	for (const [key, items] of mediaBurstHistory) {
		const recent = items.filter((item) => item.timestamp >= minimum);
		if (recent.length === 0) mediaBurstHistory.delete(key);
		else mediaBurstHistory.set(key, recent);
	}
}

function parsePostId(actionUri: string | undefined): string | undefined {
	if (!actionUri) return undefined;
	for (const pattern of [
		/[?&#](?:postId|postID|contentId|contentID)=([^&#]+)/,
		/(?:^|[/=])(?:post|content)(?:Id)?[:/=]([^/?&#]+)/i,
	]) {
		const value = stringValue(actionUri.match(pattern)?.[1]);
		if (value) return decodeURIComponent(value);
	}
	try {
		const url = new URL(actionUri);
		for (const key of ["postId", "postID", "contentId", "contentID", "id"]) {
			const value = stringValue(url.searchParams.get(key));
			if (value) return value;
		}
	} catch {
		// line:// などURLとして扱えない形式は正規表現だけで解析する。
	}
	return undefined;
}

function isPostNotificationCandidate(type: string | number | undefined): boolean {
	if (type === undefined) return true;
	return !POST_NOTIFICATION_SKIP_TYPES.has(String(type));
}

function isCommentLikeOrReactionKey(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.includes("comment") || lower.includes("like") || lower.includes("reaction");
}

function isPostTextKey(key: string | undefined): boolean {
	if (!key) return false;
	const lower = key.toLowerCase();
	return lower === "text" ||
		lower === "body" ||
		lower === "content" ||
		lower === "contents" ||
		lower === "description" ||
		lower === "title";
}

function collectPostTexts(value: unknown, depth = 0, keyHint?: string): string[] {
	if (depth > 5 || value === null || value === undefined) return [];
	if (typeof value === "string") return isPostTextKey(keyHint) ? [value] : [];
	if (typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap((item) => collectPostTexts(item, depth + 1, keyHint));

	const raw = value as Record<string, unknown>;
	const lines: string[] = [];
	for (const [key, item] of Object.entries(raw)) {
		if (isCommentLikeOrReactionKey(key)) continue;
		lines.push(...collectPostTexts(item, depth + 1, key));
	}
	return lines;
}

function postIdFromObject(value: unknown, depth = 0): string | undefined {
	if (depth > 5 || value === null || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = postIdFromObject(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	for (const key of ["postId", "postID", "contentId", "contentID"]) {
		const found = stringValue(raw[key]);
		if (found) return found;
	}
	for (const [key, item] of Object.entries(raw)) {
		if (isCommentLikeOrReactionKey(key)) continue;
		const found = postIdFromObject(item, depth + 1);
		if (found) return found;
	}
	return undefined;
}

function looksLikePostObject(value: Record<string, unknown>): boolean {
	return value.postInfo !== undefined ||
		value.contents !== undefined ||
		value.content !== undefined ||
		value.post !== undefined;
}

function collectPostCandidates(value: unknown, depth = 0): NotePostCandidate[] {
	if (depth > 6 || value === null || value === undefined || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap((item) => collectPostCandidates(item, depth + 1));

	const raw = value as Record<string, unknown>;
	const candidates: NotePostCandidate[] = [];
	const postId = postIdFromObject(raw);
	const text = collectPostTexts(raw).join("\n").trim();
	if (postId && text && looksLikePostObject(raw)) candidates.push({ postId, text });

	for (const [key, item] of Object.entries(raw)) {
		if (isCommentLikeOrReactionKey(key)) continue;
		candidates.push(...collectPostCandidates(item, depth + 1));
	}

	const unique = new Map<string, NotePostCandidate>();
	for (const candidate of candidates) {
		if (!unique.has(candidate.postId) || candidate.text.length > (unique.get(candidate.postId)?.text.length ?? 0)) {
			unique.set(candidate.postId, candidate);
		}
	}
	return [...unique.values()];
}

async function squareNoteApi<T>(
	client: Client,
	path: string,
	method: "GET" | "POST" = "GET",
): Promise<{ code: number; message?: string; result: T | null }> {
	return await client.voom.call<T>("SQUARE_NOTE", {
		routing: "SQUARE_NOTE",
		path,
		method,
	});
}

async function fetchPostText(event: OpenChatPostModerationEvent, postId: string): Promise<string | undefined> {
	const params = new URLSearchParams({
		homeId: event.squareMid,
		postId,
	});
	try {
		const response = await squareNoteApi(event.client, `/api/v57/post/get.json?${params}`);
		const texts = collectPostTexts(response.result);
		const joined = texts.join("\n").trim();
		console.log("[oc-moderation] square note get", {
			squareMid: event.squareMid,
			postId,
			code: response.code,
			textFound: joined.length > 0,
		});
		return joined || undefined;
	} catch (error) {
		console.warn("[oc-moderation] failed to fetch square note post", {
			squareMid: event.squareMid,
			postId,
			error,
		});
		return undefined;
	}
}

async function deleteSquareNotePost(event: OpenChatPostModerationEvent, postId: string): Promise<void> {
	rememberHandledPost(event.squareMid, postId);
	const params = new URLSearchParams({
		homeId: event.squareMid,
		postId,
	});
	try {
		const response = await squareNoteApi(event.client, `/api/v57/post/delete.json?${params}`, "POST");
		if (response.code !== 0) {
			console.warn("[oc-moderation] square note delete returned non-zero", {
				squareMid: event.squareMid,
				postId,
				response,
			});
		} else {
			console.log("[oc-moderation] square note deleted", {
				squareMid: event.squareMid,
				postId,
			});
		}
	} catch (error) {
		console.warn("[oc-moderation] square note delete failed", {
			squareMid: event.squareMid,
			postId,
			error,
		});
	}
}

async function listSquareNotePostCandidates(event: OpenChatNoteStatusModerationEvent): Promise<NotePostCandidate[]> {
	const params = new URLSearchParams({
		homeId: event.squareMid,
		sourceType: "TALKROOM",
		likeLimit: "0",
		commentLimit: "0",
	});
	const response = await squareNoteApi(event.client, `/api/v57/post/list.json?${params}`);
	if (response.code !== 0) {
		console.warn("[oc-moderation] square note list returned non-zero", {
			squareMid: event.squareMid,
			response,
		});
		return [];
	}
	const candidates = collectPostCandidates(response.result);
	console.log("[oc-moderation] square note scan result", {
		squareMid: event.squareMid,
		candidateCount: candidates.length,
	});
	return candidates;
}

async function scanSquareNotePosts(event: OpenChatNoteStatusModerationEvent): Promise<boolean> {
	const candidates = await listSquareNotePostCandidates(event);
	let deleted = false;
	for (const candidate of candidates) {
		if (wasPostHandled(event.squareMid, candidate.postId)) continue;
		if (!containsLineMeUrl(candidate.text)) continue;
		await deleteSquareNotePost(event, candidate.postId);
		deleted = true;
	}
	return deleted;
}

function cleanDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.replace(/\s+/g, " ").trim();
	if (!trimmed || /^p[0-9a-f]{8,}$/i.test(trimmed)) return undefined;
	return trimmed.slice(0, 40);
}

async function getSquareMemberSummary(client: Client, senderMid: string): Promise<SquareMemberSummary> {
	const cached = memberCache.get(senderMid);
	if (cached && cached.expiresAt > Date.now()) return cached.summary;
	const response = await client.base.square.getSquareMember({ squareMemberMid: senderMid });
	const summary = {
		role: response.squareMember.role,
		displayName: cleanDisplayName(response.squareMember.displayName),
	};
	memberCache.set(senderMid, { summary, expiresAt: Date.now() + ROLE_CACHE_MS });
	return summary;
}

async function isPrivilegedSender(message: OpenChatModerationMessage): Promise<boolean> {
	const target: PermissionTarget = {
		chatMid: message.squareMid,
		chatType: "SQUARE",
	};
	if (permissionStore.hasAtLeast(target, message.senderMid, "mod")) return true;
	try {
		return roleRank((await getSquareMemberSummary(message.client, message.senderMid)).role) >= roleRank("CO_ADMIN");
	} catch (error) {
		// 権限確認に失敗した場合は、管理者を誤削除しないため対象外にする。
		console.warn(`[oc-moderation] failed to resolve role for ${message.senderMid}`, error);
		return true;
	}
}

async function deleteSquareMessageRef(
	client: Client,
	ref: SquareMessageRef,
	reason: string,
): Promise<boolean> {
	if (handledMessageIds.has(messageRefKey(ref))) return true;
	rememberHandled(ref);
	try {
		const result = await client.base.square.destroyMessage({
			squareChatMid: ref.squareChatMid,
			messageId: ref.messageId,
		});
		console.log("[oc-moderation] message deleted", {
			reason,
			method: "destroyMessage",
			squareChatMid: ref.squareChatMid,
			messageId: ref.messageId,
			result,
		});
		return true;
	} catch (destroyError) {
		try {
			const result = await client.base.square.unsendMessage({
				squareChatMid: ref.squareChatMid,
				messageId: ref.messageId,
			});
			console.log("[oc-moderation] message deleted", {
				reason,
				method: "unsendMessage",
				squareChatMid: ref.squareChatMid,
				messageId: ref.messageId,
				result,
			});
			return true;
		} catch (unsendError) {
			console.warn("[oc-moderation] message deletion failed", {
				reason,
				squareChatMid: ref.squareChatMid,
				messageId: ref.messageId,
				destroyError,
				unsendError,
			});
			return false;
		}
	}
}

async function deleteSquareMessage(message: OpenChatModerationMessage, reason: string): Promise<boolean> {
	return await deleteSquareMessageRef(message.client, message, reason);
}

function mentionMetadata(start: number, end: number, mid: string): Record<string, string> {
	return {
		MENTION: JSON.stringify({
			MENTIONEES: [{ S: String(start), E: String(end), M: mid }],
		}),
	};
}

async function mentionPrefix(message: OpenChatModerationMessage): Promise<string> {
	try {
		const summary = await getSquareMemberSummary(message.client, message.senderMid);
		return `@${summary.displayName ?? "該当者"}`;
	} catch {
		return "@該当者";
	}
}

async function sendMentionNotice(message: OpenChatModerationMessage, notice: string): Promise<void> {
	const prefix = await mentionPrefix(message);
	const text = `${prefix}\n${notice}`;
	try {
		await message.client.base.square.sendMessage({
			squareChatMid: message.squareChatMid,
			text,
			contentMetadata: mentionMetadata(0, prefix.length, message.senderMid),
		});
	} catch (error) {
		console.warn("[oc-moderation] notice send failed", error);
	}
}

async function sendPlainNotice(message: OpenChatModerationMessage, notice: string): Promise<void> {
	try {
		await message.client.base.square.sendMessage({
			squareChatMid: message.squareChatMid,
			text: notice,
		});
	} catch (error) {
		console.warn("[oc-moderation] notice send failed", error);
	}
}

function mediaBurstDeleteNotice(): string {
	return [
		`${MEDIA_BURST_LIMIT}枚以上画像(動画)を連投した為、一部画像を削除しました。`,
		`ラグ軽減の為、${MEDIA_BURST_LIMIT}枚以上送信する場合はスレッドにお願いします。`,
	].join("\n");
}

function squareSendMessageId(value: unknown): string | undefined {
	const result = value as {
		createdSquareMessage?: { message?: { id?: string } };
		squareMessage?: { message?: { id?: string } };
		message?: { id?: string };
		id?: string;
	};
	return result.createdSquareMessage?.message?.id ??
		result.squareMessage?.message?.id ??
		result.message?.id ??
		result.id;
}

async function sendModRoomLog(
	client: Client,
	squareMid: string,
	text: string,
	caseInfo?: {
		type: OcModerationCaseType;
		status: OcModerationCaseStatus;
		targetMid?: string;
		targetName?: string;
		reason?: string;
		payload?: Record<string, unknown>;
	},
): Promise<void> {
	const settings = ocModerationSettingsStore.snapshot(squareMid);
	if (!settings.modRoomChatMid) {
		console.warn("[oc-moderation] mod room not configured", { squareMid, text });
		return;
	}
	let caseId: string | undefined;
	if (caseInfo) {
		caseId = ocModerationCasesStore.record({
			type: caseInfo.type,
			status: caseInfo.status,
			squareMid,
			modRoomChatMid: settings.modRoomChatMid,
			targetMid: caseInfo.targetMid,
			targetName: caseInfo.targetName,
			reason: caseInfo.reason,
			payload: caseInfo.payload,
		}).id;
	}
	try {
		const sent = await client.base.square.sendMessage({
			squareChatMid: settings.modRoomChatMid,
			text,
		});
		const messageId = squareSendMessageId(sent);
		if (caseId && messageId) {
			ocModerationCasesStore.attachMessage(caseId, settings.modRoomChatMid, messageId);
			await ocModerationCasesStore.flush();
		}
	} catch (error) {
		console.warn("[oc-moderation] mod room log send failed", {
			squareMid,
			modRoomChatMid: settings.modRoomChatMid,
			error,
		});
	}
}

async function banFromSquare(
	client: Client,
	squareMid: string,
	targetMid: string,
	targetName: string | undefined,
	reason: string,
	actorMid = "bot:auto",
): Promise<{ ok: boolean; error?: string }> {
	try {
		const response = await client.base.square.deleteOtherFromSquare(targetMid);
		const kickedName = cleanDisplayName(response.squareMember.displayName) ?? targetName ?? targetMid;
		ocKickHistoryStore.record({
			squareMid,
			chatMid: squareMid,
			targetMid,
			targetName: kickedName,
			actorMid,
			actorName: "bot",
			reason,
			result: "success",
		});
		await ocKickHistoryStore.flush();
		return { ok: true };
	} catch (error) {
		const summary = compactError(error);
		ocKickHistoryStore.record({
			squareMid,
			chatMid: squareMid,
			targetMid,
			targetName: targetName ?? targetMid,
			actorMid,
			actorName: "bot",
			reason,
			result: "failed",
			error: summary,
		});
		await ocKickHistoryStore.flush();
		return { ok: false, error: summary };
	}
}

async function deleteAndNotify(message: OpenChatModerationMessage, notice: string, shouldWarn: boolean): Promise<void> {
	await deleteSquareMessage(message, "moderation");
	if (shouldWarn) await sendMentionNotice(message, notice);
}

async function deleteMediaBurstMessages(
	message: OpenChatModerationMessage,
	decision: MediaBurstDecision,
): Promise<void> {
	for (const target of decision.targets) {
		await deleteSquareMessageRef(message.client, target, `media-${decision.reason}`);
	}
	if (decision.shouldWarn) await sendPlainNotice(message, mediaBurstDeleteNotice());
	console.log("[oc-moderation] media burst deleted", {
		reason: decision.reason,
		targetCount: decision.targets.length,
		contentType: message.contentType,
		metadata: message.contentMetadata,
	});
}

function logMediaModerationCandidate(message: OpenChatModerationMessage): void {
	if (!message.contentType && !message.contentMetadata) return;
	const key = `${String(message.contentType ?? "none")}:${Object.keys(message.contentMetadata ?? {}).sort().join(",")}`;
	if (loggedMediaTypes.has(key)) return;
	loggedMediaTypes.add(key);
	if (loggedMediaTypes.size > 100) loggedMediaTypes.clear();
	console.log("[oc-moderation] media candidate", {
		contentType: message.contentType,
		metadataKeys: Object.keys(message.contentMetadata ?? {}).sort(),
	});
}

function firstJoinElapsedMs(activity: OcMemberActivity, at: number): number | undefined {
	if (!activity.firstJoinAt || activity.totalJoinCount !== 1) return undefined;
	const joinedAt = new Date(activity.firstJoinAt).getTime();
	if (!Number.isFinite(joinedAt) || at < joinedAt) return undefined;
	return at - joinedAt;
}

function memberLine(name: string | undefined, mid: string): string {
	return `${displayNameText(name)} (${mid})`;
}

async function sendDangerWordMainNotice(
	message: OpenChatModerationMessage,
	word: string,
	banSucceeded: boolean,
): Promise<void> {
	const text = banSucceeded
		? [
			"スパムフィルターにより自動的に強制退会しました。",
			"",
			`対象者は参加直後に「${word}」を含むメッセージを送信したため、`,
			"宣伝・不正行為勧誘の可能性が高いと判定しました。",
			"",
			"誤検知の可能性もありますが、今回は安全のため自動処分しています。",
			"必要であれば副官がログを確認してください。",
		].join("\n")
		: [
			"スパムフィルターが参加直後の危険語を検出しました。",
			"",
			`対象者は参加直後に「${word}」を含むメッセージを送信しました。`,
			"メッセージ削除は試行しましたが、強制退会に失敗しました。",
			"副官はログを確認してください。",
		].join("\n");
	try {
		await message.client.base.square.sendMessage({
			squareChatMid: message.squareChatMid,
			text,
		});
	} catch (error) {
		console.warn("[oc-moderation] danger word main notice failed", error);
	}
}

async function handleDangerWordAutoKick(
	message: OpenChatModerationMessage,
	activity: OcMemberActivity,
): Promise<boolean> {
	const word = dangerWord(message.text);
	if (!word) return false;
	const elapsedMs = firstJoinElapsedMs(activity, finiteTimestamp(message.createdAt));
	if (elapsedMs === undefined || elapsedMs > DANGER_WORD_WINDOW_MS) return false;

	const targetName = activity.displayName ?? (await getSquareMemberSummary(message.client, message.senderMid).catch(() => undefined))?.displayName;
	await deleteSquareMessage(message, "danger-word");
	const banResult = await banFromSquare(
		message.client,
		message.squareMid,
		message.senderMid,
		targetName,
		`初参加直後の危険語: ${word}`,
	);
	await sendDangerWordMainNotice(message, word, banResult.ok);

	await sendModRoomLog(
		message.client,
		message.squareMid,
		[
			"【自動処分】初参加直後の危険語",
			"",
			`対象: ${memberLine(targetName, message.senderMid)}`,
			`参加から: ${formatDuration(elapsedMs)}`,
			`検出語: ${word}`,
			`本文: ${message.text?.replace(/\s+/g, " ").trim().slice(0, 300) ?? "(本文なし)"}`,
			`処分: ${banResult.ok ? "メッセージ削除 + 強制退会 + 再参加禁止" : "メッセージ削除 + 強制退会失敗"}`,
			banResult.error ? `エラー: ${banResult.error}` : "",
			"",
			"理由:",
			"参加直後に危険語を含むメッセージを送信したため、",
			"宣伝・不正行為勧誘の可能性が高いと判定しました。",
			"",
			"誤検知の場合は、このログに「解除」と返信してください。",
		].filter(Boolean).join("\n"),
		{
			type: "danger_word_auto_kick",
			status: banResult.ok ? "auto_banned" : "ban_failed",
			targetMid: message.senderMid,
			targetName,
			reason: `danger-word:${word}`,
			payload: {
				word,
				text: message.text,
				elapsedMs,
				error: banResult.error,
			},
		},
	);
	return true;
}

async function handleCohortSuspiciousMessage(
	message: OpenChatModerationMessage,
	activity: OcMemberActivity,
): Promise<void> {
	const watch = ocMemberActivityStore.cohortWatch(message.squareMid, message.senderMid);
	if (!watch) return;
	const word = dangerWord(message.text);
	const reason = word ? `危険語:${word}` : containsUrlLike(message.text) ? "URL/誘導文らしき内容" : undefined;
	if (!reason) return;
	if (!ocMemberActivityStore.rememberCohortReason(message.squareMid, message.senderMid, reason)) return;
	await sendModRoomLog(
		message.client,
		message.squareMid,
		[
			"【監視ログ】一斉参加グループ内の不審行動",
			"",
			`対象: ${memberLine(activity.displayName, message.senderMid)}`,
			`検出内容: ${reason}`,
			`本文: ${message.text?.replace(/\s+/g, " ").trim().slice(0, 300) ?? "(本文なし)"}`,
			"処分: 未実行",
			"",
			"一斉参加グループ内で不審な行動を検出しました。",
			"必要に応じて副官が確認してください。",
		].join("\n"),
		{
			type: "cohort_suspicious",
			status: "open",
			targetMid: message.senderMid,
			targetName: activity.displayName,
			reason,
			payload: {
				cohortId: watch.cohortId,
				text: message.text,
			},
		},
	);
}

async function maybeStartJoinCohortWatch(event: OpenChatMemberJoinEvent): Promise<void> {
	const settings = ocModerationSettingsStore.snapshot(event.squareMid);
	if (!settings.joinCohortWatchEnabled) return;
	const now = finiteTimestamp(event.joinedAt);
	const recent = ocMemberActivityStore.recentFirstJoins(event.squareMid, now - COHORT_JOIN_WINDOW_MS);
	if (recent.length < COHORT_MIN_MEMBERS) return;
	const bucket = Math.floor(now / COHORT_JOIN_WINDOW_MS);
	const cohortKey = `${event.squareMid}:${bucket}`;
	if (loggedCohorts.has(cohortKey)) return;
	loggedCohorts.add(cohortKey);
	const cohortId = `${bucket.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const watchUntil = new Date(now + COHORT_WATCH_MS).toISOString();
	ocMemberActivityStore.markCohort(event.squareMid, recent.map((item) => item.memberMid), cohortId, watchUntil);
	await ocMemberActivityStore.flush();
	await sendModRoomLog(
		event.client,
		event.squareMid,
		[
			"【監視開始】短時間の一斉参加",
			"",
			`期間: ${formatDuration(COHORT_JOIN_WINDOW_MS)}`,
			`人数: ${recent.length}人`,
			"対象:",
			...recent.map((activity) => `- ${memberLine(activity.displayName, activity.memberMid)}`),
			"",
			"対応:",
			"このグループは一定時間、URL・危険語・連投・短時間退会を強めに監視します。",
			"この通知だけでは処分しません。",
		].join("\n"),
		{
			type: "cohort_watch",
			status: "open",
			reason: "short-time-join-cohort",
			payload: {
				cohortId,
				memberMids: recent.map((activity) => activity.memberMid),
				watchUntil,
			},
		},
	);
}

function leftSoonMode(info: OcLeaveDecisionInfo): "auto" | "review" | "log" | "none" {
	if (info.stayMs === undefined) return "none";
	if (info.remainingChatMids.length > 0) return info.stayMs <= LEFT_SOON_REVIEW_MS ? "log" : "none";
	if (!info.isFirstJoin) return info.stayMs <= LEFT_SOON_REVIEW_MS ? "log" : "none";
	if (info.stayMs <= LEFT_SOON_AUTO_BAN_MS) return "auto";
	if (info.stayMs <= LEFT_SOON_REVIEW_MS) return "review";
	return "none";
}

async function handleLeftSoonDecision(event: OpenChatMemberLeaveEvent, info: OcLeaveDecisionInfo): Promise<void> {
	const settings = ocModerationSettingsStore.snapshot(event.squareMid);
	if (!settings.leftSoonMonitoringEnabled) return;
	const mode = leftSoonMode(info);
	if (mode === "none") return;

	const targetName = info.activity.displayName ?? event.displayName;
	if (mode === "log") {
		const hasRemainingChats = info.remainingChatMids.length > 0;
		await sendModRoomLog(
			event.client,
			event.squareMid,
			[
				hasRemainingChats
					? "【監視ログ】参加後30分以内の退会（サブトーク残存）"
					: "【監視ログ】再参加者の短時間退会",
				"",
				`対象: ${memberLine(targetName, event.memberMid)}`,
				`滞在: ${formatDuration(info.stayMs)}`,
				`発言数: ${info.messageCount}`,
				`サブトーク残存: ${hasRemainingChats ? "あり" : "なし"}`,
				"処分: 未実行",
				"",
				hasRemainingChats
					? "サブトークに残っているため、OC全体からの退会とは扱わず、自動再参加禁止は行いませんでした。"
					: "初参加ではないため、自動再参加禁止や確認待ち処分は行いませんでした。",
			].join("\n"),
			{
				type: "left_soon_log",
				status: "open",
				targetMid: event.memberMid,
				targetName,
				reason: "left-soon-but-chat-remains",
				payload: {
					stayMs: info.stayMs,
					messageCount: info.messageCount,
					remainingChatMids: info.remainingChatMids,
				},
			},
		);
		return;
	}

	if (mode === "review") {
		await sendModRoomLog(
			event.client,
			event.squareMid,
			[
				"【確認待ち】参加後30分以内の退会",
				"",
				`対象: ${memberLine(targetName, event.memberMid)}`,
				`滞在: ${formatDuration(info.stayMs)}`,
				`発言数: ${info.messageCount}`,
				"サブトーク残存: なし",
				"処分: 未実行",
				"",
				"このログに「再参加禁止」と返信すると、対象を再参加禁止にします。",
				"誤入室と思われる場合は「無視」と返信してください。",
			].join("\n"),
			{
				type: "left_soon_pending_ban",
				status: "pending_ban",
				targetMid: event.memberMid,
				targetName,
				reason: "left-soon-review",
				payload: {
					stayMs: info.stayMs,
					messageCount: info.messageCount,
				},
			},
		);
		return;
	}

	const banResult = await banFromSquare(
		event.client,
		event.squareMid,
		event.memberMid,
		targetName,
		"即抜け: 参加後5分以内の退会",
	);
	await sendModRoomLog(
		event.client,
		event.squareMid,
		[
			"【自動処分】参加後5分以内の退会",
			"",
			`対象: ${memberLine(targetName, event.memberMid)}`,
			`滞在: ${formatDuration(info.stayMs)}`,
			`発言数: ${info.messageCount}`,
			"サブトーク残存: なし",
			`処分: ${banResult.ok ? "再参加禁止" : "再参加禁止失敗"}`,
			banResult.error ? `エラー: ${banResult.error}` : "",
			"",
			"理由:",
			"参加後5分以内にOC全体から退会し、サブトークにも残っていなかったため、",
			"即抜け荒らし対策として自動的に再参加禁止にしました。",
			"",
			"誤入室だった可能性がある場合は、このログに「解除」と返信してください。",
		].filter(Boolean).join("\n"),
		{
			type: "left_soon_auto_ban",
			status: banResult.ok ? "auto_banned" : "ban_failed",
			targetMid: event.memberMid,
			targetName,
			reason: "left-soon-auto-ban",
			payload: {
				stayMs: info.stayMs,
				messageCount: info.messageCount,
				error: banResult.error,
			},
		},
	);
}

export async function handleOpenChatModeration(message: OpenChatModerationMessage): Promise<boolean> {
	if (wasHandled(message)) return true;
	const settings = ocModerationSettingsStore.snapshot(message.squareMid);
	if (
		!settings.linkDeleteEnabled &&
		!settings.mediaBurstDeleteEnabled &&
		!settings.dangerWordAutoKickEnabled &&
		!settings.joinCohortWatchEnabled
	) return false;

	// LINE OCのAuto-replyなど、Square member MIDではない送信元は対象外。
	if (!isSquareMemberMid(message.senderMid)) return false;
	if (await isPrivilegedSender(message)) return false;

	let senderName: string | undefined;
	try {
		senderName = (await getSquareMemberSummary(message.client, message.senderMid)).displayName;
	} catch {
		senderName = undefined;
	}
	const activity = ocMemberActivityStore.recordMessage({
		squareMid: message.squareMid,
		squareChatMid: message.squareChatMid,
		memberMid: message.senderMid,
		displayName: senderName,
		text: message.text,
		at: message.createdAt,
	});

	if (settings.joinCohortWatchEnabled) await handleCohortSuspiciousMessage(message, activity);
	if (settings.dangerWordAutoKickEnabled && await handleDangerWordAutoKick(message, activity)) return true;

	if (settings.linkDeleteEnabled && containsLineMeUrl(message.text)) {
		const result = ocModerationSettingsStore.recordLinkViolation(
			message.squareMid,
			message.senderMid,
			message.senderMid,
		);
		await deleteAndNotify(message, LINK_DELETE_NOTICE, result.shouldWarn);
		return true;
	}

	if (settings.linkDeleteEnabled && ocModerationSettingsStore.isLinkDeletionLocked(message.squareMid, message.senderMid)) {
		await deleteSquareMessage(message, "locked-url-offender");
		return true;
	}

	if (settings.mediaBurstDeleteEnabled) logMediaModerationCandidate(message);
	if (settings.mediaBurstDeleteEnabled && isImageOrVideo(message.contentType)) {
		const decision = mediaBurstDecision(message);
		if (decision.shouldDelete) {
			await deleteMediaBurstMessages(message, decision);
			return true;
		}
	}

	return false;
}

export async function handleOpenChatPostModeration(event: OpenChatPostModerationEvent): Promise<boolean> {
	const settings = ocModerationSettingsStore.snapshot(event.squareMid);
	if (!settings.linkDeleteEnabled) return false;
	if (!isPostNotificationCandidate(event.notificationPostType)) return false;

	const postId = parsePostId(event.actionUri);
	if (!postId) {
		console.warn("[oc-moderation] square note postId not found", {
			squareMid: event.squareMid,
			notificationPostType: event.notificationPostType,
			actionUri: event.actionUri,
		});
		return false;
	}
	if (wasPostHandled(event.squareMid, postId)) return true;

	const text = [event.text, await fetchPostText(event, postId)]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n");
	if (!containsLineMeUrl(text)) return false;

	await deleteSquareNotePost(event, postId);
	return true;
}

export async function handleOpenChatNoteStatusModeration(
	event: OpenChatNoteStatusModerationEvent,
): Promise<boolean> {
	const settings = ocModerationSettingsStore.snapshot(event.squareMid);
	if (!settings.linkDeleteEnabled) return false;

	const running = noteScanRequests.get(event.squareMid);
	if (running) return await running;

	const now = Date.now();
	const lastStartedAt = noteScanLastStartedAt.get(event.squareMid) ?? 0;
	if (now - lastStartedAt < 3_000) return false;
	noteScanLastStartedAt.set(event.squareMid, now);

	const request = scanSquareNotePosts(event)
		.catch((error) => {
			console.warn("[oc-moderation] square note scan failed", {
				squareMid: event.squareMid,
				error,
			});
			return false;
		})
		.finally(() => {
			noteScanRequests.delete(event.squareMid);
		});
	noteScanRequests.set(event.squareMid, request);
	return await request;
}

export async function handleOpenChatMemberJoin(event: OpenChatMemberJoinEvent): Promise<void> {
	if (!isSquareMemberMid(event.memberMid)) return;
	if (isSquareBotStopped(event.squareChatMid)) return;
	if (event.source === "square-member") {
		ocMemberActivityStore.recordSquareJoin({
			squareMid: event.squareMid,
			squareChatMid: event.squareChatMid,
			memberMid: event.memberMid,
			displayName: event.displayName,
			at: event.joinedAt,
		});
		await maybeStartJoinCohortWatch(event);
		return;
	}
	ocMemberActivityStore.recordChatJoin({
		squareMid: event.squareMid,
		squareChatMid: event.squareChatMid,
		memberMid: event.memberMid,
		displayName: event.displayName,
		at: event.joinedAt,
	});
}

export async function handleOpenChatMemberLeave(event: OpenChatMemberLeaveEvent): Promise<void> {
	if (!isSquareMemberMid(event.memberMid)) return;
	if (isSquareBotStopped(event.squareChatMid)) return;
	if (event.source === "chat-member") {
		ocMemberActivityStore.recordChatLeave({
			squareMid: event.squareMid,
			squareChatMid: event.squareChatMid,
			memberMid: event.memberMid,
			displayName: event.displayName,
			at: event.leftAt,
			clearAllChats: false,
		});
		return;
	}
	const info = ocMemberActivityStore.recordSquareLeave({
		squareMid: event.squareMid,
		squareChatMid: event.squareChatMid,
		memberMid: event.memberMid,
		displayName: event.displayName,
		at: event.leftAt,
		clearAllChats: event.clearAllChats,
	});
	await handleLeftSoonDecision(event, info);
}

async function canHandleModerationCaseReply(message: ReplyableLineMessage): Promise<boolean> {
	const currentTarget = targetFromDestination(message.destination);
	if (currentTarget && permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) return true;
	if (message.destination.kind !== "square") return false;
	try {
		const member = await message.client.base.square.getSquareMember({
			squareMemberMid: message.destination.senderMid,
		});
		return roleRank(member.squareMember.role) >= roleRank("CO_ADMIN");
	} catch (error) {
		console.warn(`[oc-moderation] failed to resolve case reply actor role for ${message.destination.senderMid}`, error);
		return false;
	}
}

function moderationCaseReplyAction(text: string): "ban" | "ignore" | "unban" | undefined {
	const normalized = text.normalize("NFKC").toLowerCase().trim();
	if (/^(?:再参加禁止|ban|処分|キック)$/.test(normalized)) return "ban";
	if (/^(?:無視|ignore|対応不要|不要)$/.test(normalized)) return "ignore";
	if (/^(?:解除|unban|再参加禁止解除)$/.test(normalized)) return "unban";
	return undefined;
}

export async function handleOpenChatModerationCaseReply(
	messageText: string,
	message: ReplyableLineMessage,
): Promise<boolean> {
	if (message.destination.kind !== "square" || !message.replyToMessageId) return false;
	const moderationCase = ocModerationCasesStore.findByModRoomMessage(
		message.replyToMessageId,
		message.destination.scopeMid,
	);
	if (!moderationCase || moderationCase.modRoomChatMid !== message.destination.chatMid) return false;
	if (!await canHandleModerationCaseReply(message)) {
		await message.send("実行権限がありません。BOT管理者、またはこのOCの管理者/副官のみ実行できます。");
		return true;
	}

	const action = moderationCaseReplyAction(messageText);
	if (!action) {
		await message.send("操作は「再参加禁止」「解除」「無視」のいずれかで返信してください。");
		return true;
	}

	if (action === "ignore") {
		ocModerationCasesStore.update(moderationCase.id, {
			status: "ignored",
			updatedBy: message.destination.senderMid,
		});
		await ocModerationCasesStore.flush();
		await message.send("このケースを無視として処理しました。");
		return true;
	}

	if (action === "unban") {
		ocModerationCasesStore.update(moderationCase.id, {
			status: "unban_requested",
			updatedBy: message.destination.senderMid,
		});
		await ocModerationCasesStore.flush();
		await message.send([
			"解除要求を記録しました。",
			"再参加禁止解除APIはまだ未検証のため、自動解除は実行していません。",
			"必要であればLINE公式クライアント側で手動解除してください。",
		].join("\n"));
		return true;
	}

	if (!moderationCase.targetMid) {
		await message.send("対象MIDが記録されていないため、再参加禁止を実行できません。");
		return true;
	}

	const result = await banFromSquare(
		message.client,
		moderationCase.squareMid,
		moderationCase.targetMid,
		moderationCase.targetName,
		"副官部屋リプライによる再参加禁止",
		message.destination.senderMid,
	);
	ocModerationCasesStore.update(moderationCase.id, {
		status: result.ok ? "ban_succeeded" : "ban_failed",
		updatedBy: message.destination.senderMid,
		error: result.error,
	});
	await ocModerationCasesStore.flush();
	await message.send(result.ok
		? `再参加禁止を実行しました。\n対象: ${memberLine(moderationCase.targetName, moderationCase.targetMid)}`
		: `再参加禁止に失敗しました。\n対象: ${memberLine(moderationCase.targetName, moderationCase.targetMid)}\nエラー: ${result.error}`);
	return true;
}
