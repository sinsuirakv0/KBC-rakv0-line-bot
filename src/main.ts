import { SquareMessage, type Client } from "@evex/linejs";
import { appConfig } from "./config.js";
import { handleLineCommand } from "./commands/index.js";
import type { ReplyableLineMessage } from "./commands/shared.js";
import { handlePing } from "./handlers/ping.js";
import { createLineClient, isAuthenticationError } from "./lineClient.js";
import { startEventUpdateServer } from "./server/eventUpdateServer.js";
import { initializeLineStorage, type SyncedLineStorage } from "./storage/lineStorage.js";
import { pushSubscriptionStore } from "./subscriptions/store.js";

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

interface RawSquareEvent {
	type: string;
	payload?: {
		notificationMessage?: {
			squareMessage: unknown;
		};
		receiveMessage?: {
			squareMessage: unknown;
		};
	};
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

async function handleSquareMessage(client: Client, message: SquareMessage): Promise<void> {
	if (await message.isMyMessage()) return;
	if (typeof message.text !== "string") return;
	await dispatchText("square", message.text, new SquareReplyTarget(client, message));
}

class SquareReplyTarget implements ReplyableLineMessage {
	readonly destination;

	constructor(
		readonly client: Client,
		private readonly message: SquareMessage,
	) {
		this.destination = {
			kind: "square" as const,
			chatMid: message.to.id,
			chatType: "SQUARE" as const,
			senderMid: message.from.id,
			encrypted: false,
		};
	}

	async reply(text: string): Promise<void> {
		await this.message.reply(text);
	}

	async send(text: string): Promise<void> {
		await this.message.send(text);
	}
}

class RawTalkReplyTarget implements ReplyableLineMessage {
	readonly destination;

	constructor(
		readonly client: Client,
		private readonly raw: RawTalkMessage,
		private readonly ownMid: string,
	) {
		this.destination = {
			kind: "talk" as const,
			chatMid: this.sendTo(),
			chatType: this.chatType(),
			senderMid: raw.from,
			encrypted: this.isEncrypted(),
		};
	}

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

	private chatType(): "USER" | "GROUP" | "ROOM" {
		if (this.raw.toType === "GROUP" || this.raw.to.startsWith("c")) return "GROUP";
		if (this.raw.toType === "ROOM" || this.raw.to.startsWith("r")) return "ROOM";
		return "USER";
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

function handlePollingError(
	channel: "talk" | "square",
	error: unknown,
	onFatal: (error: unknown) => void,
): void {
	if (isAuthenticationError(error)) {
		onFatal(error);
		return;
	}
	console.error(`[${channel}:event] polling error`, error);
}

async function listenRawTalkEvents(
	client: Client,
	ownMid: string,
	signal: AbortSignal,
	onFatal: (error: unknown) => void,
): Promise<void> {
	const polling = client.base.createPolling();
	for await (const event of polling._listenTalkEvents({
		signal,
		pollingInterval: 500,
		onError: (error) => handlePollingError("talk", error, onFatal),
	}) as AsyncIterable<RawTalkEvent>) {
		if (signal.aborted) break;
		await handleRawTalkEvent(client, ownMid, event);
	}
}

async function listenRawSquareEvents(
	client: Client,
	signal: AbortSignal,
	onFatal: (error: unknown) => void,
): Promise<void> {
	const polling = client.base.createPolling();
	for await (const event of polling._listenSquareEvents({
		signal,
		pollingInterval: 1_000,
		onError: (error) => handlePollingError("square", error, onFatal),
	}) as AsyncIterable<RawSquareEvent>) {
		if (signal.aborted) break;
		const rawMessage = event.type === "NOTIFICATION_MESSAGE"
			? event.payload?.notificationMessage?.squareMessage
			: event.type === "RECEIVE_MESSAGE"
				? event.payload?.receiveMessage?.squareMessage
				: undefined;
		if (!rawMessage) continue;
		await handleSquareMessage(client, new SquareMessage({
			client,
			raw: rawMessage as never,
		}));
	}
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function sleepUntilRetry(ms: number, signal: AbortSignal): Promise<void> {
	await Promise.race([sleep(ms), waitForAbort(signal)]);
}

async function runSession(
	client: Client,
	storage: SyncedLineStorage,
	shutdownSignal: AbortSignal,
): Promise<void> {
	const profile = await client.getMyProfile();
	console.log(`[line] logged in as ${profile.displayName} (${profile.mid})`);
	try {
		await client.base.e2ee.getE2EESelfKeyData(profile.mid);
		console.log("[line] E2EE self key is available");
	} catch {
		console.warn("[line] E2EE self key is not available; encrypted Talk messages cannot be read yet");
	}

	await storage.flushBackup();
	const controller = new AbortController();
	const relayShutdown = () => controller.abort();
	shutdownSignal.addEventListener("abort", relayShutdown, { once: true });
	let rejectSession!: (error: unknown) => void;
	let failed = false;
	const sessionFailure = new Promise<never>((_resolve, reject) => {
		rejectSession = reject;
	});
	const onFatal = (error: unknown) => {
		if (failed || controller.signal.aborted) return;
		failed = true;
		controller.abort();
		rejectSession(error);
	};

	if (appConfig.enableTalk) {
		void listenRawTalkEvents(client, profile.mid, controller.signal, onFatal)
			.catch(onFatal);
	}
	if (appConfig.enableSquare) {
		void listenRawSquareEvents(client, controller.signal, onFatal)
			.catch(onFatal);
	}

	console.log("[app] bot is listening");
	let watchdogRunning = false;
	const watchdog = setInterval(() => {
		if (watchdogRunning || controller.signal.aborted) return;
		watchdogRunning = true;
		void client.getMyProfile()
			.catch((error) => {
				if (isAuthenticationError(error)) onFatal(error);
				else console.warn("[line] authentication watchdog request failed", error);
			})
			.finally(() => {
				watchdogRunning = false;
			});
	}, appConfig.authWatchdogMs);

	try {
		await Promise.race([waitForAbort(shutdownSignal), sessionFailure]);
	} finally {
		clearInterval(watchdog);
		controller.abort();
		shutdownSignal.removeEventListener("abort", relayShutdown);
	}
}

async function main(): Promise<void> {
	let activeClient: Client | null = null;
	const shutdownController = new AbortController();
	const eventUpdateServer = startEventUpdateServer(() => activeClient);
	const shutdown = () => {
		if (shutdownController.signal.aborted) return;
		console.log("[app] shutting down");
		shutdownController.abort();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	await pushSubscriptionStore.initialize();
	const storage = await initializeLineStorage();
	while (!shutdownController.signal.aborted) {
		try {
			const client = await createLineClient(storage);
			activeClient = client;
			await runSession(client, storage, shutdownController.signal);
		} catch (error) {
			activeClient = null;
			if (shutdownController.signal.aborted) break;
			console.error("[line] session stopped; automatic login will retry", error);
			await storage.flushBackup().catch(() => {});
			await sleepUntilRetry(appConfig.loginRetryMs, shutdownController.signal);
		} finally {
			activeClient = null;
		}
	}

	await storage.flushBackup().catch(() => {});
	await new Promise<void>((resolve) => eventUpdateServer.close(() => resolve()));
}

main().catch((error) => {
	console.error("[app] fatal error", error);
	process.exitCode = 1;
});
