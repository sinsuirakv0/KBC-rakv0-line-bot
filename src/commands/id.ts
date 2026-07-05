import type { Client } from "@evex/linejs";
import type { LineCommand, LineDestination } from "./shared.js";
import { sendLong } from "./shared.js";

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
		notificationMessage?: OldSearchMessagePayload;
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
			text?: string;
		};
	};
}

interface FetchSquareChatEventsOptions {
	squareChatMid: string;
	threadMid?: string;
	syncToken?: string;
	continuationToken?: string;
	limit?: number;
	direction?: "FORWARD" | "BACKWARD";
	inclusive?: "NONE" | "ON" | "OFF";
	fetchType?: "DEFAULT" | "PREFETCH_BY_SERVER" | "PREFETCH_BY_CLIENT";
}

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

function eventTypeName(event: OldSearchEvent): string {
	if (typeof event.type === "string" || typeof event.type === "number") return String(event.type);
	const payload = event.payload ?? {};
	const keys = Object.keys(payload).filter((key) => (payload as Record<string, unknown>)[key] !== undefined);
	return keys.join("+") || "(typeなし)";
}

function eventTypeSummary(events: OldSearchEvent[]): string {
	const counts = new Map<string, number>();
	for (const event of events) {
		const type = eventTypeName(event);
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([type, count]) => `${type}:${count}`)
		.join(", ") || "(イベントなし)";
}

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function cleanDisplayName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || /^p[0-9a-f]{8,}$/i.test(trimmed)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(trimmed)) return undefined;
	if (!/[0-9A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(trimmed)) return undefined;
	return trimmed;
}

function eventMessagePayload(event: OldSearchEvent): OldSearchMessagePayload | undefined {
	return event.payload?.receiveMessage ?? event.payload?.sendMessage ?? event.payload?.notificationMessage;
}

function notificationTextFromEvent(event: OldSearchEvent): string | undefined {
	return event.payload?.notificationMessage?.squareMessage?.message?.text?.replace(/\s+/g, " ").trim();
}

function nameFromLeaveNotification(event: OldSearchEvent): string | undefined {
	const text = notificationTextFromEvent(event);
	if (!text) return undefined;
	for (const pattern of [
		/^(.+?)(?:さん)?が(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?)(?:さん)?が(?:トーク|OpenChat|オープンチャット)から(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?) left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
		/^(.+?) has left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
	]) {
		const name = cleanDisplayName(text.match(pattern)?.[1]);
		if (name) return name;
	}
	return undefined;
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

async function fetchSquareChatEvents(
	client: Client,
	options: FetchSquareChatEventsOptions,
) {
	return await client.base.square.fetchSquareChatEvents(options as never);
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
			name: cleanDisplayName(memberPayload.displayName) ?? memberPayload.squareMemberMid,
		};
	}

	const chatMemberMid = event.payload?.notifiedCreateSquareChatMember?.chatMember?.squareMemberMid;
	if (chatMemberMid?.startsWith("p")) {
		return {
			mid: chatMemberMid,
			name: cleanDisplayName(memberPayload?.displayName) ?? chatMemberMid,
		};
	}

	const leftMemberMid = event.payload?.notifiedLeaveSquareChat?.squareMemberMid;
	if (leftMemberMid?.startsWith("p")) {
		return {
			mid: leftMemberMid,
			name: nameFromLeaveNotification(event) ?? leftMemberMid,
		};
	}

	const payload = eventMessagePayload(event);
	const mid = payload?.squareMessage?.message?.from;
	if (!mid?.startsWith("p")) return undefined;
	return {
		mid,
		name: cleanDisplayName(payload?.senderDisplayName) ?? mid,
	};
}

async function searchOldSquareHistory(
	client: Client,
	destination: LineDestination,
	query: string,
	mentionedMid?: string,
	debug?: DebugLog,
): Promise<MemberInfo | undefined> {
	if (destination.kind !== "square") {
		throw new Error("old検索はOpenChatでのみ使用できます");
	}
	const normalizedQuery = normalizeText(query);
	let continuationToken: string | undefined;
	let syncToken: string | undefined;
	const seen = new Set<string>();
	const maxPages = 40;
	debug?.add("");
	debug?.add("[square event history]");
	debug?.add(`query="${query}" normalized="${normalizedQuery}" compact="${compactSearchText(query)}" mentionedMid=${mentionedMid || "(なし)"}`);
	debug?.add(`squareChatMid=${destination.chatMid} squareMid=${destination.scopeMid}`);
	const findInEvents = (events: OldSearchEvent[]): MemberInfo | undefined => {
		for (const [index, event] of events.entries()) {
			const member = eventMember(event);
			if (!member) {
				debug?.detail(`event#${index} type=${eventTypeName(event)} member=(なし)`);
				continue;
			}
			if (seen.has(member.mid)) {
				debug?.detail(`event#${index} type=${eventTypeName(event)} member="${member.name}" mid=${member.mid} skipped=seen`);
				continue;
			}
			seen.add(member.mid);
			const midMatch = Boolean(mentionedMid && member.mid === mentionedMid);
			const nameMatch = Boolean(!mentionedMid && normalizedQuery && looseNameMatches(member.name, query));
			debug?.detail(
				`event#${index} type=${eventTypeName(event)} member="${member.name}" mid=${member.mid} midMatch=${midMatch} nameMatch=${nameMatch}`,
			);
			if (midMatch) return member;
			if (nameMatch) return member;
		}
		return undefined;
	};

	for (let page = 0; page < 10; page++) {
		debug?.add(`prime page=${page + 1} direction=FORWARD syncToken=${syncToken ? "あり" : "なし"}`);
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken;
		debug?.add(
			`prime response events=${response.events.length} syncToken=${syncToken ? "あり" : "なし"} types=${eventTypeSummary(response.events as OldSearchEvent[])}`,
		);
		const found = findInEvents(response.events as OldSearchEvent[]);
		if (found) return found;
		if (response.events.length === 0) break;
	}
	debug?.add(`prime end syncToken=${syncToken ? "あり" : "なし"} seen=${seen.size}`);
	if (!syncToken) return undefined;

	for (let page = 0; page < maxPages; page++) {
		debug?.add(
			`backward page=${page + 1} inclusive=${page === 0 ? "ON" : "OFF"} continuation=${continuationToken ? "あり" : "なし"}`,
		);
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			direction: "BACKWARD",
			inclusive: page === 0 ? "ON" : "OFF",
			fetchType: "DEFAULT",
			limit: 100,
			...(continuationToken ? { continuationToken } : {}),
		});
		syncToken = response.syncToken;
		continuationToken = response.continuationToken || undefined;
		debug?.add(
			`backward response events=${response.events.length} continuation=${continuationToken ? "あり" : "なし"} syncToken=${
				syncToken ? "あり" : "なし"
			} types=${eventTypeSummary(response.events as OldSearchEvent[])}`,
		);

		const found = findInEvents(response.events as OldSearchEvent[]);
		if (found) return found;

		if (!continuationToken) break;
	}
	return undefined;
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
				"!id old <メンバー名> log",
				"  old検索の詳細ログを表示します。",
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
				const member = await searchSquareMemberDirectory(message.client, message.destination, query, mentionedMid, debug) ??
					await searchOldSquareHistory(message.client, message.destination, query, mentionedMid, debug);
				if (!member) {
					const text = `退会済みメンバー情報から「${query || mentionedMid}」に一致するユーザーは見つかりませんでした。`;
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
