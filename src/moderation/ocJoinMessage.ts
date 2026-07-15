import type { Client } from "@evex/linejs";
import type { OpenChatMemberJoinEvent } from "./ocModeration.js";
import { ocModerationSettingsStore } from "./ocModerationSettings.js";

export interface OpenChatJoinSystemMessage {
	client: Client;
	squareMid: string;
	squareChatMid: string;
	senderMid: string;
	senderName?: string;
	messageId?: string;
	text?: string;
	contentType?: string | number;
	contentMetadata?: Record<string, string>;
	mentionMids: string[];
}

const RECENT_JOIN_RESPONSE_MS = 90_000;
const recentJoinResponses = new Map<string, number>();

function cleanDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || /^p[0-9a-f]{8,}$/i.test(trimmed)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(trimmed)) return undefined;
	if (/^[\p{C}\s]+$/u.test(trimmed)) return undefined;
	return trimmed;
}

function nameFromJoinNotificationText(text: string | undefined): string | undefined {
	const normalized = text?.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	for (const pattern of [
		/^(.+?)(?:さん)?が(?:参加|入室|加入)しました[。.]?$/,
		/^(.+?)(?:さん)?が(?:トーク|OpenChat|オープンチャット)に(?:参加|入室|加入)しました[。.]?$/,
		/^(.+?) joined (?:the )?(?:chat|openchat|open chat)[.]?$/i,
		/^(.+?) has joined (?:the )?(?:chat|openchat|open chat)[.]?$/i,
	]) {
		const name = cleanDisplayName(normalized.match(pattern)?.[1]);
		if (name) return name;
	}
	return undefined;
}

function looksLikeJoinNotification(text: string | undefined): boolean {
	return /(?:参加|入室|加入|joined)/i.test(text ?? "");
}

function reserveJoinResponse(squareChatMid: string, memberMid: string | undefined): boolean {
	if (!memberMid) return true;
	const now = Date.now();
	for (const [key, at] of recentJoinResponses) {
		if (now - at > RECENT_JOIN_RESPONSE_MS) recentJoinResponses.delete(key);
	}
	const key = `${squareChatMid}:${memberMid}`;
	const previous = recentJoinResponses.get(key);
	if (previous !== undefined && now - previous <= RECENT_JOIN_RESPONSE_MS) return false;
	recentJoinResponses.set(key, now);
	return true;
}

function mentionMetadata(start: number, end: number, mid: string): Record<string, string> {
	return {
		MENTION: JSON.stringify({
			MENTIONEES: [{ S: String(start), E: String(end), M: mid }],
		}),
	};
}

function joinedMemberMid(message: OpenChatJoinSystemMessage): string | undefined {
	const mentioned = message.mentionMids.find((mid) => /^p[0-9a-f]{8,}$/i.test(mid));
	if (mentioned) return mentioned;
	if (/^p[0-9a-f]{8,}$/i.test(message.senderMid)) return message.senderMid;
	return undefined;
}

async function joinedMemberName(
	message: OpenChatJoinSystemMessage,
	memberMid: string | undefined,
	detectedName: string | undefined,
): Promise<string> {
	if (detectedName) return detectedName;
	const fromText = nameFromJoinNotificationText(message.text);
	if (fromText) return fromText;
	if (message.senderName) return message.senderName;
	if (memberMid) {
		try {
			const member = await message.client.base.square.getSquareMember({ squareMemberMid: memberMid });
			const displayName = cleanDisplayName(member.squareMember.displayName);
			if (displayName) return displayName;
		} catch (error) {
			console.warn("[oc-join-message] member name lookup failed", error);
		}
	}
	return "参加者";
}

async function displayNameForJoin(input: {
	client: Client;
	memberMid?: string;
	detectedName?: string;
	displayName?: string;
}): Promise<string> {
	const detected = cleanDisplayName(input.detectedName);
	if (detected) return detected;
	const displayName = cleanDisplayName(input.displayName);
	if (displayName) return displayName;
	if (input.memberMid) {
		try {
			const member = await input.client.base.square.getSquareMember({ squareMemberMid: input.memberMid });
			const resolvedName = cleanDisplayName(member.squareMember.displayName);
			if (resolvedName) return resolvedName;
		} catch (error) {
			console.warn("[oc-join-message] member name lookup failed", error);
		}
	}
	return "参加者";
}

async function sendConfiguredJoinMessage(input: {
	client: Client;
	squareMid: string;
	squareChatMid: string;
	memberMid?: string;
	displayName?: string;
	detectedName?: string;
	messageId?: string;
	source: "system-message" | "join-event";
}): Promise<boolean> {
	const setting = ocModerationSettingsStore.joinMessage(input.squareChatMid);
	if (input.source === "join-event") {
		console.log("[oc-join-message] join event received", {
			squareMid: input.squareMid,
			squareChatMid: input.squareChatMid,
			memberMid: input.memberMid,
			displayName: input.displayName,
			configured: Boolean(setting),
		});
	}
	if (!setting) return false;
	if (!reserveJoinResponse(input.squareChatMid, input.memberMid)) {
		console.log("[oc-join-message] skipped duplicate", {
			squareMid: input.squareMid,
			squareChatMid: input.squareChatMid,
			memberMid: input.memberMid,
			source: input.source,
		});
		return true;
	}

	const displayName = await displayNameForJoin(input);
	const prefix = `@${displayName}`;
	const text = setting.mention && input.memberMid ? `${prefix}\n${setting.text}` : setting.text;
	const contentMetadata = setting.mention && input.memberMid
		? mentionMetadata(0, prefix.length, input.memberMid)
		: undefined;

	try {
		await input.client.base.square.sendMessage({
			squareChatMid: input.squareChatMid,
			text,
			contentMetadata,
		});
		console.log("[oc-join-message] sent", {
			squareMid: input.squareMid,
			squareChatMid: input.squareChatMid,
			messageId: input.messageId,
			source: input.source,
			mention: setting.mention,
			mentioned: Boolean(setting.mention && input.memberMid),
		});
	} catch (error) {
		console.warn("[oc-join-message] send failed", error);
	}
	return true;
}

export async function handleOpenChatJoinSystemMessage(message: OpenChatJoinSystemMessage): Promise<boolean> {
	const setting = ocModerationSettingsStore.joinMessage(message.squareChatMid);
	if (!setting) return false;
	const joinedName = nameFromJoinNotificationText(message.text);
	if (!joinedName) {
		if (looksLikeJoinNotification(message.text)) {
			console.log("[oc-join-message] join-like system message ignored", {
				squareMid: message.squareMid,
				squareChatMid: message.squareChatMid,
				messageId: message.messageId,
				senderMid: message.senderMid,
				text: message.text,
				contentType: message.contentType,
				metadataKeys: Object.keys(message.contentMetadata ?? {}).sort(),
				mentionCount: message.mentionMids.length,
			});
		}
		return false;
	}

	const memberMid = joinedMemberMid(message);
	const displayName = await joinedMemberName(message, memberMid, joinedName);
	return await sendConfiguredJoinMessage({
		client: message.client,
		squareMid: message.squareMid,
		squareChatMid: message.squareChatMid,
		memberMid,
		displayName,
		detectedName: joinedName,
		messageId: message.messageId,
		source: "system-message",
	});
}

export async function handleOpenChatJoinEventMessage(event: OpenChatMemberJoinEvent): Promise<boolean> {
	if (!event.squareChatMid || event.source !== "chat-member") return false;
	return await sendConfiguredJoinMessage({
		client: event.client,
		squareMid: event.squareMid,
		squareChatMid: event.squareChatMid,
		memberMid: event.memberMid,
		displayName: event.displayName,
		source: "join-event",
	});
}
