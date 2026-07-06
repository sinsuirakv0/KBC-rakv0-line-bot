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
	createdAt?: number;
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

const ROLE_ORDER = new Map<string, number>([
	["ADMIN", 3],
	["1", 3],
	["CO_ADMIN", 2],
	["2", 2],
	["MEMBER", 1],
	["10", 1],
]);

const roleCache = new Map<string, { role: SquareRole; expiresAt: number }>();
const mediaBurstHistory = new Map<string, number[]>();

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
		contentType === "IMAGE" ||
		contentType === "VIDEO";
}

function containsLineMeUrl(text: string | undefined): boolean {
	if (!text) return false;
	return LINE_ME_URL_PATTERN.test(text);
}

function finiteTimestamp(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? value : Date.now();
}

function mediaBurstKey(message: OpenChatModerationMessage): string {
	return `${message.squareMid}:${message.senderMid}`;
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

async function getSquareRole(client: Client, senderMid: string): Promise<SquareRole> {
	const cached = roleCache.get(senderMid);
	if (cached && cached.expiresAt > Date.now()) return cached.role;
	const response = await client.base.square.getSquareMember({ squareMemberMid: senderMid });
	const role = response.squareMember.role;
	roleCache.set(senderMid, { role, expiresAt: Date.now() + ROLE_CACHE_MS });
	return role;
}

async function isPrivilegedSender(message: OpenChatModerationMessage): Promise<boolean> {
	const target: PermissionTarget = {
		chatMid: message.squareMid,
		chatType: "SQUARE",
	};
	if (permissionStore.hasAtLeast(target, message.senderMid, "mod")) return true;
	try {
		return roleRank(await getSquareRole(message.client, message.senderMid)) >= roleRank("CO_ADMIN");
	} catch (error) {
		// 権限確認に失敗した場合は、管理者を誤削除しないため対象外にする。
		console.warn(`[oc-moderation] failed to resolve role for ${message.senderMid}`, error);
		return true;
	}
}

async function deleteSquareMessage(message: OpenChatModerationMessage): Promise<void> {
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

async function sendNotice(message: OpenChatModerationMessage, text: string): Promise<void> {
	try {
		await message.client.base.square.sendMessage({
			squareChatMid: message.squareChatMid,
			text,
		});
	} catch (error) {
		console.warn("[oc-moderation] notice send failed", error);
	}
}

async function deleteAndNotify(message: OpenChatModerationMessage, notice: string): Promise<void> {
	await deleteSquareMessage(message);
	await sendNotice(message, notice);
}

export async function handleOpenChatModeration(message: OpenChatModerationMessage): Promise<boolean> {
	const settings = ocModerationSettingsStore.snapshot(message.squareMid);
	if (!settings.linkDeleteEnabled && !settings.mediaBurstDeleteEnabled) return false;

	// LINE OCのAuto-replyなど、Square member MIDではない送信元は対象外。
	if (!isSquareMemberMid(message.senderMid)) return false;
	if (await isPrivilegedSender(message)) return false;

	if (settings.linkDeleteEnabled && containsLineMeUrl(message.text)) {
		await deleteAndNotify(message, LINK_DELETE_NOTICE);
		return true;
	}

	if (
		settings.mediaBurstDeleteEnabled &&
		isImageOrVideo(message.contentType) &&
		shouldDeleteMediaBurst(message)
	) {
		await deleteAndNotify(message, MEDIA_BURST_DELETE_NOTICE);
		return true;
	}

	return false;
}
