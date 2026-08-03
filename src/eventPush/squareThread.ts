import type { Client } from "@evex/linejs";

import { lineApiQueue } from "../runtime/lineApiQueue.js";

const MAX_MESSAGE_LENGTH = 1_600;

export interface SquareThreadDestination {
	chatMid: string;
	threadMid: string;
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
): Promise<SquareThreadDestination> {
	const root = await lineApiQueue.run(
		"event-push:thread-root",
		() => client.base.square.sendMessage({ squareChatMid: chatMid, text: rootText }),
		{ priority: "high", scope: `square:${chatMid}` },
	);
	const rootMessageId = messageIdFromSquareSendResult(root);
	if (!rootMessageId) throw new Error("スレッド親メッセージIDを取得できませんでした");
	const response = await client.base.square.getSquareThreadMid({
		request: { chatMid, messageId: rootMessageId },
	});
	const threadMid = response.threadMid;
	if (!threadMid) throw new Error("スレッドMIDを取得できませんでした");
	try {
		await client.base.square.joinSquareThread({ request: { chatMid, threadMid } });
	} catch (error) {
		console.warn("[push:event:daily] joinSquareThread failed; trying thread send anyway", error);
	}
	return { chatMid, threadMid };
}

export async function sendSquareThreadText(
	client: Client,
	destination: SquareThreadDestination,
	text: string,
): Promise<void> {
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
			{ priority: "high", scope: `square:${destination.chatMid}` },
		);
	}
}

export async function sendSquareThreadWithRoot(
	client: Client,
	chatMid: string,
	rootText: string,
	bodyText: string,
): Promise<void> {
	const destination = await createSquareThreadWithRoot(client, chatMid, rootText);
	await sendSquareThreadText(client, destination, bodyText);
}
