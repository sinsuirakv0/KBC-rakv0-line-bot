import type { Client } from "@evex/linejs";
import { ocModerationSettingsStore } from "./ocModerationSettings.js";

export interface OpenChatJoinSystemMessage {
	client: Client;
	squareMid: string;
	squareChatMid: string;
	senderMid: string;
	senderName?: string;
	text?: string;
	mentionMids: string[];
}

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

async function joinedMemberName(message: OpenChatJoinSystemMessage, memberMid: string | undefined): Promise<string> {
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

export async function handleOpenChatJoinSystemMessage(message: OpenChatJoinSystemMessage): Promise<boolean> {
	if (!nameFromJoinNotificationText(message.text)) return false;
	const setting = ocModerationSettingsStore.joinMessage(message.squareChatMid);
	if (!setting) return false;

	const memberMid = joinedMemberMid(message);
	const displayName = await joinedMemberName(message, memberMid);
	const prefix = `@${displayName}`;
	const text = setting.mention && memberMid ? `${prefix}\n${setting.text}` : setting.text;
	const contentMetadata = setting.mention && memberMid
		? mentionMetadata(0, prefix.length, memberMid)
		: undefined;

	try {
		await message.client.base.square.sendMessage({
			squareChatMid: message.squareChatMid,
			text,
			contentMetadata,
		});
	} catch (error) {
		console.warn("[oc-join-message] send failed", error);
	}
	return true;
}
