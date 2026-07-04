import type { Client } from "@evex/linejs";
import { memberNameHistoryStore } from "../nameHistory/store.js";
import { sendSearchResults } from "./searchPages.js";
import type { LineCommand, LineDestination } from "./shared.js";

type SquareMembershipState = "LEFT" | "KICK_OUT" | "BANNED" | "JOINED";

interface MemberInfo {
	mid: string;
	name: string;
}

interface FetchSquareChatEventsOptions {
	squareChatMid: string;
	syncToken?: string;
	continuationToken?: string;
	limit?: number;
	direction?: "FORWARD" | "BACKWARD";
	inclusive?: "NONE" | "ON" | "OFF";
	fetchType?: "DEFAULT" | "PREFETCH_BY_SERVER" | "PREFETCH_BY_CLIENT";
}

interface SquareHistoryEvent {
	createdTime?: number | bigint;
	type?: string | number;
	payload?: {
		receiveMessage?: SquareHistoryMessagePayload;
		sendMessage?: SquareHistoryMessagePayload;
		notifiedCreateSquareMember?: { squareMember?: SquareHistoryMember };
		notifiedCreateSquareChatMember?: {
			chatMember?: { squareMemberMid?: string };
			peerSquareMember?: SquareHistoryMember;
		};
		notifiedJoinSquareChat?: { joinedMember?: SquareHistoryMember };
		notifiedLeaveSquareChat?: { squareMember?: SquareHistoryMember; squareMemberMid?: string };
		notifiedKickoutFromSquare?: { kickees?: SquareHistoryMember[] };
		notifiedUpdateSquareMemberProfile?: { squareMember?: SquareHistoryMember };
		notifiedUpdateSquareMember?: { squareMember?: SquareHistoryMember };
	};
}

interface SquareHistoryMember {
	squareMemberMid?: string;
	displayName?: string;
}

interface SquareHistoryMessagePayload {
	senderDisplayName?: string;
	squareMid?: string;
	squareMessage?: {
		message?: {
			id?: string;
			from?: string;
			createdTime?: number | bigint;
			text?: string;
			contentType?: string | number;
			hasContent?: boolean;
		};
	};
}

interface LogEntry {
	id: string;
	createdAt: number;
	content: string;
}

interface ResolvedTarget {
	member: MemberInfo;
	filter: string;
	ambiguous?: MemberInfo[];
}

const MAX_LOG_ROWS = 1000;
const LOG_PAGE_SIZE = 20;

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

async function fetchSquareChatEvents(
	client: Client,
	options: FetchSquareChatEventsOptions,
) {
	return await client.base.square.fetchSquareChatEvents(options as never);
}

function formatLogTime(createdAt: number): string {
	const date = new Date(createdAt + 9 * 60 * 60 * 1000);
	const yy = String(date.getUTCFullYear()).slice(-2);
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const min = String(date.getUTCMinutes()).padStart(2, "0");
	return `${yy}/${mm}/${dd}/${hh}:${min}`;
}

function contentTypeLabel(contentType: string | number | undefined, hasContent: boolean | undefined): string {
	switch (contentType) {
		case 1:
		case "IMAGE":
			return "画像";
		case 2:
		case "VIDEO":
			return "動画";
		case 3:
		case "AUDIO":
			return "音声";
		case 7:
		case "STICKER":
			return "スタンプ";
		case 14:
		case "FILE":
			return "ファイル";
		case 15:
		case "LOCATION":
			return "位置情報";
		case 0:
		case "NONE":
		case undefined:
			return hasContent ? "メディア" : "";
		default:
			return `メディア(${String(contentType)})`;
	}
}

function formatContent(payload: SquareHistoryMessagePayload): string {
	const message = payload.squareMessage?.message;
	const text = (message?.text ?? "").replace(/\s+/g, " ").trim();
	const label = contentTypeLabel(message?.contentType, message?.hasContent);
	if (label && text) return `${label} ${text}`;
	if (label) return label;
	return text || "(本文なし)";
}

function logEntryFromEvent(event: SquareHistoryEvent, targetMid: string, filter: string): LogEntry | undefined {
	const payload = event.payload?.receiveMessage ?? event.payload?.sendMessage;
	const message = payload?.squareMessage?.message;
	if (!message || message.from !== targetMid) return undefined;
	const content = formatContent(payload);
	if (filter && !normalizeText(content).includes(normalizeText(filter))) return undefined;
	const createdAt = Number(message.createdTime ?? event.createdTime);
	if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
	return { id: message.id || `${targetMid}:${createdAt}:${content}`, createdAt, content };
}

function eventMembers(event: SquareHistoryEvent): MemberInfo[] {
	const members: MemberInfo[] = [];
	const add = (member: SquareHistoryMember | undefined) => {
		if (member?.squareMemberMid?.startsWith("p") && member.displayName) {
			members.push({ mid: member.squareMemberMid, name: member.displayName });
		}
	};
	add(event.payload?.notifiedCreateSquareMember?.squareMember);
	add(event.payload?.notifiedCreateSquareChatMember?.peerSquareMember);
	add(event.payload?.notifiedJoinSquareChat?.joinedMember);
	add(event.payload?.notifiedLeaveSquareChat?.squareMember);
	add(event.payload?.notifiedUpdateSquareMemberProfile?.squareMember);
	add(event.payload?.notifiedUpdateSquareMember?.squareMember);
	for (const member of event.payload?.notifiedKickoutFromSquare?.kickees ?? []) add(member);

	const messagePayload = event.payload?.receiveMessage ?? event.payload?.sendMessage;
	const messageMid = messagePayload?.squareMessage?.message?.from;
	if (messageMid?.startsWith("p") && messagePayload?.senderDisplayName) {
		members.push({ mid: messageMid, name: messagePayload.senderDisplayName });
	}

	return members;
}

function recordEventNames(destination: LineDestination, events: SquareHistoryEvent[]): void {
	for (const event of events) {
		const createdAt = Number(event.createdTime);
		const seenAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
		for (const member of eventMembers(event)) {
			memberNameHistoryStore.record("square", destination.scopeMid, member.mid, member.name, seenAt);
		}
	}
}

async function searchSquareMembersByName(
	client: Client,
	destination: LineDestination,
	query: string,
): Promise<MemberInfo[]> {
	if (destination.kind !== "square") throw new Error("!logはOpenChatでのみ使用できます");
	const states: SquareMembershipState[] = ["JOINED", "LEFT", "KICK_OUT", "BANNED"];
	const displayNameQueries = [...new Set([
		query,
		normalizeText(query),
		compactSearchText(query),
		query.split(/\s+/)[0] ?? "",
		"",
	].filter((value) => value !== undefined))];
	const found = new Map<string, MemberInfo>();

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
					memberNameHistoryStore.record("square", destination.scopeMid, info.mid, info.name);
					if (looseNameMatches(info.name, query)) found.set(info.mid, info);
				}
				continuationToken = response.continuationToken || undefined;
				if (!continuationToken || response.members.length === 0) break;
			}
		}
		if (found.size > 0) break;
	}

	return [...found.values()]
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

async function resolveMentionedMember(
	client: Client,
	destination: LineDestination,
	mid: string,
): Promise<MemberInfo> {
	const response = await client.base.square.getSquareMember({ squareMemberMid: mid });
	const name = response.squareMember.displayName || "(名前なし)";
	memberNameHistoryStore.record("square", destination.scopeMid, mid, name);
	return { mid, name };
}

async function searchHistoryMembersByName(
	client: Client,
	destination: LineDestination,
	query: string,
): Promise<MemberInfo[]> {
	if (destination.kind !== "square") throw new Error("!logはOpenChatでのみ使用できます");
	const found = new Map<string, MemberInfo>();
	let continuationToken: string | undefined;
	let syncToken: string | undefined;
	const collect = (events: SquareHistoryEvent[]) => {
		recordEventNames(destination, events);
		for (const event of events) {
			for (const member of eventMembers(event)) {
				if (looseNameMatches(member.name, query)) found.set(member.mid, member);
			}
		}
	};

	for (let page = 0; page < 10; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken;
		collect(response.events as SquareHistoryEvent[]);
		if (response.events.length === 0) break;
	}
	if (!syncToken) return [];

	for (let page = 0; page < 120; page++) {
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
		collect(response.events as SquareHistoryEvent[]);
		if (!continuationToken) break;
	}

	return [...found.values()]
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

function uniqueMembers(members: MemberInfo[]): MemberInfo[] {
	const byMid = new Map<string, MemberInfo>();
	for (const member of members) byMid.set(member.mid, member);
	return [...byMid.values()]
		.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.mid.localeCompare(right.mid));
}

async function resolveTarget(
	client: Client,
	destination: LineDestination,
	args: string[],
	mentionedMid?: string,
): Promise<ResolvedTarget | undefined> {
	if (mentionedMid?.startsWith("p")) {
		return {
			member: await resolveMentionedMember(client, destination, mentionedMid),
			filter: args.filter((arg) => !arg.startsWith("@")).join(" ").trim(),
		};
	}

	let ambiguous: MemberInfo[] | undefined;
	for (let split = args.length; split >= 1; split--) {
		const memberQuery = args.slice(0, split).join(" ").trim();
		const filter = args.slice(split).join(" ").trim();
		const members = uniqueMembers([
			...await searchSquareMembersByName(client, destination, memberQuery),
			...await searchHistoryMembersByName(client, destination, memberQuery),
		]);
		if (members.length === 1) return { member: members[0], filter };
		if (members.length > 1 && !ambiguous) ambiguous = members;
	}

	if (ambiguous) return { member: ambiguous[0], filter: "", ambiguous };
	return undefined;
}

async function collectMemberLogs(
	client: Client,
	destination: LineDestination,
	targetMid: string,
	filter: string,
): Promise<LogEntry[]> {
	let continuationToken: string | undefined;
	let syncToken: string | undefined;
	const rows: LogEntry[] = [];
	const seenMessageIds = new Set<string>();
	const addEntry = (entry: LogEntry | undefined): void => {
		if (!entry || seenMessageIds.has(entry.id)) return;
		seenMessageIds.add(entry.id);
		rows.push(entry);
	};

	for (let page = 0; page < 10; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken;
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		for (const event of response.events as SquareHistoryEvent[]) {
			addEntry(logEntryFromEvent(event, targetMid, filter));
		}
		if (response.events.length === 0 || rows.length >= MAX_LOG_ROWS) break;
	}
	if (!syncToken || rows.length >= MAX_LOG_ROWS) return rows.slice(0, MAX_LOG_ROWS);

	for (let page = 0; page < 120 && rows.length < MAX_LOG_ROWS; page++) {
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
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		for (const event of response.events as SquareHistoryEvent[]) {
			addEntry(logEntryFromEvent(event, targetMid, filter));
			if (rows.length >= MAX_LOG_ROWS) break;
		}
		if (!continuationToken) break;
	}

	return rows
		.sort((left, right) => right.createdAt - left.createdAt)
		.slice(0, MAX_LOG_ROWS);
}

async function scanNamesFromHistory(
	client: Client,
	destination: LineDestination,
	targetMid: string,
): Promise<void> {
	let continuationToken: string | undefined;
	let syncToken: string | undefined;

	for (let page = 0; page < 10; page++) {
		const response = await fetchSquareChatEvents(client, {
			squareChatMid: destination.chatMid,
			syncToken,
			limit: 100,
			direction: "FORWARD",
			fetchType: "DEFAULT",
		});
		syncToken = response.syncToken;
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		if (response.events.length === 0) break;
	}
	if (!syncToken) return;

	for (let page = 0; page < 120; page++) {
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
		recordEventNames(destination, response.events as SquareHistoryEvent[]);
		if (response.events.some((event) => eventMembers(event).some((member) => member.mid === targetMid))) {
			// Continue scanning; the same user may have older names.
		}
		if (!continuationToken) break;
	}
}

function formatLogRows(rows: LogEntry[]): string[] {
	return rows.map((row) => `${formatLogTime(row.createdAt)}:${row.content}`);
}

function formatNameHistoryRows(entries: ReturnType<typeof memberNameHistoryStore.get>): string[] {
	return entries.map((entry) => {
		const first = formatLogTime(Date.parse(entry.firstSeenAt));
		const last = formatLogTime(Date.parse(entry.lastSeenAt));
		return `${entry.name}\n初回: ${first}\n最終: ${last}\n確認: ${entry.count}回`;
	});
}

export const logCommand: LineCommand = {
	name: "log",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.send([
				"!log <メンバー名>",
				"  その人の発言履歴を直近1000件まで表示します。",
				"!log <メンバー名> <検索語>",
				"  その人の発言から検索語を含むものだけ表示します。",
				"!log name <メンバー名>",
				"  保存済みの過去の名前を表示します。",
			].join("\n"));
			return;
		}

		if (message.destination.kind !== "square") {
			await message.send("!logはOpenChatでのみ使用できます。");
			return;
		}

		const mode = args[0]?.toLowerCase() === "name" ? "name" : "message";
		const targetArgs = mode === "name" ? args.slice(1) : args;
		const mentionedMid = message.mentionMids[0];
		let target: MemberInfo | undefined;
		let filter = "";
		let ambiguous: MemberInfo[] | undefined;

		if (mode === "name" && targetArgs.length === 0 && !mentionedMid) {
			target = {
				mid: message.destination.senderMid,
				name: message.destination.senderName || message.destination.senderMid,
			};
			memberNameHistoryStore.record("square", message.destination.scopeMid, target.mid, target.name);
		} else {
			const resolved = await resolveTarget(message.client, message.destination, targetArgs, mentionedMid);
			target = resolved?.member;
			filter = resolved?.filter ?? "";
			ambiguous = resolved?.ambiguous;
		}

		if (ambiguous && ambiguous.length > 1) {
			await sendSearchResults(
				message,
				"対象候補",
				ambiguous.map((member) => `${member.name}\nMID: ${member.mid}`),
				LOG_PAGE_SIZE,
			);
			return;
		}

		if (!target) {
			await message.send("対象メンバーが見つかりませんでした。");
			return;
		}

		if (mode === "name") {
			await scanNamesFromHistory(message.client, message.destination, target.mid);
			await memberNameHistoryStore.flush();
			const entries = memberNameHistoryStore.get("square", message.destination.scopeMid, target.mid);
			if (entries.length === 0) {
				await message.send(`${target.name}\n過去の名前はまだ保存されていません。`);
				return;
			}
			await sendSearchResults(
				message,
				`${target.name} 名前履歴`,
				formatNameHistoryRows(entries),
				LOG_PAGE_SIZE,
			);
			return;
		}

		const rows = await collectMemberLogs(message.client, message.destination, target.mid, filter);
		if (rows.length === 0) {
			await message.send(filter
				? `${target.name} の「${filter}」を含む発言は見つかりませんでした。`
				: `${target.name} の発言履歴がありません。`);
			return;
		}

		await memberNameHistoryStore.flush();
		await sendSearchResults(
			message,
			filter ? `${target.name} log "${filter}"` : `${target.name} log`,
			formatLogRows(rows),
			LOG_PAGE_SIZE,
		);
	},
};
