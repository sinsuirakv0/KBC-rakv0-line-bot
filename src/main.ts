import type { Client, SquareMessage } from "@evex/linejs";
import { appConfig } from "./config.js";
import { handleLineCommand } from "./commands/index.js";
import type { ReplyableLineMessage } from "./commands/shared.js";
import { handlePing } from "./handlers/ping.js";
import { createLineClient } from "./lineClient.js";

interface RawTalkMessage {
	id: string;
	from: string;
	to: string;
	toType: string;
	text?: string;
	chunks?: unknown;
	contentMetadata?: Record<string, string>;
}

interface RawTalkEvent {
	type: string;
	message?: RawTalkMessage;
}

let warnedEncryptedTalk = false;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchText(
	channel: "talk" | "square",
	messageText: string,
	message: ReplyableLineMessage,
): Promise<void> {
	try {
		if (await handlePing(messageText, message)) return;
		if (await handleLineCommand(messageText, message)) return;
	} catch (error) {
		console.error(`[${channel}:message] handler failed`, error);
	}
}

async function handleSquareMessage(message: SquareMessage): Promise<void> {
	if (await message.isMyMessage()) return;
	if (typeof message.text !== "string") return;
	await dispatchText("square", message.text, message);
}

class RawTalkReplyTarget implements ReplyableLineMessage {
	constructor(
		private readonly client: Client,
		private readonly raw: RawTalkMessage,
		private readonly ownMid: string,
	) {}

	async reply(text: string): Promise<void> {
		await this.sendTalk(text, this.raw.id);
	}

	async send(text: string): Promise<void> {
		await this.sendTalk(text);
	}

	private sendTo(): string {
		if (
			this.raw.toType === "GROUP" ||
			this.raw.toType === "ROOM" ||
			this.raw.to.startsWith("c") ||
			this.raw.to.startsWith("r")
		) {
			return this.raw.to;
		}
		return this.raw.from === this.ownMid ? this.raw.to : this.raw.from;
	}

	private async sendTalk(text: string, relatedMessageId?: string): Promise<void> {
		await this.client.base.talk.sendMessage({
			to: this.sendTo(),
			text,
			relatedMessageId,
			e2ee: this.isEncrypted(),
		});
	}

	private isEncrypted(): boolean {
		return Boolean(this.raw.chunks || this.raw.contentMetadata?.e2eeVersion);
	}
}

async function readTalkText(client: Client, raw: RawTalkMessage): Promise<string | null> {
	if (typeof raw.text === "string") return raw.text;
	if (!raw.chunks && !raw.contentMetadata?.e2eeVersion) return null;

	try {
		const decrypted = await client.base.e2ee.decryptE2EEMessage(raw as never) as RawTalkMessage;
		if (typeof decrypted.text === "string") return decrypted.text;
	} catch (error) {
		if (!warnedEncryptedTalk) {
			warnedEncryptedTalk = true;
			console.warn(
				"[talk:message] encrypted Talk message received, but E2EE keys are not available or decryption failed. " +
					"Run an E2EE-capable login to save keys before Talk commands can be read.",
			);
			console.warn(error);
		}
	}
	return null;
}

async function handleRawTalkEvent(client: Client, ownMid: string, event: RawTalkEvent): Promise<void> {
	if (event.type !== "SEND_MESSAGE" && event.type !== "RECEIVE_MESSAGE") {
		console.log(`[talk:event] ${event.type}`);
		return;
	}

	const raw = event.message;
	if (!raw) return;
	if (raw.from === ownMid) return;

	const text = await readTalkText(client, raw);
	if (text === null) return;

	await dispatchText("talk", text, new RawTalkReplyTarget(client, raw, ownMid));
}

function listenRawTalkEvents(client: Client, ownMid: string, signal: AbortSignal): void {
	void (async () => {
		const polling = client.base.createPolling();
		while (!signal.aborted) {
			try {
				for await (const event of polling.listenTalkEvents() as AsyncIterable<RawTalkEvent>) {
					if (signal.aborted) break;
					await handleRawTalkEvent(client, ownMid, event);
				}
			} catch (error) {
				if (!signal.aborted) {
					console.error("[talk:event] listener failed", error);
					await sleep(3000);
				}
			}
		}
	})();
}

async function main(): Promise<void> {
	const client = await createLineClient();
	const profile = await client.getMyProfile();
	console.log(`[line] logged in as ${profile.displayName} (${profile.mid})`);
	try {
		await client.base.e2ee.getE2EESelfKeyData(profile.mid);
		console.log("[line] E2EE self key is available");
	} catch {
		console.warn("[line] E2EE self key is not available; encrypted Talk messages cannot be read yet");
	}

	const controller = new AbortController();
	const shutdown = () => {
		console.log("[app] shutting down");
		controller.abort();
	};

	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	client.on("square:message", (message) => {
		void handleSquareMessage(message);
	});

	client.on("square:event", (event) => {
		console.log(`[square:event] ${event.type}`);
	});

	if (appConfig.enableTalk) {
		listenRawTalkEvents(client, profile.mid, controller.signal);
	}

	client.listen({
		talk: false,
		square: appConfig.enableSquare,
		signal: controller.signal,
	});

	console.log("[app] bot is listening");
}

main().catch((error) => {
	console.error("[app] fatal error", error);
	process.exitCode = 1;
});
