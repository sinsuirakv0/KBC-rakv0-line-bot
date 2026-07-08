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
	threadLines: string[];
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
	return String(raw?.type ?? "(type none)");
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
		text: text && text.length > 120 ? `${text.slice(0, 119)}...` : text,
		payloadThreadMid: rawString(raw?.threadMid),
		rawThreadMid: rawString(threadInfo?.chatThreadMid),
		threadRootMessageId: rawString(raw?.threadRootMessageId),
	};
}

function threadSummary(source: string, value: unknown): string | undefined {
	const raw = rawObject(value);
	if (!raw) return undefined;
	const squareThread = rawObject(raw.squareThread);
	const threadMember = rawObject(raw.threadMember);
	const threadRootMessage = rawObject(raw.threadRootMessage);
	const rootMessage = rawObject(threadRootMessage?.message);
	const threadMid = rawString(raw.threadMid) ?? rawString(squareThread?.threadMid) ?? rawString(threadMember?.threadMid);
	const chatMid = rawString(raw.chatMid) ?? rawString(squareThread?.chatMid) ?? rawString(threadMember?.chatMid);
	const state = squareThread?.state === undefined ? undefined : String(squareThread.state);
	const memberState = threadMember?.membershipState === undefined ? undefined : String(threadMember.membershipState);
	const rootId = rawString(raw.threadRootMessageId) ?? rawString(rootMessage?.id) ?? rawString(squareThread?.messageId);
	if (!threadMid && !chatMid && !state && !memberState && !rootId && !source.toLowerCase().includes("thread")) {
		return undefined;
	}
	const parts = [
		`source=${source}`,
		`threadMid=${threadMid ?? "(none)"}`,
		`chatMid=${chatMid ?? "(none)"}`,
		`state=${state ?? "(none)"}`,
		`memberState=${memberState ?? "(none)"}`,
		`rootId=${rootId ?? "(none)"}`,
	];
	return parts.join(" ");
}

export function recordSquareEventDebug(event: unknown): void {
	const payload = eventPayload(event);
	const messages = Object.entries(payload).flatMap(([key, value]) => {
		const summary = messageSummary(key, value);
		return summary ? [summary] : [];
	});
	const threadLines = Object.entries(payload).flatMap(([key, value]) => {
		const summary = threadSummary(key, value);
		return summary ? [summary] : [];
	});
	records.push({
		receivedAt: new Date().toISOString(),
		type: eventType(event),
		payloadKeys: Object.keys(payload).filter((key) => payload[key] !== undefined),
		messages,
		threadLines,
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
		for (const line of record.threadLines) lines.push(line);
	}
	return lines.join("\n");
}
