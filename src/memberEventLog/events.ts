export type MemberEventType = "join" | "leave" | "kick";
export type MemberEventScope = "square" | "chat";

export interface MemberEventFallback {
	chatMid?: string;
	scopeMid?: string;
}

export interface ParsedMemberEvent {
	type: MemberEventType;
	scope: MemberEventScope;
	at: number;
	chatMid: string;
	scopeMid: string;
	mid: string;
	name?: string;
}

interface RawMember {
	mid?: string;
	squareMid?: string;
	name?: string;
	state?: unknown;
	createdAt?: number;
}

const EVENT_TYPES = {
	joinChat: ["NOTIFIED_JOIN_SQUARE_CHAT", 2],
	leaveChat: ["NOTIFIED_LEAVE_SQUARE_CHAT", 4],
	updateSquareMember: ["NOTIFIED_UPDATE_SQUARE_MEMBER", 11],
	updateChatMember: ["NOTIFIED_UPDATE_SQUARE_CHAT_MEMBER", 14],
	createSquareMember: ["NOTIFIED_CREATE_SQUARE_MEMBER", 15],
	createChatMember: ["NOTIFIED_CREATE_SQUARE_CHAT_MEMBER", 16],
	kick: ["NOTIFIED_KICKOUT_FROM_SQUARE", 19],
} as const;

function rawObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function cleanName(value: unknown): string | undefined {
	const name = rawString(value);
	if (!name || /^p[0-9a-f]{8,}$/i.test(name)) return undefined;
	if (["(名前なし)", "名前なし", "名前不明", "(取得失敗)", "取得失敗"].includes(name)) return undefined;
	if (/^[\p{C}\s]+$/u.test(name)) return undefined;
	return name;
}

function rawMember(value: unknown): RawMember {
	const member = rawObject(value);
	return {
		mid: rawString(member?.squareMemberMid),
		squareMid: rawString(member?.squareMid),
		name: cleanName(member?.displayName),
		state: member?.membershipState,
		createdAt: rawNumber(member?.createdAt),
	};
}

function notificationText(payload: Record<string, unknown>): string | undefined {
	const notification = rawObject(payload.notificationMessage);
	const squareMessage = rawObject(notification?.squareMessage);
	const message = rawObject(squareMessage?.message);
	return rawString(message?.text)?.replace(/\s+/g, " ");
}

function leaveNameFromNotification(payload: Record<string, unknown>): string | undefined {
	const text = notificationText(payload);
	if (!text) return undefined;
	const patterns = [
		/^(.+?)(?:さん)?が(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?)(?:さん)?が(?:トーク|OpenChat|オープンチャット)から(?:退会|退出|退室)しました[。.]?$/,
		/^(.+?) left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
		/^(.+?) has left (?:the )?(?:chat|openchat|open chat)[.]?$/i,
	];
	for (const pattern of patterns) {
		const name = cleanName(text.match(pattern)?.[1]);
		if (name) return name;
	}
	return undefined;
}

function isType(value: unknown, expected: readonly [string, number]): boolean {
	return value === expected[0] || value === expected[1] || String(value) === String(expected[1]);
}

function normalizedState(value: unknown): string {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") return String(value);
	return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isSquareJoined(value: unknown): boolean {
	const state = normalizedState(value);
	return state === "JOINED" || state === "2";
}

function isSquareLeft(value: unknown): boolean {
	const state = normalizedState(value);
	return state === "LEFT" || state === "4";
}

function isChatJoined(value: unknown): boolean {
	const state = normalizedState(value);
	return state === "JOINED" || state === "1";
}

function isChatLeft(value: unknown): boolean {
	const state = normalizedState(value);
	return state === "LEFT" || state === "2";
}

function eventKey(event: ParsedMemberEvent): string {
	return `${event.type}:${event.scope}:${event.chatMid}:${event.at}:${event.mid}`;
}

export function extractMemberEvents(
	value: unknown,
	fallback: MemberEventFallback = {},
): ParsedMemberEvent[] {
	const event = rawObject(value);
	const payload = rawObject(event?.payload);
	if (!event || !payload) return [];
	const type = event.type;
	const at = rawNumber(event.createdTime) ?? Date.now();
	const found = new Map<string, ParsedMemberEvent>();

	const add = (
		eventType: MemberEventType,
		eventScope: MemberEventScope,
		member: RawMember,
		overrides: { chatMid?: string; scopeMid?: string; mid?: string; name?: string } = {},
	) => {
		const mid = overrides.mid ?? member.mid;
		const scopeMid = overrides.scopeMid ?? member.squareMid ?? fallback.scopeMid;
		const chatMid = eventScope === "square"
			? scopeMid
			: overrides.chatMid ?? fallback.chatMid;
		if (!mid?.startsWith("p") || !scopeMid || !chatMid) return;
		const parsed: ParsedMemberEvent = {
			type: eventType,
			scope: eventScope,
			at,
			chatMid,
			scopeMid,
			mid,
			name: overrides.name ?? member.name,
		};
		const key = eventKey(parsed);
		const existing = found.get(key);
		if (!existing || (!existing.name && parsed.name)) found.set(key, parsed);
	};

	if (isType(type, EVENT_TYPES.createSquareMember)) {
		const body = rawObject(payload.notifiedCreateSquareMember);
		add("join", "square", rawMember(body?.squareMember));
	}

	if (isType(type, EVENT_TYPES.createChatMember)) {
		const body = rawObject(payload.notifiedCreateSquareChatMember);
		const chat = rawObject(body?.chat);
		const chatMember = rawObject(body?.chatMember);
		const member = rawMember(body?.peerSquareMember);
		add("join", "chat", member, {
			chatMid: rawString(chat?.squareChatMid) ?? rawString(chatMember?.squareChatMid),
			scopeMid: rawString(chat?.squareMid),
			mid: rawString(chatMember?.squareMemberMid),
		});
	}

	if (isType(type, EVENT_TYPES.joinChat)) {
		const body = rawObject(payload.notifiedJoinSquareChat);
		add("join", "chat", rawMember(body?.joinedMember), {
			chatMid: rawString(body?.squareChatMid),
		});
	}

	if (isType(type, EVENT_TYPES.leaveChat)) {
		const body = rawObject(payload.notifiedLeaveSquareChat);
		const member = rawMember(body?.squareMember);
		add("leave", "chat", member, {
			chatMid: rawString(body?.squareChatMid),
			mid: rawString(body?.squareMemberMid),
			name: member.name ?? leaveNameFromNotification(payload),
		});
	}

	if (isType(type, EVENT_TYPES.updateSquareMember)) {
		const body = rawObject(payload.notifiedUpdateSquareMember);
		const member = rawMember(body?.squareMember);
		const resolved = {
			scopeMid: rawString(body?.squareMid),
			mid: rawString(body?.squareMemberMid),
		};
		if (isSquareJoined(member.state)) add("join", "square", member, resolved);
		if (isSquareLeft(member.state)) add("leave", "square", member, resolved);
	}

	if (isType(type, EVENT_TYPES.updateChatMember)) {
		const body = rawObject(payload.notifiedUpdateSquareChatMember);
		const chatMember = rawObject(body?.squareChatMember) ?? rawObject(body?.chatMember);
		const member: RawMember = {
			mid: rawString(chatMember?.squareMemberMid),
			squareMid: rawString(body?.squareMid),
			state: chatMember?.membershipState,
		};
		const resolved = {
			chatMid: rawString(body?.squareChatMid) ?? rawString(chatMember?.squareChatMid),
		};
		if (isChatJoined(member.state)) add("join", "chat", member, resolved);
		if (isChatLeft(member.state)) add("leave", "chat", member, resolved);
	}

	if (isType(type, EVENT_TYPES.kick)) {
		const body = rawObject(payload.notifiedKickoutFromSquare);
		const chatMid = rawString(body?.squareChatMid);
		const kicker = rawMember(body?.kicker);
		const kickees = Array.isArray(body?.kickees) ? body.kickees : [];
		for (const kickee of kickees) {
			const member = rawMember(kickee);
			add("kick", "square", member, {
				chatMid,
				scopeMid: member.squareMid ?? kicker.squareMid,
			});
		}
	}

	return [...found.values()];
}

export function memberEventIdentityKey(
	event: Pick<ParsedMemberEvent, "type" | "scope" | "at" | "mid">,
): string {
	return `${event.type}:${event.scope}:${event.at}:${event.mid}`;
}
