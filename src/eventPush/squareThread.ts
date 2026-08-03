import type { Client } from "@evex/linejs";

import {
	lineApiQueue,
	type LineApiQueueRunOptions,
} from "../runtime/lineApiQueue.js";

const MAX_MESSAGE_LENGTH = 1_600;

export interface SquareThreadDestination {
	chatMid: string;
	threadMid: string;
}

export interface SquareThreadSendOptions extends LineApiQueueRunOptions {
	waitAfterRequest?: () => Promise<void>;
}

function threadQueueOptions(
	chatMid: string,
	options?: SquareThreadSendOptions,
): LineApiQueueRunOptions {
	return {
		priority: options?.priority ?? "high",
		scope: options?.scope ?? `square:${chatMid}`,
	};
}

function messageIdFromSquareSendResult(value: unknown): string | undefined {
	const result = value as {
		createdSquareMessage?: { message?: { id?: string } };
		createdThreadMessage?: { message?: { id?: string } };
		squareMessage?: { message?: { id?: string } };
		message?: { id?: string };
		id?: string;
	};
	return result.createdSquareMessage?.message?.id ??
		result.createdThreadMessage?.message?.id ??
		result.squareMessage?.message?.id ??
		result.message?.id ??
		result.id;
}

function splitLines(text: string): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		const addition = current ? `\n${line}` : line;
		if ((current + addition).length > MAX_MESSAGE_LENGTH && current) {
			chunks.push(current);
			current = line;
		} else {
			current += addition;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function splitText(text: string): string[] {
	const blocks: string[] = [];
	let blockLines: string[] = [];
	for (const line of text.split("\n")) {
		if (/^\[\d{2}:\d{2}\]$/.test(line) && blockLines.length > 0) {
			blocks.push(blockLines.join("\n"));
			blockLines = [];
		}
		blockLines.push(line);
	}
	if (blockLines.length > 0) blocks.push(blockLines.join("\n"));

	const chunks: string[] = [];
	let current = "";
	for (const block of blocks) {
		if (block.length > MAX_MESSAGE_LENGTH) {
			if (current) chunks.push(current);
			chunks.push(...splitLines(block));
			current = "";
			continue;
		}
		const addition = current ? `\n${block}` : block;
		if ((current + addition).length > MAX_MESSAGE_LENGTH && current) {
			chunks.push(current);
			current = block;
		} else {
			current += addition;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

export async function createSquareThreadWithRoot(
	client: Client,
	chatMid: string,
	rootText: string,
	options?: SquareThreadSendOptions,
): Promise<SquareThreadDestination> {
	const queueOptions = threadQueueOptions(chatMid, options);
	const root = await lineApiQueue.run(
		"event-push:thread-root",
		() => client.base.square.sendMessage({ squareChatMid: chatMid, text: rootText }),
		queueOptions,
	);
	await options?.waitAfterRequest?.();
	const rootMessageId = messageIdFromSquareSendResult(root);
	if (!rootMessageId) throw new Error("スレッド親メッセージIDを取得できませんでした");
	const response = await lineApiQueue.run(
		"event-push:get-thread",
		() => client.base.square.getSquareThreadMid({
			request: { chatMid, messageId: rootMessageId },
		}),
		queueOptions,
	);
	await options?.waitAfterRequest?.();
	const threadMid = response.threadMid;
	if (!threadMid) throw new Error("スレッドMIDを取得できませんでした");
	try {
		await lineApiQueue.run(
			"event-push:join-thread",
			() => client.base.square.joinSquareThread({ request: { chatMid, threadMid } }),
			queueOptions,
		);
	} catch (error) {
		console.warn("[push:event:daily] joinSquareThread failed; trying thread send anyway", error);
	} finally {
		await options?.waitAfterRequest?.();
	}
	return { chatMid, threadMid };
}

export async function sendSquareThreadText(
	client: Client,
	destination: SquareThreadDestination,
	text: string,
	options?: SquareThreadSendOptions,
): Promise<void> {
	const queueOptions = threadQueueOptions(destination.chatMid, options);
	for (const chunk of splitText(text)) {
		await lineApiQueue.run(
			"event-push:thread-text",
			async () => client.base.square.sendSquareThreadMessage({
				request: {
					reqSeq: await client.base.getReqseq("sq"),
					chatMid: destination.chatMid,
					threadMid: destination.threadMid,
					threadMessage: {
						message: {
							to: destination.threadMid,
							text: chunk,
							contentType: "NONE",
							toType: "SQUARE_THREAD",
						},
					},
				},
			}),
			queueOptions,
		);
		await options?.waitAfterRequest?.();
	}
}

export async function sendSquareThreadWithRoot(
	client: Client,
	chatMid: string,
	rootText: string,
	bodyText: string,
	options?: SquareThreadSendOptions,
): Promise<void> {
	const destination = await createSquareThreadWithRoot(client, chatMid, rootText, options);
	await sendSquareThreadText(client, destination, bodyText, options);
}
