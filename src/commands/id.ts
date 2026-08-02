import type { Client } from "@evex/linejs";
import type { LineCommand, LineDestination } from "./shared.js";
import { sendLong } from "./shared.js";
import { startMemberEventBackfill } from "../memberEventLog/backfill.js";
import { memberEventLogStore } from "../memberEventLog/store.js";
import {
	permissionDeniedText,
	permissionStore,
	targetFromDestination,
} from "../permissions/store.js";

interface MemberInfo {
	mid: string;
	name: string;
}

interface JoinedSquareChatInfo {
	mid: string;
	name: string;
	isMain: boolean;
}

type OldSearchMembershipState = "LEFT" | "KICK_OUT" | "BANNED" | "JOINED";

class DebugLog {
	private readonly lines: string[] = [];
	private detailedLines = 0;
	private suppressedDetailedLines = 0;

	constructor(private readonly detailedLimit = 350) {}

	add(line = ""): void {
		this.lines.push(line);
	}

	detail(line: string): void {
		if (this.detailedLines < this.detailedLimit) {
			this.lines.push(line);
			this.detailedLines++;
			return;
		}
		this.suppressedDetailedLines++;
	}

	error(label: string, error: unknown): void {
		this.add(`${label}: ERROR ${error instanceof Error ? error.message : String(error)}`);
	}

	text(): string {
		if (this.suppressedDetailedLines > 0) {
			this.lines.push(`詳細行が多すぎるため ${this.suppressedDetailedLines} 行を省略しました。`);
		}
		return this.lines.join("\n");
	}
}

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function cleanDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || /^p[0-9a-f]{8,}$/i.test(trimmed)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(trimmed)) return undefined;
	if (/^[\p{C}\s]+$/u.test(trimmed)) return undefined;
	return trimmed;
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
	if (!compactName) return false;
	if (compactName.includes(compactQuery)) return true;
	if (compactName.length >= 2 && compactQuery.includes(compactName)) return true;
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
			return cleanDisplayName(response.squareMember.displayName) ?? mid;
		}

		const user = await client.getUser(mid);
		return cleanDisplayName(userNameFromRaw(user.raw)) ?? mid;
	} catch (error) {
		console.warn(`[id] failed to resolve person name for ${mid}`, error);
		return mid;
	}
}

async function resolveTalkName(client: Client, destination: LineDestination): Promise<string> {
	try {
		if (destination.kind === "square") {
			const squareChat = await client.getSquareChat(destination.chatMid);
			return cleanDisplayName(squareChat.name) ?? destination.chatMid;
		}

		if (destination.chatType === "USER") {
			return await resolvePersonName(client, destination, destination.chatMid);
		}

		const chat = await client.getChat(destination.chatMid);
		return cleanDisplayName(chat.name) ?? destination.chatMid;
	} catch (error) {
		console.warn(`[id] failed to resolve talk name for ${destination.chatMid}`, error);
		return destination.chatMid;
	}
}

async function resolveTalkMember(client: Client, mid: string): Promise<MemberInfo> {
	try {
		const user = await client.getUser(mid);
		return { mid, name: cleanDisplayName(userNameFromRaw(user.raw)) ?? mid };
	} catch (error) {
		console.warn(`[id] failed to resolve talk member ${mid}`, error);
		return { mid, name: mid };
	}
}

function joinedSquareChatInfo(value: unknown): JoinedSquareChatInfo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const chat = value as {
		squareChatMid?: unknown;
		name?: unknown;
		type?: unknown;
	};
	const mid = typeof chat.squareChatMid === "string" ? chat.squareChatMid.trim() : "";
	if (!mid) return undefined;
	const name = typeof chat.name === "string" ? chat.name.trim() : "";
	return {
		mid,
		name: cleanDisplayName(name) ?? "名前未取得",
		isMain: chat.type === 4 || chat.type === "SQUARE_DEFAULT",
	};
}

function isJoinedSquareChatMember(value: unknown): boolean {
	if (!value || typeof value !== "object") return true;
	const member = value as { membershipState?: unknown };
	return member.membershipState === undefined || member.membershipState === 1 || member.membershipState === "JOINED";
}

async function listJoinedSquareChats(client: Client): Promise<JoinedSquareChatInfo[]> {
	const chats = new Map<string, JoinedSquareChatInfo>();
	let continuationToken = "";
	for (let page = 0; page < 50; page++) {
		const response = await client.base.square.getJoinedSquareChats({
			request: { continuationToken, limit: 100 },
		});
		const rawResponse = response as {
			chats?: unknown[];
			chatMembers?: Record<string, unknown>;
			continuationToken?: string;
		};
		for (const rawChat of rawResponse.chats ?? []) {
			const chat = joinedSquareChatInfo(rawChat);
			if (!chat || !isJoinedSquareChatMember(rawResponse.chatMembers?.[chat.mid])) continue;
			chats.set(chat.mid, chat);
		}
		continuationToken = rawResponse.continuationToken || "";
		if (!continuationToken) break;
	}
	return [...chats.values()].sort((left, right) =>
		Number(right.isMain) - Number(left.isMain) ||
		left.name.localeCompare(right.name, "ja") ||
		left.mid.localeCompare(right.mid)
	);
}

async function listMembers(client: Client, destination: LineDestination): Promise<MemberInfo[]> {
	if (destination.kind === "square") {
		const squareChat = await client.getSquareChat(destination.chatMid);
		const members = await squareChat.getMembers();
		return members.map((member) => ({
			mid: member.squareMemberMid,
			name: cleanDisplayName(member.displayName) ?? member.squareMemberMid,
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
	debug?: DebugLog,
): Promise<MemberInfo[]> {
	const normalizedQuery = normalizeText(query);
	debug?.add("[current members]");
	debug?.add(`query="${query}" normalized="${normalizedQuery}" compact="${compactSearchText(query)}"`);
	debug?.add(`destination kind=${destination.kind} chatType=${destination.chatType} chatMid=${destination.chatMid}`);
	const members = await listMembers(client, destination);
	debug?.add(`listed members=${members.length}`);
	for (const member of members) {
		const includes = normalizeText(member.name).includes(normalizedQuery);
		const loose = looseNameMatches(member.name, query);
		debug?.detail(`candidate name="${member.name}" mid=${member.mid} includes=${includes} loose=${loose}`);
	}
	const matches = members
		.filter((member) => normalizeText(member.name).includes(normalizedQuery) || looseNameMatches(member.name, query))
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
	if (destination.kind !== "square") return matches;

	const byMid = new Map(matches.map((member) => [member.mid, member]));
	for (const member of await searchJoinedSquareMembers(client, destination, query, debug)) {
		byMid.set(member.mid, member);
	}
	return [...byMid.values()]
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

async function searchJoinedSquareMembers(
	client: Client,
	destination: LineDestination,
	query: string,
	debug?: DebugLog,
): Promise<MemberInfo[]> {
	const normalizedQuery = normalizeText(query);
	const displayNameQueries = [...new Set([
		query,
		normalizeText(query),
		compactSearchText(query),
		query.split(/\s+/)[0] ?? "",
		"",
	].filter((value) => value !== undefined))];
	const found = new Map<string, MemberInfo>();

	debug?.add("");
	debug?.add("[joined square member search]");
	debug?.add(`squareMid=${destination.scopeMid}`);
	debug?.add(`displayNameQueries=${displayNameQueries.map((value) => `"${value}"`).join(", ")}`);

	for (const displayName of displayNameQueries) {
		let continuationToken: string | undefined;
		for (let page = 0; page < 20; page++) {
			debug?.add(
				`searchSquareMembers state=JOINED displayName="${displayName}" page=${page + 1} continuation=${
					continuationToken ? "あり" : "なし"
				}`,
			);
			const response = await client.base.square.searchSquareMembers({
				request: {
					squareMid: destination.scopeMid,
					searchOption: {
						membershipState: "JOINED",
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
			debug?.add(`searchSquareMembers response members=${response.members.length} continuation=${response.continuationToken ? "あり" : "なし"}`);
			for (const member of response.members) {
				const info = {
					mid: member.squareMemberMid,
					name: cleanDisplayName(member.displayName) ?? member.squareMemberMid,
				};
				const includes = normalizeText(info.name).includes(normalizedQuery);
				const loose = looseNameMatches(info.name, query);
				debug?.detail(`joined candidate name="${info.name}" mid=${info.mid} includes=${includes} loose=${loose}`);
				if (includes || loose) found.set(info.mid, info);
			}
			continuationToken = response.continuationToken || undefined;
			if (!continuationToken || response.members.length === 0) break;
		}
		if (found.size > 0) break;
	}

	return [...found.values()];
}

async function searchSquareMemberDirectory(
	client: Client,
	destination: LineDestination,
	query: string,
	mentionedMid?: string,
	debug?: DebugLog,
): Promise<MemberInfo | undefined> {
	if (destination.kind !== "square") {
		throw new Error("old検索はOpenChatでのみ使用できます");
	}
	debug?.add("[square member directory]");
	debug?.add(`query="${query}" normalized="${normalizeText(query)}" compact="${compactSearchText(query)}" mentionedMid=${mentionedMid || "(なし)"}`);
	debug?.add(`squareChatMid=${destination.chatMid} squareMid=${destination.scopeMid}`);
	if (mentionedMid?.startsWith("p")) {
		debug?.add(`getSquareMember mentionedMid=${mentionedMid}`);
		try {
			const response = await client.base.square.getSquareMember({ squareMemberMid: mentionedMid });
			debug?.add(
				`getSquareMember result squareMid=${response.squareMember.squareMid} name="${cleanDisplayName(response.squareMember.displayName) ?? response.squareMember.squareMemberMid}"`,
			);
			if (response.squareMember.squareMid === destination.scopeMid) {
				return {
					mid: response.squareMember.squareMemberMid,
					name: cleanDisplayName(response.squareMember.displayName) ?? response.squareMember.squareMemberMid,
				};
			}
		} catch (error) {
			debug?.error("getSquareMember", error);
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
	debug?.add(`states=${states.join(",")}`);
	debug?.add(`displayNameQueries=${displayNameQueries.map((value) => `"${value}"`).join(", ")}`);
	for (const state of states) {
		for (const displayName of displayNameQueries) {
			let continuationToken: string | undefined;
			for (let page = 0; page < 20; page++) {
				debug?.add(
					`searchSquareMembers state=${state} displayName="${displayName}" page=${page + 1} continuation=${
						continuationToken ? "あり" : "なし"
					}`,
				);
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
				debug?.add(`searchSquareMembers response members=${response.members.length} continuation=${response.continuationToken ? "あり" : "なし"}`);
				for (const member of response.members) {
					const info = {
						mid: member.squareMemberMid,
						name: cleanDisplayName(member.displayName) ?? member.squareMemberMid,
					};
					const includes = normalizeText(info.name).includes(normalizedQuery);
					const loose = looseNameMatches(info.name, query);
					debug?.detail(`candidate state=${state} name="${info.name}" mid=${info.mid} includes=${includes} loose=${loose}`);
					if (includes || loose) return info;
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

async function searchMemberEventLog(
	destination: LineDestination,
	query: string,
	mentionedMid?: string,
	debug?: DebugLog,
): Promise<MemberInfo | undefined> {
	if (destination.kind !== "square") return undefined;
	const searchValue = mentionedMid || query;
	const matches = await memberEventLogStore.searchMembers(destination, searchValue, 20);
	debug?.add("");
	debug?.add("[member event log]");
	debug?.add(`query="${searchValue}" matches=${matches.length}`);
	for (const member of matches.slice(0, 20)) {
		debug?.detail(
			`candidate name="${member.name ?? "名前不明"}" mid=${member.mid} lastType=${member.lastType} lastAt=${member.lastAt}`,
		);
	}
	const match = mentionedMid
		? matches.find((member) => member.mid === mentionedMid)
		: matches[0];
	if (!match) return undefined;
	return {
		mid: match.mid,
		name: match.name ?? "名前不明",
	};
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
				"!id talk oc",
				"  Botが参加中の全OpenChatの名前とMIDを表示します（管理者のみ）。",
				"!id <メンバー名>",
				"  このトーク内のメンバー名を検索します。1人だけ見つかった場合は、その人のMIDを表示します。",
				"!id old <メンバー名>",
				"  退会済みを含むOpenChatメンバー情報から最初に見つかった人のMIDを表示します。",
				"!id old <メンバー名> log",
				"  old検索の詳細ログを表示します。",
				"!id log all",
				"  OCの参加・退出・強制退会履歴を、遡れる限界まで専用ログへ保存します（管理者のみ）。",
			].join("\n"));
			return;
		}

		if (action === "log") {
			if (args[1]?.toLowerCase() !== "all") {
				await message.send("使い方: !id log all");
				return;
			}
			const target = targetFromDestination(message.destination);
			if (!permissionStore.hasAtLeast(target, message.destination.senderMid, "admin")) {
				await message.send(permissionDeniedText("admin"));
				return;
			}
			await startMemberEventBackfill(message);
			return;
		}

		if (action === "talk" && args[1]?.toLowerCase() === "oc") {
			const target = targetFromDestination(message.destination);
			if (!permissionStore.hasAtLeast(target, message.destination.senderMid, "admin")) {
				await message.send(permissionDeniedText("admin"));
				return;
			}

			try {
				const chats = await listJoinedSquareChats(message.client);
				if (chats.length === 0) {
					await message.send("参加中のOpenChatは見つかりませんでした。");
					return;
				}
				await sendLong(message, [
					"参加中OpenChat一覧",
					`件数: ${chats.length}`,
					"",
					...chats.map((chat, index) => [
						`${index + 1}. ${chat.isMain ? "本OC" : "サブOC"}: ${chat.name}`,
						`MID: ${chat.mid}`,
					].join("\n")),
				].join("\n\n"));
			} catch (error) {
				console.warn("[id] failed to list joined square chats", error);
				await message.send("参加中OpenChat一覧の取得に失敗しました。しばらくしてからもう一度お試しください。");
			}
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
		const debugMode = args.some((arg) => arg.toLowerCase() === "log");
		const searchArgs = args.filter((arg) => {
			const lower = arg.toLowerCase();
			return lower !== "old" && lower !== "log";
		});
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
			const debug = debugMode ? new DebugLog() : undefined;
			if (debug) {
				debug.add("!id debug log");
				debug.add(`mode=${oldSearch ? "old" : "current"}`);
				debug.add(`rawArgs=${args.join(" ")}`);
				debug.add(`query="${query}" mentionedMid=${mentionedMid || "(なし)"}`);
				debug.add(`senderMid=${message.destination.senderMid}`);
				debug.add(`destination kind=${message.destination.kind} chatType=${message.destination.chatType}`);
				debug.add(`chatMid=${message.destination.chatMid}`);
				debug.add(`scopeMid=${message.destination.scopeMid}`);
				debug.add("");
			}
			if (oldSearch) {
				const member = await searchMemberEventLog(message.destination, query, mentionedMid, debug) ??
					await searchSquareMemberDirectory(message.client, message.destination, query, mentionedMid, debug);
				if (!member) {
					const text = `保存済みの参加・退出履歴から「${query || mentionedMid}」に一致するユーザーは見つかりませんでした。`;
					if (debug) await sendLong(message, `${text}\n\n${debug.text()}`);
					else await message.send(text);
					return;
				}
				if (debug) await sendLong(message, `${personText(member.mid, member.name)}\n\n${debug.text()}`);
				else await message.send(personText(member.mid, member.name));
				return;
			}

			const matches = await searchMembers(message.client, message.destination, query, debug);
			if (matches.length === 0) {
				const text = `「${query}」に一致するメンバーは見つかりませんでした。`;
				if (debug) await sendLong(message, `${text}\n\n${debug.text()}`);
				else await message.send(text);
				return;
			}
			if (matches.length === 1) {
				if (debug) await sendLong(message, `${personText(matches[0].mid, matches[0].name)}\n\n${debug.text()}`);
				else await message.send(personText(matches[0].mid, matches[0].name));
				return;
			}
			const text = formatMemberList(query, matches);
			if (debug) await sendLong(message, `${text}\n\n${debug.text()}`);
			else await message.send(text);
		} catch (error) {
			console.error("[id] member search failed", error);
			await message.send(`メンバー検索に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
