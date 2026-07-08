import type { TimeBlock } from "./shared.js";
import { formatDateFull, formatDateShort, formatTimeBlock, parseDate } from "./shared.js";

export interface EventHeader {
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	minVersion: string;
	maxVersion: string;
}

export function isPermanentEvent(header: EventHeader): boolean {
	return header.endDate === "20300101";
}

export function formatEventStatus(header: EventHeader, now = new Date()): string {
	const start = parseDate(header.startDate, header.startTime);
	if (now < start) return "予定";
	if (isPermanentEvent(header)) return "常設";
	const end = parseDate(header.endDate, header.endTime);
	if (now < end) return "開催中";
	return "終了";
}

export function formatEventPeriod(header: EventHeader): string {
	const start = parseDate(header.startDate, header.startTime);
	const end = isPermanentEvent(header) ? null : parseDate(header.endDate, header.endTime);
	return `${formatDateFull(start)} ~ ${end ? formatDateFull(end) : "常設"}`;
}

export function formatEventPeriodShort(header: EventHeader): string {
	const start = parseDate(header.startDate, header.startTime);
	const end = isPermanentEvent(header) ? null : parseDate(header.endDate, header.endTime);
	return `${formatDateShort(start)} ~ ${end ? formatDateShort(end) : "常設"}`;
}

export function formatVersionRange(header: EventHeader): string {
	return `ver.${header.minVersion}~${header.maxVersion}`;
}

export function formatTimeBlockLines(timeBlocks: TimeBlock[]): string[] {
	if (timeBlocks.length === 0) return ["常時開催"];
	return timeBlocks.map((block) => formatTimeBlock(block));
}

export function cleanDetailLines(value: string | undefined): string[] {
	return (value ?? "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function formatAmount(amount: number): string {
	return amount > 0 ? ` x${amount}` : "";
}

export function formatIdBand(id: number): string {
	if (!Number.isFinite(id)) return "不明";
	if (id < 0) return "特殊ID";
	if (id < 1_000) return "0~999";
	const width = id < 10_000 ? 1_000 : 10_000;
	const start = Math.floor(id / width) * width;
	const end = start + width - 1;
	return `${start}~${end}`;
}

export function compactLine(value: string, maxLength = 80): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1)}…`;
}

export function joinBlocks(blocks: string[][]): string {
	return blocks
		.map((block) => block.filter((line) => line.trim().length > 0).join("\n"))
		.filter(Boolean)
		.join("\n\n");
}
