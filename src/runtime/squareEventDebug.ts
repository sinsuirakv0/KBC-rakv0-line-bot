interface SquareEventDebugMessage {
	source: string;
	messageId?: string;
	from?: string;
	to?: string;
	toType?: string;
	text?: string;
	payloadThreadMid?: string;
	rawThreadMid?: string;
	threadRootMessageId?: string;
}

interface SquareEventDebugRecord {
	receivedAt: string;
	type: string;
	payloadKeys: string[];
	messages: SquareEventDebugMessage[];
}

const MAX_RECORDS = 80;
const records: SquareEventDebugRecord[] = [];

function rawObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function eventType(value: unknown): string {
	const raw = rawObject(value);
	return String(raw?.type ?? "(typeなし)");
}

function eventPayload(value: unknown): Record<string, unknown> {
	return rawObject(rawObject(value)?.payload) ?? {};
}

function messageSummary(source: string, value: unknown): SquareEventDebugMessage | undefined {
	const raw = rawObject(value);
	const squareMessage = rawObject(raw?.squareMessage);
	const message = rawObject(squareMessage?.message);
	if (!message) return undefined;
	const threadInfo = rawObject(squareMessage?.threadInfo);
	const text = rawString(message.text);
	return {
		source,
		messageId: rawString(message.id),
		from: rawString(message.from),
		to: rawString(message.to),
		toType: message.toType === undefined ? undefined : String(message.toType),
		text: text && text.length > 120 ? `${text.slice(0, 119)}…` : text,
		payloadThreadMid: rawString(raw?.threadMid),
		rawThreadMid: rawString(threadInfo?.chatThreadMid),
		threadRootMessageId: rawString(raw?.threadRootMessageId),
	};
}

export function recordSquareEventDebug(event: unknown): void {
	const payload = eventPayload(event);
	const messages = Object.entries(payload).flatMap(([key, value]) => {
		const summary = messageSummary(key, value);
		return summary ? [summary] : [];
	});
	records.push({
		receivedAt: new Date().toISOString(),
		type: eventType(event),
		payloadKeys: Object.keys(payload).filter((key) => payload[key] !== undefined),
		messages,
	});
	while (records.length > MAX_RECORDS) records.shift();
}

export function formatSquareEventDebugLog(limit = 12): string {
	const recent = records.slice(-Math.max(1, limit));
	if (recent.length === 0) return "Square event debug log: empty";
	const lines = [`Square event debug log: latest ${recent.length}/${records.length}`];
	for (const record of recent) {
		lines.push("");
		lines.push(`${record.receivedAt} type=${record.type}`);
		lines.push(`payload=${record.payloadKeys.join(",") || "(none)"}`);
		if (record.messages.length === 0) continue;
		for (const message of record.messages) {
			lines.push(
				[
					`source=${message.source}`,
					`id=${message.messageId ?? "(none)"}`,
					`from=${message.from ?? "(none)"}`,
					`to=${message.to ?? "(none)"}`,
					`toType=${message.toType ?? "(none)"}`,
					`payloadThread=${message.payloadThreadMid ?? "(none)"}`,
					`rawThread=${message.rawThreadMid ?? "(none)"}`,
					`root=${message.threadRootMessageId ?? "(none)"}`,
				].join(" "),
			);
			if (message.text) lines.push(`text=${message.text}`);
		}
	}
	return lines.join("\n");
}
