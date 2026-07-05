import type { CommandProgress, ReplyableLineMessage } from "./shared.js";

const CLEANUP_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class NullCommandProgress implements CommandProgress {
	async update(): Promise<string | undefined> {
		return undefined;
	}

	async finish(): Promise<void> {
		// 送信できなかった場合でもコマンド本体は動かす。
	}

	detach(): void {
		// no-op
	}
}

class DeletableCommandProgress implements CommandProgress {
	private readonly messageIds: string[] = [];
	private detached = false;
	private finished = false;

	constructor(private readonly message: ReplyableLineMessage) {}

	async update(text: string): Promise<string | undefined> {
		if (this.finished) return undefined;
		const messageId = await this.message.send(text);
		if (messageId) this.messageIds.push(messageId);
		return messageId;
	}

	async finish(): Promise<void> {
		if (this.finished || this.detached) return;
		this.finished = true;
		if (!this.message.deleteMessage || this.messageIds.length === 0) return;
		await sleep(CLEANUP_DELAY_MS);
		for (const messageId of [...this.messageIds].reverse()) {
			try {
				await this.message.deleteMessage(messageId);
			} catch (error) {
				console.warn(`[command-progress] failed to delete progress message ${messageId}`, error);
			}
		}
	}

	detach(): void {
		this.detached = true;
	}
}

export async function startCommandProgress(
	message: ReplyableLineMessage,
	commandName: string,
): Promise<CommandProgress> {
	const progress = new DeletableCommandProgress(message);
	try {
		await progress.update(`!${commandName} を処理中...`);
		return progress;
	} catch (error) {
		console.warn(`[command-progress] failed to send progress message for !${commandName}`, error);
		return new NullCommandProgress();
	}
}
