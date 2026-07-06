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

interface SquareMemberSummary {
	role: SquareRole;
	displayName?: string;
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
const mediaBurstHistory = new Map<string, number[]>();
const handledMessageIds = new Map<string, number>();
const handledPostIds = new Map<string, number>();
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

function messageKey(message: OpenChatModerationMessage): string {
	return `${message.squareChatMid}:${message.messageId}`;
}

function wasHandled(message: OpenChatModerationMessage): boolean {
	return handledMessageIds.has(messageKey(message));
}

function rememberHandled(message: OpenChatModerationMessage): void {
	const now = Date.now();
	handledMessageIds.set(messageKey(message), now);
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

function shouldDeleteMediaBurst(message: OpenChatModerationMessage): boolean {
	const timestamp = finiteTimestamp(message.createdAt);
	const minimum = timestamp - MEDIA_BURST_WINDOW_MS;
	const key = mediaBurstKey(message);
	const recent = (mediaBurstHistory.get(key) ?? []).filter((item) => item >= minimum);
	recent.push(timestamp);
	mediaBurstHistory.set(key, recent);
	pruneMediaBurstHistory(timestamp);
	return recent.length >= MEDIA_BURST_LIMIT;
}

function pruneMediaBurstHistory(now: number): void {
	if (mediaBurstHistory.size < 1_000) return;
	const minimum = now - MEDIA_BURST_WINDOW_MS;
	for (const [key, timestamps] of mediaBurstHistory) {
		const recent = timestamps.filter((timestamp) => timestamp >= minimum);
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

function collectPostTexts(value: unknown, depth = 0): string[] {
	if (depth > 5 || value === null || value === undefined) return [];
	if (typeof value === "string") return [value];
	if (typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap((item) => collectPostTexts(item, depth + 1));

	const raw = value as Record<string, unknown>;
	const lines: string[] = [];
	for (const [key, item] of Object.entries(raw)) {
		const lower = key.toLowerCase();
		if (lower.includes("comment") || lower.includes("like") || lower.includes("reaction")) continue;
		if (lower === "text" || lower === "body" || lower === "contents" || lower === "content" || lower === "post" || lower === "postinfo" || lower === "result") {
			lines.push(...collectPostTexts(item, depth + 1));
		}
	}
	return lines;
}

async function fetchPostText(event: OpenChatPostModerationEvent, postId: string): Promise<string | undefined> {
	try {
		const response = await event.client.base.timeline.getPost({
			homeId: event.squareMid,
			postId,
		});
		const texts = collectPostTexts(response.result);
		const joined = texts.join("\n").trim();
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
	try {
		const response = await event.client.base.timeline.deletePost({
			homeId: event.squareMid,
			postId,
		});
		if (response.code !== 0) {
			console.warn("[oc-moderation] square note delete returned non-zero", {
				squareMid: event.squareMid,
				postId,
				response,
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

async function deleteSquareMessage(message: OpenChatModerationMessage): Promise<void> {
	rememberHandled(message);
	try {
		await message.client.base.square.destroyMessage({
			squareChatMid: message.squareChatMid,
			messageId: message.messageId,
		});
		return;
	} catch (destroyError) {
		try {
			await message.client.base.square.unsendMessage({
				squareChatMid: message.squareChatMid,
				messageId: message.messageId,
			});
		} catch (unsendError) {
			console.warn("[oc-moderation] message deletion failed", { destroyError, unsendError });
		}
	}
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
	await deleteSquareMessage(message);
	if (shouldWarn) await sendMentionNotice(message, notice);
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
		await deleteSquareMessage(message);
		return true;
	}

	if (settings.mediaBurstDeleteEnabled) logMediaModerationCandidate(message);
	if (
		settings.mediaBurstDeleteEnabled &&
		isImageOrVideo(message.contentType) &&
		shouldDeleteMediaBurst(message)
	) {
		await deleteAndNotify(message, MEDIA_BURST_DELETE_NOTICE, true);
		return true;
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
