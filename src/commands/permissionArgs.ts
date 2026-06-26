import type { LineDestination } from "./shared.js";
import { type PermissionChatType, type PermissionTarget, targetFromDestination } from "../permissions/store.js";

export function argValue(args: string[], key: string): string | undefined {
	const prefix = `${key.toLowerCase()}:`;
	const found = args.find((arg) => arg.toLowerCase().startsWith(prefix));
	return found?.slice(prefix.length).trim() || undefined;
}

export function parseChatType(args: string[], fallback?: PermissionChatType): PermissionChatType | undefined {
	for (const arg of args) {
		const normalized = arg.toLowerCase();
		if (normalized === "square" || normalized === "oc" || normalized === "openchat") return "SQUARE";
		if (normalized === "talk") return "TALK";
		if (normalized === "user" || normalized === "個人") return "USER";
		if (normalized === "group" || normalized === "グループ") return "GROUP";
		if (normalized === "room") return "ROOM";
	}
	return fallback;
}

function inferChatTypeFromMid(mid: string): PermissionChatType | undefined {
	if (mid.startsWith("m")) return "SQUARE";
	if (mid.startsWith("u")) return "USER";
	if (mid.startsWith("c")) return "GROUP";
	if (mid.startsWith("r")) return "ROOM";
	return undefined;
}

export function parseTarget(args: string[], destination: LineDestination): PermissionTarget | null {
	const explicitTalkId = argValue(args, "talkID") || argValue(args, "talkId") || argValue(args, "talkid");
	if (explicitTalkId) {
		const chatType = parseChatType(args) || inferChatTypeFromMid(explicitTalkId);
		if (!chatType) return null;
		return { chatMid: explicitTalkId, chatType };
	}
	return targetFromDestination(destination);
}

export function targetLabel(target: PermissionTarget): string {
	if (target.chatType !== "SQUARE") return "TALK全体";
	return `${target.chatType} ${target.chatMid}`;
}
