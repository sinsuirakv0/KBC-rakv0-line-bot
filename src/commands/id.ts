import type { Client } from "@evex/linejs";
import type { LineCommand, LineDestination } from "./shared.js";

interface MemberInfo {
	mid: string;
	name: string;
}

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

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

async function resolveTalkMember(client: Client, mid: string): Promise<MemberInfo> {
	try {
		const user = await client.getUser(mid);
		return { mid, name: userNameFromRaw(user.raw) || "(名前なし)" };
	} catch (error) {
		console.warn(`[id] failed to resolve talk member ${mid}`, error);
		return { mid, name: "(取得失敗)" };
	}
}

async function listMembers(client: Client, destination: LineDestination): Promise<MemberInfo[]> {
	if (destination.kind === "square") {
		const squareChat = await client.getSquareChat(destination.chatMid);
		const members = await squareChat.getMembers();
		return members.map((member) => ({
			mid: member.squareMemberMid,
			name: member.displayName || "(名前なし)",
		}));
	}

	if (destination.chatType === "USER") {
		return [{
			mid: destination.senderMid,
			name: destination.senderName || await resolvePersonName(client, destination, destination.senderMid),
		}];
	}

	const chat = await client.getChat(destination.chatMid);
	const raw = chat.raw as {
		extra?: {
			groupExtra?: {
				memberMids?: Record<string, unknown>;
			};
		};
	};
	const mids = Object.keys(raw.extra?.groupExtra?.memberMids ?? {});
	return await Promise.all(mids.map((mid) => resolveTalkMember(client, mid)));
}

function personText(mid: string, name: string): string {
	return [
		"ユーザーID",
		`名前: ${name}`,
		`MID: ${mid}`,
	].join("\n");
}

async function searchMembers(
	client: Client,
	destination: LineDestination,
	query: string,
): Promise<MemberInfo[]> {
	const normalizedQuery = normalizeText(query);
	const members = await listMembers(client, destination);
	return members
		.filter((member) => normalizeText(member.name).includes(normalizedQuery))
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

function formatMemberList(query: string, members: MemberInfo[]): string {
	const visible = members.slice(0, 20);
	const lines = [
		`検索: ${query}`,
		`結果: ${members.length}件`,
		"",
		...visible.map((member, index) => `${index + 1}. ${member.name}\nMID: ${member.mid}`),
	];
	if (members.length > visible.length) {
		lines.push("", `ほか${members.length - visible.length}件あります。検索語を増やして絞り込んでください。`);
	}
	return lines.join("\n");
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
				"!id <メンバー名>",
				"  このトーク内のメンバー名を検索します。1人だけ見つかった場合は、その人のMIDを表示します。",
			].join("\n"));
			return;
		}

		if (action === "talk") {
			const name = await resolveTalkName(message.client, message.destination);
			const lines = [
				"トークID",
				`トーク名: ${name}`,
				`MID: ${message.destination.chatMid}`,
				`種別: ${message.destination.chatType}`,
			];
			if (message.destination.kind === "square" && message.destination.scopeMid !== message.destination.chatMid) {
				lines.push(`本OC MID: ${message.destination.scopeMid}`);
			}
			await message.send(lines.join("\n"));
			return;
		}

		if (args.length === 0) {
			const name = message.destination.senderName ||
				await resolvePersonName(message.client, message.destination, message.destination.senderMid);
			await message.send(personText(message.destination.senderMid, name));
			return;
		}

		const mentionedMid = message.mentionMids[0];
		if (mentionedMid) {
			const name = await resolvePersonName(message.client, message.destination, mentionedMid);
			await message.send(personText(mentionedMid, name));
			return;
		}

		const query = args.join(" ").trim();
		if (!query) {
			await message.send("検索するメンバー名を指定してください。\n使い方: !id <メンバー名>");
			return;
		}

		try {
			const matches = await searchMembers(message.client, message.destination, query);
			if (matches.length === 0) {
				await message.send(`「${query}」に一致するメンバーは見つかりませんでした。`);
				return;
			}
			if (matches.length === 1) {
				await message.send(personText(matches[0].mid, matches[0].name));
				return;
			}
			await message.send(formatMemberList(query, matches));
		} catch (error) {
			console.error("[id] member search failed", error);
			await message.send(`メンバー検索に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
