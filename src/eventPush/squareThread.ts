import type { Client } from "@evex/linejs";

const MAX_MESSAGE_LENGTH = 1_600;

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

export async function sendSquareThreadWithRoot(
	client: Client,
	chatMid: string,
	rootText: string,
	bodyText: string,
): Promise<void> {
	const root = await client.base.square.sendMessage({ squareChatMid: chatMid, text: rootText });
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
	for (const text of splitText(bodyText)) {
		await client.base.square.sendSquareThreadMessage({
			request: {
				reqSeq: await client.base.getReqseq("sq"),
				chatMid,
				threadMid,
				threadMessage: {
					message: {
						to: threadMid,
						text,
						contentType: "NONE",
						toType: "SQUARE_THREAD",
					},
				},
			},
		});
	}
}
