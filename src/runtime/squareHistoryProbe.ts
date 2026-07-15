import type { Client } from "@evex/linejs";

interface FetchSquareChatEventsOptions {
	squareChatMid: string;
	limit: number;
	direction: "FORWARD" | "BACKWARD";
	fetchType: "DEFAULT";
}

interface SquareHistoryResponse {
	events?: unknown[];
	syncToken?: string;
	continuationToken?: string;
}

const EVENT_TYPE_NAMES: Record<number, string> = {
	0: "RECEIVE_MESSAGE",
	1: "SEND_MESSAGE",
	2: "NOTIFIED_JOIN_SQUARE_CHAT",
	3: "NOTIFIED_INVITE_INTO_SQUARE_CHAT",
	4: "NOTIFIED_LEAVE_SQUARE_CHAT",
	5: "NOTIFIED_DESTROY_MESSAGE",
	6: "NOTIFIED_MARK_AS_READ",
	7: "NOTIFIED_UPDATE_SQUARE_MEMBER_PROFILE",
	8: "NOTIFIED_UPDATE_SQUARE",
	9: "NOTIFIED_UPDATE_SQUARE_STATUS",
	10: "NOTIFIED_UPDATE_SQUARE_AUTHORITY",
	11: "NOTIFIED_UPDATE_SQUARE_MEMBER",
	12: "NOTIFIED_UPDATE_SQUARE_CHAT",
	13: "NOTIFIED_UPDATE_SQUARE_CHAT_STATUS",
	14: "NOTIFIED_UPDATE_SQUARE_CHAT_MEMBER",
	15: "NOTIFIED_CREATE_SQUARE_MEMBER",
	16: "NOTIFIED_CREATE_SQUARE_CHAT_MEMBER",
	17: "NOTIFIED_UPDATE_SQUARE_MEMBER_RELATION",
	18: "NOTIFIED_SHUTDOWN_SQUARE",
	19: "NOTIFIED_KICKOUT_FROM_SQUARE",
	20: "NOTIFIED_DELETE_SQUARE_CHAT",
	21: "NOTIFICATION_JOIN_REQUEST",
	22: "NOTIFICATION_JOINED",
	23: "NOTIFICATION_PROMOTED_COADMIN",
	24: "NOTIFICATION_PROMOTED_ADMIN",
	25: "NOTIFICATION_DEMOTED_MEMBER",
	26: "NOTIFICATION_KICKED_OUT",
	27: "NOTIFICATION_SQUARE_DELETE",
	28: "NOTIFICATION_SQUARE_CHAT_DELETE",
	29: "NOTIFICATION_MESSAGE",
	30: "NOTIFIED_UPDATE_SQUARE_CHAT_PROFILE_NAME",
	31: "NOTIFIED_UPDATE_SQUARE_CHAT_PROFILE_IMAGE",
	32: "NOTIFIED_UPDATE_SQUARE_FEATURE_SET",
	33: "NOTIFIED_ADD_BOT",
	34: "NOTIFIED_REMOVE_BOT",
	36: "NOTIFIED_UPDATE_SQUARE_NOTE_STATUS",
	37: "NOTIFIED_UPDATE_SQUARE_CHAT_ANNOUNCEMENT",
	38: "NOTIFIED_UPDATE_SQUARE_CHAT_MAX_MEMBER_COUNT",
	39: "NOTIFICATION_POST_ANNOUNCEMENT",
	40: "NOTIFICATION_POST",
	41: "MUTATE_MESSAGE",
	42: "NOTIFICATION_NEW_CHAT_MEMBER",
	43: "NOTIFIED_UPDATE_READONLY_CHAT",
	46: "NOTIFIED_UPDATE_MESSAGE_STATUS",
	47: "NOTIFICATION_MESSAGE_REACTION",
	48: "NOTIFIED_CHAT_POPUP",
	49: "NOTIFIED_SYSTEM_MESSAGE",
	50: "NOTIFIED_UPDATE_SQUARE_CHAT_FEATURE_SET",
	51: "NOTIFIED_UPDATE_LIVE_TALK",
	52: "NOTIFICATION_LIVE_TALK",
	53: "NOTIFIED_UPDATE_LIVE_TALK_INFO",
	54: "NOTIFICATION_THREAD_MESSAGE",
	55: "NOTIFICATION_THREAD_MESSAGE_REACTION",
	56: "NOTIFIED_UPDATE_THREAD",
	57: "NOTIFIED_UPDATE_THREAD_STATUS",
	58: "NOTIFIED_UPDATE_THREAD_MEMBER",
	59: "NOTIFIED_UPDATE_THREAD_ROOT_MESSAGE",
	60: "NOTIFIED_UPDATE_THREAD_ROOT_MESSAGE_STATUS",
	61: "NOTIFIED_CREATE_SQUARE_SUBSCRIPTION",
	62: "NOTIFIED_UPDATE_SQUARE_SUBSCRIPTION",
};

function rawObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function serializableJson(value: unknown, spacing?: number): string {
	return JSON.stringify(value, (_key, item: unknown) => (
		typeof item === "bigint" ? item.toString() : item
	), spacing);
}

function eventTypeLabel(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return `${EVENT_TYPE_NAMES[value] ?? "UNKNOWN"}(${value})`;
	return "UNKNOWN";
}

function eventCreatedAt(value: unknown): string {
	const raw = typeof value === "bigint" || typeof value === "number" || typeof value === "string"
		? Number(value)
		: Number.NaN;
	return Number.isFinite(raw) ? new Date(raw).toISOString() : "(none)";
}

function payloadPreview(value: unknown): string {
	const json = serializableJson(value);
	if (json.length <= 500) return json;
	return `${json.slice(0, 499)}...`;
}

function formatEvent(event: unknown, index: number): string[] {
	const raw = rawObject(event) ?? {};
	const payload = rawObject(raw.payload) ?? {};
	const systemMessage = rawObject(payload.notifiedSystemMessage);
	const lines = [
		`${index}. ${eventCreatedAt(raw.createdTime)} type=${eventTypeLabel(raw.type)}`,
		`payload=${Object.keys(payload).filter((key) => payload[key] !== undefined).join(",") || "(none)"}`,
	];
	if (systemMessage) {
		lines.push(`system.chatMid=${rawString(systemMessage.squareChatMid) ?? "(none)"}`);
		lines.push(`system.messageKey=${rawString(systemMessage.messageKey) ?? "(none)"}`);
		lines.push(`system.text=${rawString(systemMessage.text) ?? "(none)"}`);
	} else {
		lines.push(`data=${payloadPreview(payload)}`);
	}
	return lines;
}

export interface SquareHistoryProbeResult {
	text: string;
	eventCount: number;
	systemMessageCount: number;
}

export async function probeRecentSquareHistory(
	client: Client,
	squareChatMid: string,
	limit = 10,
): Promise<SquareHistoryProbeResult> {
	const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 30);
	const startedAt = Date.now();
	const options: FetchSquareChatEventsOptions = {
		squareChatMid,
		limit: safeLimit,
		direction: "FORWARD",
		fetchType: "DEFAULT",
	};
	const response = await client.base.square.fetchSquareChatEvents(options as never) as SquareHistoryResponse;
	const events = Array.isArray(response.events) ? response.events.slice(-safeLimit) : [];
	const systemMessageCount = events.filter((event) => {
		const raw = rawObject(event);
		const payload = rawObject(raw?.payload);
		return payload?.notifiedSystemMessage !== undefined || raw?.type === 49 || raw?.type === "NOTIFIED_SYSTEM_MESSAGE";
	}).length;

	console.log("[test-square-history]", serializableJson({
		at: new Date().toISOString(),
		durationMs: Date.now() - startedAt,
		request: options,
		response: {
			syncToken: response.syncToken,
			continuationToken: response.continuationToken,
			eventCount: events.length,
			events,
		},
	}, 2));

	const lines = [
		"Square履歴取得テスト",
		`対象トーク: ${squareChatMid}`,
		`取得件数: ${events.length}/${safeLimit}`,
		`システムメッセージ: ${systemMessageCount}件`,
		`処理時間: ${Date.now() - startedAt}ms`,
		"完全な生データ: サーバーログ [test-square-history]",
	];
	if (events.length === 0) {
		lines.push("", "イベントは返りませんでした。");
	} else {
		for (const [index, event] of events.entries()) {
			lines.push("", ...formatEvent(event, index + 1));
		}
	}
	return {
		text: lines.join("\n"),
		eventCount: events.length,
		systemMessageCount,
	};
}
