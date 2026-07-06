import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { permissionStore, type PermissionTarget } from "../permissions/store.js";
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
const MEDIA_BURST_DELETE_NOTICE = [
	"画像、動画の連投は許可されていません。",
	"ラグ軽減のためにもスレッドへ送信してください。",
].join("\n");
const MEDIA_BURST_WINDOW_MS = positiveNumber(appConfig.ocMediaBurstWindowMs, 60_000, 1_000);
const MEDIA_BURST_LIMIT = positiveNumber(appConfig.ocMediaBurstLimit, 5, 1);
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
const handledMessageIds = new Map<string, number>();
const handledPostIds = new Map<string, number>();
const noteScanRequests = new Map<string, Promise<boolean>>();
const noteScanLastStartedAt = new Map<string, number>();
const loggedMediaTypes = new Set<string>();

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

function mediaHistoryItem(message: OpenChatModerationMessage): MediaHistoryItem {
	return {
		squareChatMid: message.squareChatMid,
		messageId: message.messageId,
		timestamp: finiteTimestamp(message.createdAt),
		groupId: mediaGroupId(message),
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
		return {
			shouldDelete: true,
			shouldWarn: rememberMediaGroupWarning(message, groupId),
			reason: "group-total",
			targets: recent.filter((item) => item.groupId === groupId),
		};
	}

	if (recent.length >= MEDIA_BURST_LIMIT) {
		return {
			shouldDelete: true,
			shouldWarn: true,
			reason: "window",
			targets: recent,
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

async function deleteAndNotify(message: OpenChatModerationMessage, notice: string, shouldWarn: boolean): Promise<void> {
	await deleteSquareMessage(message, "moderation");
	if (shouldWarn) await sendMentionNotice(message, notice);
}

async function deleteMediaBurstMessages(
	message: OpenChatModerationMessage,
	decision: MediaBurstDecision,
): Promise<void> {
	const targetKeys = new Set(decision.targets.map((target) => messageRefKey(target)));
	if (!targetKeys.has(messageRefKey(message))) decision.targets.push(mediaHistoryItem(message));
	for (const target of decision.targets) {
		await deleteSquareMessageRef(message.client, target, `media-${decision.reason}`);
	}
	if (decision.shouldWarn) await sendMentionNotice(message, MEDIA_BURST_DELETE_NOTICE);
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

export async function handleOpenChatModeration(message: OpenChatModerationMessage): Promise<boolean> {
	if (wasHandled(message)) return true;
	const settings = ocModerationSettingsStore.snapshot(message.squareMid);
	if (!settings.linkDeleteEnabled && !settings.mediaBurstDeleteEnabled) return false;

	// LINE OCのAuto-replyなど、Square member MIDではない送信元は対象外。
	if (!isSquareMemberMid(message.senderMid)) return false;
	if (await isPrivilegedSender(message)) return false;

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
