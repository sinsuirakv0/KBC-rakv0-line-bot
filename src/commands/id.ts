import type { Client } from "@evex/linejs";
import type { LineCommand, LineDestination } from "./shared.js";

interface MemberInfo {
	mid: string;
	name: string;
}

interface OldSearchEvent {
	type?: string | number;
	payload?: {
		receiveMessage?: OldSearchMessagePayload;
		sendMessage?: OldSearchMessagePayload;
		notifiedCreateSquareMember?: { squareMember?: OldSearchSquareMember };
		notifiedCreateSquareChatMember?: {
			chatMember?: { squareMemberMid?: string };
			peerSquareMember?: OldSearchSquareMember;
		};
		notifiedJoinSquareChat?: { joinedMember?: OldSearchSquareMember };
		notifiedLeaveSquareChat?: { squareMember?: OldSearchSquareMember; squareMemberMid?: string };
		notifiedKickoutFromSquare?: { kickees?: OldSearchSquareMember[] };
		notifiedUpdateSquareMemberProfile?: { squareMember?: OldSearchSquareMember };
		notifiedUpdateSquareMember?: { squareMember?: OldSearchSquareMember };
	};
}

type OldSearchMembershipState = "LEFT" | "KICK_OUT" | "BANNED" | "JOINED";

interface OldSearchSquareMember {
	squareMemberMid?: string;
	displayName?: string;
}

interface OldSearchMessagePayload {
	senderDisplayName?: string;
	squareMessage?: {
		message?: {
			from?: string;
		};
	};
}

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function compactSearchText(value: string): string {
	return normalizeText(value).replace(/[\s\u3000\-_.・/\\()[\]{}「」『』【】!！?？~〜～、。，．,]/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
	let index = 0;
	for (const char of needle) {
		index = haystack.indexOf(char, index);
		if (index === -1) return false;
		index += char.length;
	}
	return true;
}

function looseNameMatches(name: string, query: string): boolean {
	const normalizedName = normalizeText(name);
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return false;
	if (normalizedName.includes(normalizedQuery)) return true;
	const compactName = compactSearchText(name);
	const compactQuery = compactSearchText(query);
	if (!compactQuery) return false;
	if (compactName.includes(compactQuery) || compactQuery.includes(compactName)) return true;
	return compactQuery.length >= 2 && isSubsequence(compactQuery, compactName);
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
		.filter((member) => normalizeText(member.name).includes(normalizedQuery) || looseNameMatches(member.name, query))
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

function eventMember(event: OldSearchEvent): MemberInfo | undefined {
	const memberPayload =
		event.payload?.notifiedCreateSquareMember?.squareMember ??
		event.payload?.notifiedCreateSquareChatMember?.peerSquareMember ??
		event.payload?.notifiedJoinSquareChat?.joinedMember ??
		event.payload?.notifiedLeaveSquareChat?.squareMember ??
		event.payload?.notifiedKickoutFromSquare?.kickees?.[0] ??
		event.payload?.notifiedUpdateSquareMemberProfile?.squareMember ??
		event.payload?.notifiedUpdateSquareMember?.squareMember;
	if (memberPayload?.squareMemberMid?.startsWith("p")) {
		return {
			mid: memberPayload.squareMemberMid,
			name: memberPayload.displayName || "(名前なし)",
		};
	}

	const chatMemberMid = event.payload?.notifiedCreateSquareChatMember?.chatMember?.squareMemberMid;
	if (chatMemberMid?.startsWith("p")) {
		return {
			mid: chatMemberMid,
			name: memberPayload?.displayName || "(名前なし)",
		};
	}

	const leftMemberMid = event.payload?.notifiedLeaveSquareChat?.squareMemberMid;
	if (leftMemberMid?.startsWith("p")) {
		return {
			mid: leftMemberMid,
			name: "(名前なし)",
		};
	}

	const payload = event.payload?.receiveMessage ?? event.payload?.sendMessage;
	const mid = payload?.squareMessage?.message?.from;
	if (!mid?.startsWith("p")) return undefined;
	return {
		mid,
		name: payload?.senderDisplayName || "(名前なし)",
	};
}

async function searchOldSquareHistory(
	client: Client,
	destination: LineDestination,
	query: string,
	mentionedMid?: string,
): Promise<MemberInfo | undefined> {
	if (destination.kind !== "square") {
		throw new Error("old検索はOpenChatでのみ使用できます");
	}
	const normalizedQuery = normalizeText(query);
	let continuationToken: string | undefined;
	let syncToken: string | undefined;
	const seen = new Set<string>();
	const maxPages = 30;

	for (let page = 0; page < maxPages; page++) {
		const response = await client.base.square.fetchSquareChatEvents({
			squareChatMid: destination.chatMid,
			syncToken,
			direction: "BACKWARD",
			limit: 100,
			...(continuationToken ? { continuationToken } : {}),
		} as never);
		syncToken = response.syncToken;
		continuationToken = response.continuationToken || undefined;

		for (const event of response.events as OldSearchEvent[]) {
			const member = eventMember(event);
			if (!member || seen.has(member.mid)) continue;
			seen.add(member.mid);
			if (mentionedMid && member.mid === mentionedMid) return member;
			if (!mentionedMid && normalizedQuery && looseNameMatches(member.name, query)) return member;
		}

		if (!continuationToken || response.events.length === 0) break;
	}
	return undefined;
}

async function searchSquareMemberDirectory(
	client: Client,
	destination: LineDestination,
	query: string,
	mentionedMid?: string,
): Promise<MemberInfo | undefined> {
	if (destination.kind !== "square") {
		throw new Error("old検索はOpenChatでのみ使用できます");
	}
	if (mentionedMid?.startsWith("p")) {
		const response = await client.base.square.getSquareMember({ squareMemberMid: mentionedMid });
		if (response.squareMember.squareMid === destination.scopeMid) {
			return {
				mid: response.squareMember.squareMemberMid,
				name: response.squareMember.displayName || "(名前なし)",
			};
		}
	}

	const normalizedQuery = normalizeText(query);
	const states: OldSearchMembershipState[] = ["LEFT", "KICK_OUT", "BANNED", "JOINED"];
	const displayNameQueries = [...new Set([
		query,
		normalizeText(query),
		compactSearchText(query),
		query.split(/\s+/)[0] ?? "",
		"",
	].filter((value) => value !== undefined))];
	for (const state of states) {
		for (const displayName of displayNameQueries) {
			let continuationToken: string | undefined;
			for (let page = 0; page < 20; page++) {
				const response = await client.base.square.searchSquareMembers({
					request: {
						squareMid: destination.scopeMid,
						searchOption: {
							membershipState: state,
							memberRoles: [],
							displayName,
							ableToReceiveMessage: "NONE",
							ableToReceiveFriendRequest: "NONE",
							chatMidToExcludeMembers: "",
							includingMe: true,
							excludeBlockedMembers: false,
							includingMeOnlyMatch: false,
						},
						continuationToken,
						limit: 100,
					},
				});
				for (const member of response.members) {
					const info = {
						mid: member.squareMemberMid,
						name: member.displayName || "(名前なし)",
					};
					if (normalizeText(info.name).includes(normalizedQuery) || looseNameMatches(info.name, query)) return info;
				}
				continuationToken = response.continuationToken || undefined;
				if (!continuationToken || response.members.length === 0) break;
			}
		}
	}
	return undefined;
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
				"!id old <メンバー名>",
				"  退会済みを含むOpenChatメンバー情報から最初に見つかった人のMIDを表示します。",
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

		const oldSearch = args.some((arg) => arg.toLowerCase() === "old");
		const searchArgs = oldSearch ? args.filter((arg) => arg.toLowerCase() !== "old") : args;
		const mentionedMid = message.mentionMids[0];
		if (mentionedMid && !oldSearch) {
			const name = await resolvePersonName(message.client, message.destination, mentionedMid);
			await message.send(personText(mentionedMid, name));
			return;
		}

		const query = searchArgs.join(" ").trim();
		if (!query && !mentionedMid) {
			await message.send("検索するメンバー名を指定してください。\n使い方: !id <メンバー名>");
			return;
		}

		try {
			if (oldSearch) {
				const member = await searchSquareMemberDirectory(message.client, message.destination, query, mentionedMid) ??
					await searchOldSquareHistory(message.client, message.destination, query, mentionedMid);
				if (!member) {
					await message.send(`退会済みメンバー情報から「${query || mentionedMid}」に一致するユーザーは見つかりませんでした。`);
					return;
				}
				await message.send(personText(member.mid, member.name));
				return;
			}

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
