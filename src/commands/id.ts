import type { Client } from "@evex/linejs";
import type { LineCommand, LineDestination } from "./shared.js";

function userNameFromRaw(raw: unknown): string | undefined {
	const value = raw as {
		targetProfileDetail?: { profileName?: string };
		profileName?: string;
		displayName?: string;
		name?: string;
	};
	return value.targetProfileDetail?.profileName ||
		value.profileName ||
		value.displayName ||
		value.name;
}

async function resolvePersonName(
	client: Client,
	destination: LineDestination,
	mid: string,
): Promise<string> {
	try {
		if (destination.kind === "square") {
			const response = await client.base.square.getSquareMember({ squareMemberMid: mid });
			return response.squareMember.displayName || "(名前なし)";
		}

		const user = await client.getUser(mid);
		return userNameFromRaw(user.raw) || "(名前なし)";
	} catch (error) {
		console.warn(`[id] failed to resolve person name for ${mid}`, error);
		return "(取得失敗)";
	}
}

async function resolveTalkName(client: Client, destination: LineDestination): Promise<string> {
	try {
		if (destination.kind === "square") {
			const squareChat = await client.getSquareChat(destination.chatMid);
			return squareChat.name || "(名前なし)";
		}

		if (destination.chatType === "USER") {
			return await resolvePersonName(client, destination, destination.chatMid);
		}

		const chat = await client.getChat(destination.chatMid);
		return chat.name || "(名前なし)";
	} catch (error) {
		console.warn(`[id] failed to resolve talk name for ${destination.chatMid}`, error);
		return "(取得失敗)";
	}
}

function personText(mid: string, name: string): string {
	return [
		"ユーザーID",
		`名前: ${name}`,
		`MID: ${mid}`,
	].join("\n");
}

export const idCommand: LineCommand = {
	name: "id",
	async execute({ message, args }) {
		const action = args[0]?.toLowerCase();
		if (action === "help") {
			await message.send([
				"!id",
				"",
				"!id",
				"  自分の名前とMIDを表示します。",
				"!id @メンション",
				"  メンションした相手の名前とMIDを表示します。",
				"!id talk",
				"  このトークの名前とMIDを表示します。",
			].join("\n"));
			return;
		}

		if (action === "talk") {
			const name = await resolveTalkName(message.client, message.destination);
			await message.send([
				"トークID",
				`トーク名: ${name}`,
				`MID: ${message.destination.chatMid}`,
				`種別: ${message.destination.chatType}`,
			].join("\n"));
			return;
		}

		if (args.length === 0) {
			const name = message.destination.senderName ||
				await resolvePersonName(message.client, message.destination, message.destination.senderMid);
			await message.send(personText(message.destination.senderMid, name));
			return;
		}

		const mentionedMid = message.mentionMids[0];
		if (!mentionedMid) {
			await message.send("IDを取得する相手をメンションしてください。\n使い方: !id @メンション\nトークIDは !id talk");
			return;
		}

		const name = await resolvePersonName(message.client, message.destination, mentionedMid);
		await message.send(personText(mentionedMid, name));
	},
};
