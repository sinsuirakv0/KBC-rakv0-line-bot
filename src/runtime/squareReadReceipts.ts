export interface SquareReadReceipt {
	receivedAt: number;
	eventCreatedAt?: number;
	squareChatMid: string;
	memberMid: string;
	messageId: string;
}

export interface SquareReadReceiptFilter {
	squareChatMid: string;
	messageId: string;
	sinceReceivedAt?: number;
	untilReceivedAt?: number;
}

const MAX_RECEIPTS = 2_000;
export const SQUARE_READ_RECEIPT_RETENTION_MS = 60_000;

const receipts: SquareReadReceipt[] = [];

function rawObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawTime(value: unknown): number | undefined {
	if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") return undefined;
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : undefined;
}

function isReadEventType(value: unknown): boolean {
	return value === 6 || value === 6n || value === "6" || value === "NOTIFIED_MARK_AS_READ";
}

function cleanup(now = Date.now()): void {
	const expiresBefore = now - SQUARE_READ_RECEIPT_RETENTION_MS;
	while (receipts.length > 0 && receipts[0]!.receivedAt < expiresBefore) receipts.shift();
	while (receipts.length > MAX_RECEIPTS) receipts.shift();
}

export function recordSquareReadReceiptFromEvent(event: unknown, receivedAt = Date.now()): SquareReadReceipt | undefined {
	const raw = rawObject(event);
	if (!raw || !isReadEventType(raw.type)) return undefined;
	const payload = rawObject(raw.payload);
	const read = rawObject(payload?.notifiedMarkAsRead);
	const squareChatMid = rawString(read?.squareChatMid);
	const memberMid = rawString(read?.sMemberMid) ?? rawString(read?.squareMemberMid) ?? rawString(read?.memberMid);
	const messageId = rawString(read?.messageId);
	if (!squareChatMid || !memberMid || !messageId) return undefined;
	const receipt: SquareReadReceipt = {
		receivedAt,
		eventCreatedAt: rawTime(raw.createdTime),
		squareChatMid,
		memberMid,
		messageId,
	};
	receipts.push(receipt);
	cleanup(receivedAt);
	return receipt;
}

export function listSquareReadReceipts(filter: SquareReadReceiptFilter, now = Date.now()): SquareReadReceipt[] {
	cleanup(now);
	return receipts.filter((receipt) =>
		receipt.squareChatMid === filter.squareChatMid &&
		receipt.messageId === filter.messageId &&
		(filter.sinceReceivedAt === undefined || receipt.receivedAt >= filter.sinceReceivedAt) &&
		(filter.untilReceivedAt === undefined || receipt.receivedAt <= filter.untilReceivedAt)
	);
}

export function uniqueSquareReadReceipts(receiptList: SquareReadReceipt[]): SquareReadReceipt[] {
	const byMember = new Map<string, SquareReadReceipt>();
	for (const receipt of receiptList) {
		const existing = byMember.get(receipt.memberMid);
		if (!existing || receipt.receivedAt >= existing.receivedAt) byMember.set(receipt.memberMid, receipt);
	}
	return [...byMember.values()]
		.sort((left, right) => left.receivedAt - right.receivedAt || left.memberMid.localeCompare(right.memberMid));
}

export function squareReadReceiptSnapshot(): { count: number; oldestAt?: number; newestAt?: number } {
	cleanup();
	return {
		count: receipts.length,
		oldestAt: receipts[0]?.receivedAt,
		newestAt: receipts.at(-1)?.receivedAt,
	};
}

export function clearSquareReadReceiptsForTest(): void {
	receipts.splice(0, receipts.length);
}
