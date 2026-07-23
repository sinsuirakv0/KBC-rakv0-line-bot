import type { Client } from "@evex/linejs";
import { createHash } from "node:crypto";
import type { OpenChatMemberJoinEvent, OpenChatMemberLeaveEvent } from "./ocModeration.js";
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

type MemberMessageMode = "join" | "leave";

const RECENT_MEMBER_MESSAGE_RESPONSE_MS = 90_000;
const recentMemberMessageResponses = new Map<string, number>();

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

function reserveMemberMessageResponse(
	mode: MemberMessageMode,
	squareChatMid: string,
	memberMid: string | undefined,
): boolean {
	if (!memberMid) return true;
	const now = Date.now();
	for (const [key, at] of recentMemberMessageResponses) {
		if (now - at > RECENT_MEMBER_MESSAGE_RESPONSE_MS) recentMemberMessageResponses.delete(key);
	}
	const key = `${mode}:${squareChatMid}:${memberMid}`;
	const previous = recentMemberMessageResponses.get(key);
	if (previous !== undefined && now - previous <= RECENT_MEMBER_MESSAGE_RESPONSE_MS) return false;
	recentMemberMessageResponses.set(key, now);
	return true;
}

function mentionMetadata(start: number, end: number, mid: string): Record<string, string> {
	return {
		MENTION: JSON.stringify({
			MENTIONEES: [{ S: String(start), E: String(end), M: mid }],
		}),
	};
}

function memberShortId(squareMid: string, memberMid: string | undefined): string | undefined {
	if (!memberMid) return undefined;
	return createHash("sha1")
		.update(`${squareMid}:${memberMid}`)
		.digest("base64url")
		.replace(/[^0-9a-z]/gi, "")
		.slice(0, 6)
		.toLowerCase();
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

async function displayNameForMember(input: {
	client: Client;
	memberMid?: string;
	detectedName?: string;
	displayName?: string;
	fallbackName: string;
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
	return input.fallbackName;
}

async function sendConfiguredMemberMessage(input: {
	mode: MemberMessageMode;
	client: Client;
	squareMid: string;
	squareChatMid: string;
	memberMid?: string;
	displayName?: string;
	detectedName?: string;
	messageId?: string;
	source: "system-message" | "join-event" | "leave-event";
	fallbackName: string;
}): Promise<boolean> {
	const setting = input.mode === "join"
		? ocModerationSettingsStore.joinMessage(input.squareChatMid)
		: ocModerationSettingsStore.leaveMessage(input.squareChatMid);
	if (input.source === "join-event" || input.source === "leave-event") {
		console.log("[oc-member-message] event received", {
			mode: input.mode,
			squareMid: input.squareMid,
			squareChatMid: input.squareChatMid,
			memberMid: input.memberMid,
			displayName: input.displayName,
			configured: Boolean(setting),
		});
	}
	if (!setting) return false;
	if (!reserveMemberMessageResponse(input.mode, input.squareChatMid, input.memberMid)) {
		console.log("[oc-member-message] skipped duplicate", {
			mode: input.mode,
			squareMid: input.squareMid,
			squareChatMid: input.squareChatMid,
			memberMid: input.memberMid,
			source: input.source,
		});
		return true;
	}

	const displayName = await displayNameForMember(input);
	const prefix = `@${displayName}`;
	const body = setting.text.replaceAll("<name>", displayName);
	const shortId = setting.showId ? memberShortId(input.squareMid, input.memberMid) : undefined;
	const text = [
		setting.mention && input.memberMid ? prefix : "",
		shortId ? `ID: ${shortId}` : "",
		body,
	].filter(Boolean).join("\n");
	const contentMetadata = setting.mention && input.memberMid
		? mentionMetadata(0, prefix.length, input.memberMid)
		: undefined;

	try {
		await input.client.base.square.sendMessage({
			squareChatMid: input.squareChatMid,
			text,
			contentMetadata,
		});
		console.log("[oc-member-message] sent", {
			mode: input.mode,
			squareMid: input.squareMid,
			squareChatMid: input.squareChatMid,
			messageId: input.messageId,
			source: input.source,
			mention: setting.mention,
			mentioned: Boolean(setting.mention && input.memberMid),
		});
	} catch (error) {
		console.warn("[oc-member-message] send failed", error);
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
	return await sendConfiguredMemberMessage({
		mode: "join",
		client: message.client,
		squareMid: message.squareMid,
		squareChatMid: message.squareChatMid,
		memberMid,
		displayName,
		detectedName: joinedName,
		messageId: message.messageId,
		source: "system-message",
		fallbackName: "参加者",
	});
}

export async function handleOpenChatJoinEventMessage(
	event: OpenChatMemberJoinEvent,
	options: { ignoreBefore?: number } = {},
): Promise<boolean> {
	if (!event.squareChatMid || event.source !== "chat-member") return false;
	if (
		options.ignoreBefore !== undefined &&
		(event.joinedAt === undefined || event.joinedAt < options.ignoreBefore)
	) {
		console.log("[oc-join-message] skipped replayed join event", {
			squareMid: event.squareMid,
			squareChatMid: event.squareChatMid,
			memberMid: event.memberMid,
			displayName: event.displayName,
			joinedAt: event.joinedAt,
			ignoreBefore: options.ignoreBefore,
		});
		return false;
	}
	return await sendConfiguredMemberMessage({
		mode: "join",
		client: event.client,
		squareMid: event.squareMid,
		squareChatMid: event.squareChatMid,
		memberMid: event.memberMid,
		displayName: event.displayName,
		source: "join-event",
		fallbackName: "参加者",
	});
}

export async function handleOpenChatLeaveEventMessage(
	event: OpenChatMemberLeaveEvent,
	options: { ignoreBefore?: number } = {},
): Promise<boolean> {
	if (!event.squareChatMid || event.source !== "chat-member") return false;
	if (
		options.ignoreBefore !== undefined &&
		(event.leftAt === undefined || event.leftAt < options.ignoreBefore)
	) {
		console.log("[oc-member-message] skipped replayed leave event", {
			squareMid: event.squareMid,
			squareChatMid: event.squareChatMid,
			memberMid: event.memberMid,
			displayName: event.displayName,
			leftAt: event.leftAt,
			ignoreBefore: options.ignoreBefore,
		});
		return false;
	}
	return await sendConfiguredMemberMessage({
		mode: "leave",
		client: event.client,
		squareMid: event.squareMid,
		squareChatMid: event.squareChatMid,
		memberMid: event.memberMid,
		displayName: event.displayName,
		source: "leave-event",
		fallbackName: "退室者",
	});
}
