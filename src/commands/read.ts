import type { LineCommand, ReplyableLineMessage } from "./shared.js";
import { memberNameHistoryStore } from "../nameHistory/store.js";
import {
	listSquareReadReceipts,
	uniqueSquareReadReceipts,
	type SquareReadReceipt,
} from "../runtime/squareReadReceipts.js";

const WATCH_MS = 2_000;
const DISPLAY_LIMIT = 30;

interface ReadTarget {
	label: string;
	messageId: string;
}

function helpText(): string {
	return [
		"!read",
		"  このコマンドに2秒以内についた既読MIDを表示",
		"!read reply",
		"  返信先メッセージの既読MIDを表示",
		"!read msg:<messageId>",
		"  指定メッセージIDの既読MIDを表示",
		"",
		"取れるのはbotが最近受信したOC既読イベントだけです。",
	].join("\n");
}

function isHelpArg(value: string | undefined): boolean {
	const normalized = value?.toLowerCase();
	return normalized === "help" || normalized === "h" || normalized === "?";
}

function messageIdArg(args: string[]): string | undefined {
	for (const arg of args) {
		const match = arg.match(/^msg(?:id)?:(.+)$/i);
		const value = match?.[1]?.trim();
		if (value) return value;
	}
	return undefined;
}

function resolveTarget(message: ReplyableLineMessage, args: string[]): ReadTarget | undefined {
	const mode = args[0]?.toLowerCase();
	const explicitMessageId = messageIdArg(args);
	if (explicitMessageId) {
		return { label: `指定メッセージ ${explicitMessageId}`, messageId: explicitMessageId };
	}
	if (mode === "reply" || mode === "rep" || mode === "r") {
		return message.replyToMessageId
			? { label: `返信先 ${message.replyToMessageId}`, messageId: message.replyToMessageId }
			: undefined;
	}
	return message.sourceMessageId
		? { label: `このコマンド ${message.sourceMessageId}`, messageId: message.sourceMessageId }
		: undefined;
}

async function resolveMemberName(message: ReplyableLineMessage, memberMid: string): Promise<string> {
	const historyName = memberNameHistoryStore.get("square", message.destination.scopeMid, memberMid)[0]?.name;
	if (historyName) return historyName;
	try {
		const response = await message.client.base.square.getSquareMember({ squareMemberMid: memberMid });
		const name = response.squareMember.displayName?.trim();
		if (name) {
			memberNameHistoryStore.record("square", message.destination.scopeMid, memberMid, name);
			return name;
		}
	} catch (error) {
		console.warn("[read] failed to resolve square member", { memberMid, error });
	}
	return "名前不明";
}

function receiptAge(receipt: SquareReadReceipt, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - receipt.receivedAt) / 1000));
	return `${seconds}秒前`;
}

async function formatReadResult(
	message: ReplyableLineMessage,
	target: ReadTarget,
	startedAt: number,
): Promise<string> {
	const receipts = uniqueSquareReadReceipts(listSquareReadReceipts({
		squareChatMid: message.destination.chatMid,
		messageId: target.messageId,
		sinceReceivedAt: startedAt,
		untilReceivedAt: startedAt + WATCH_MS,
	}));
	const lines = [
		"既読MID確認",
		`対象: ${target.label}`,
		`取得範囲: 実行後${Math.round(WATCH_MS / 1000)}秒間にbotが受信した既読イベント`,
		`人数: ${receipts.length}`,
	];
	if (receipts.length === 0) {
		lines.push("", "既読イベントは見つかりませんでした。");
		lines.push("既読者がいない、またはLINE側がこのイベントをbotへ配信していない可能性があります。");
		return lines.join("\n");
	}

	lines.push("");
	for (const [index, receipt] of receipts.slice(0, DISPLAY_LIMIT).entries()) {
		const name = await resolveMemberName(message, receipt.memberMid);
		lines.push(`${index + 1}. ${name}`);
		lines.push(`MID: ${receipt.memberMid}`);
		lines.push(`受信: ${receiptAge(receipt)}`);
	}
	if (receipts.length > DISPLAY_LIMIT) {
		lines.push(`他 ${receipts.length - DISPLAY_LIMIT}人`);
	}
	return lines.join("\n");
}

function scheduleReadResult(message: ReplyableLineMessage, target: ReadTarget, startedAt: number): void {
	const timer = setTimeout(() => {
		void (async () => {
			await message.send(await formatReadResult(message, target, startedAt));
		})().catch((error) => {
			console.error("[read] scheduled read receipt report failed", error);
		});
	}, WATCH_MS + 250);
	timer.unref();
}

export const readCommand: LineCommand = {
	name: "read",
	aliases: ["kidoku"],
	policy: { progress: "none" },
	async execute({ message, args }) {
		if (isHelpArg(args[0])) {
			await message.send(helpText());
			return;
		}
		if (message.destination.kind !== "square") {
			await message.send("!read はOpenChat専用です。");
			return;
		}
		const target = resolveTarget(message, args);
		if (!target) {
			await message.send("対象メッセージIDを取得できませんでした。\n返信先を見る場合は、対象メッセージに返信して !read reply を実行してください。");
			return;
		}
		const startedAt = Date.now();
		await message.send(`${target.label} の既読MIDを2秒間確認します。`);
		scheduleReadResult(message, target, startedAt);
	},
};
