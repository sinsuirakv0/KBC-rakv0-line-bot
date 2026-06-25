import { SquareMessage, type Client } from "@evex/linejs";
import { appConfig } from "./config.js";
import { handleLineCommand } from "./commands/index.js";
import type { OutgoingImage, ReplyableLineMessage } from "./commands/shared.js";
import { handleSearchPageReply } from "./commands/searchPages.js";
import { handlePing } from "./handlers/ping.js";
import { createLineClient, isAuthenticationError } from "./lineClient.js";
import { startEventPushScheduler } from "./eventPush/scheduler.js";
import { eventPushStore } from "./eventPush/store.js";
import { startEventUpdateServer } from "./server/eventUpdateServer.js";
import { initializeLineStorage, type SyncedLineStorage } from "./storage/lineStorage.js";
import { pushSubscriptionStore } from "./subscriptions/store.js";
import { rankingStore } from "./ranking/store.js";
import { runtimeStore } from "./runtime/store.js";
import { permissionStore } from "./permissions/store.js";

interface RawTalkMessage {
	id: string;
	from: string;
	to: string;
	toType: string;
	createdTime?: number | bigint;
	text?: string;
	chunks?: unknown;
	contentMetadata?: Record<string, string>;
	relatedMessageId?: string;
	messageRelationType?: string | number;
}

interface RawTalkEvent {
	type: string;
	revision?: number | bigint;
	message?: RawTalkMessage;
}

interface RawTalkSyncResponse {
	fullSyncResponse?: {
		nextRevision?: number | bigint;
	};
	operationResponse?: {
		globalEvents?: { lastRevision?: number | bigint };
		individualEvents?: { lastRevision?: number | bigint };
		operations?: RawTalkEvent[];
	};
}

interface ParsedTalkText {
	text: string;
	mentionMids: string[];
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
	} & Record<string, unknown>;
}

let warnedEncryptedTalk = false;
let activeHandlers = 0;
const senderNames = new Map<string, string>();
const senderNameRequests = new Map<string, Promise<string | undefined>>();
const squareScopeRequests = new Map<string, Promise<string>>();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchText(
	channel: "talk" | "square",
	messageText: string,
	message: ReplyableLineMessage,
): Promise<void> {
	const startedAt = Date.now();
	activeHandlers += 1;
	try {
		if (
			messageText.startsWith(appConfig.commandPrefix) &&
			!isBotPermissionStatusCommand(messageText) &&
			!permissionStore.canExecute(message.destination)
		) {
			await message.send("実行権限がありません。");
			return;
		}
		if (messageText === `${appConfig.commandPrefix}ping` || messageText === `${appConfig.commandPrefix}ping help`) {
			rankingStore.record(message.destination);
			if (await handlePing(messageText, message)) return;
		}
		if (await handleLineCommand(messageText, message)) return;
	} catch (error) {
		console.error(`[${channel}:message] handler failed`, error);
	} finally {
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= 1_000 || messageText === `${appConfig.commandPrefix}ping`) {
			const command = messageText.slice(appConfig.commandPrefix.length).trim().split(/\s+/, 1)[0] || "unknown";
			console.log(`[perf] ${channel} !${command} handler=${elapsedMs}ms concurrent=${activeHandlers}`);
		}
		activeHandlers -= 1;
	}
}

function isBotPermissionStatusCommand(messageText: string): boolean {
	const body = messageText.slice(appConfig.commandPrefix.length).trim().toLowerCase();
	return /^bot\s+setting\s+status(?:\s|$)/.test(body);
}

async function handleSquareMessage(client: Client, message: SquareMessage): Promise<void> {
	if (await message.isMyMessage()) return;
	if (typeof message.text !== "string") return;
	const scopeMid = await resolveSquareScope(client, message.to.id, message.from.id);
	const target = new SquareReplyTarget(
		client,
		message,
		scopeMid,
		senderNames.get(`square:${message.from.id}`),
	);
	if (!message.text.startsWith(appConfig.commandPrefix)) {
		await handleSearchPageReply(message.text, target);
		return;
	}
	await dispatchText("square", message.text, target);
	void resolveSenderName(client, "square", message.from.id)
		.then((name) => {
			if (name) rankingStore.updateName("square", message.from.id, name);
		});
}

function resolveSquareScope(client: Client, squareChatMid: string, senderMid: string): Promise<string> {
	let request = squareScopeRequests.get(squareChatMid);
	if (!request) {
		request = client.base.square.getSquareMember({ squareMemberMid: senderMid })
			.then((response) => {
				const member = response.squareMember;
				if (member.displayName) senderNames.set(`square:${senderMid}`, member.displayName);
				return member.squareMid;
			})
			.catch((error) => {
				console.warn(`[ranking] member lookup failed for ${senderMid}; falling back to chat lookup`, error);
				return client.base.square.getSquareChat({ squareChatMid })
					.then((response) => response.squareChat.squareMid)
					.catch((fallbackError) => {
						squareScopeRequests.delete(squareChatMid);
						console.warn(`[ranking] failed to resolve parent OpenChat for ${squareChatMid}`, fallbackError);
						return squareChatMid;
					});
			});
		squareScopeRequests.set(squareChatMid, request);
	}
	return request;
}

function resolveSenderName(
	client: Client,
	kind: "talk" | "square",
	mid: string,
): Promise<string | undefined> {
	const key = `${kind}:${mid}`;
	const cached = senderNames.get(key);
	if (cached) return Promise.resolve(cached);
	let request = senderNameRequests.get(key);
	if (!request) {
		request = (kind === "square"
			? client.base.square.getSquareMember({ squareMemberMid: mid })
				.then((response) => response.squareMember.displayName)
			: client.getUser(mid).then((user) => user.raw.targetProfileDetail.profileName)
		).then((name) => {
			if (name) senderNames.set(key, name);
			return name || undefined;
		}).catch((error) => {
			console.warn(`[ranking] failed to resolve ${kind} name for ${mid}`, error);
			return undefined;
		}).finally(() => {
			senderNameRequests.delete(key);
		});
		senderNameRequests.set(key, request);
	}
	return request;
}

class SquareReplyTarget implements ReplyableLineMessage {
	readonly destination;
	readonly mentionMids: string[];
	readonly replyToMessageId?: string;

	constructor(
		readonly client: Client,
		private readonly message: SquareMessage,
		scopeMid: string,
		senderName?: string,
	) {
		this.mentionMids = message.getMentions()
			.flatMap((mention) => mention.all ? [] : [mention.mid]);
		this.replyToMessageId = message.getReplyTarget()?.id;
		this.destination = {
			kind: "square" as const,
			chatMid: message.to.id,
			scopeMid,
			chatType: "SQUARE" as const,
			senderMid: message.from.id,
			senderName,
			encrypted: false,
		};
	}

	async reply(text: string): Promise<string | undefined> {
		return await this.send(text);
	}

	async send(text: string): Promise<string | undefined> {
		const sent = await this.client.base.square.sendMessage({
			squareChatMid: this.destination.chatMid,
			text,
		});
		return messageIdFromSquareSendResult(sent);
	}

	async sendImage(image: OutgoingImage): Promise<void> {
		const sent = await this.client.base.square.sendMessage({
			squareChatMid: this.destination.chatMid,
			contentType: "IMAGE" as never,
		});
		const messageId = messageIdFromSquareSendResult(sent);
		if (!messageId) throw new Error("画像メッセージIDを取得できませんでした");
		await this.client.base.obs.uploadObjTalk(
			this.destination.chatMid,
			"image",
			image.blob,
			messageId,
			image.filename,
		);
	}
}

class RawTalkReplyTarget implements ReplyableLineMessage {
	readonly destination;
	readonly mentionMids: string[];
	readonly replyToMessageId?: string;

	constructor(
		readonly client: Client,
		private readonly raw: RawTalkMessage,
		private readonly ownMid: string,
		mentionMids: string[],
	) {
		this.mentionMids = mentionMids;
		this.replyToMessageId = raw.relatedMessageId &&
				(raw.messageRelationType === 3 || raw.messageRelationType === "REPLY")
			? raw.relatedMessageId
			: undefined;
		this.destination = {
			kind: "talk" as const,
			chatMid: this.sendTo(),
			scopeMid: this.sendTo(),
			chatType: this.chatType(),
			senderMid: raw.from,
			senderName: senderNames.get(`talk:${raw.from}`),
			encrypted: this.isEncrypted(),
		};
	}

	async reply(text: string): Promise<string | undefined> {
		return await this.sendTalk(text);
	}

	async send(text: string): Promise<string | undefined> {
		return await this.sendTalk(text);
	}

	async sendImage(image: OutgoingImage): Promise<void> {
		const to = this.sendTo();
		if (this.isEncrypted() && (to.startsWith("u") || to.startsWith("c"))) {
			await this.client.base.obs.uploadMediaByE2EE({
				to,
				oType: "image",
				data: image.blob,
				filename: image.filename,
			});
			return;
		}

		const sent = await this.client.base.talk.sendMessage({
			to,
			contentType: "IMAGE" as never,
		});
		if (!sent.id) throw new Error("画像メッセージIDを取得できませんでした");
		await this.client.base.obs.uploadObjTalk(to, "image", image.blob, sent.id, image.filename);
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

	private async sendTalk(text: string, relatedMessageId?: string): Promise<string | undefined> {
		const sent = await this.client.base.talk.sendMessage({
			to: this.sendTo(),
			text,
			relatedMessageId,
			e2ee: this.isEncrypted(),
		});
		return sent.id;
	}

	private isEncrypted(): boolean {
		return Boolean(this.raw.chunks || this.raw.contentMetadata?.e2eeVersion);
	}
}

function messageIdFromSquareSendResult(value: unknown): string | undefined {
	const result = value as {
		createdSquareMessage?: { message?: { id?: string } };
		squareMessage?: { message?: { id?: string } };
		message?: { id?: string };
		id?: string;
	};
	return result.createdSquareMessage?.message?.id ??
		result.squareMessage?.message?.id ??
		result.message?.id ??
		result.id;
}

function talkMentionMids(raw: RawTalkMessage): string[] {
	const value = raw.contentMetadata?.MENTION;
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as {
			MENTIONEES?: Array<{ M?: unknown }>;
		};
		return [...new Set(
			(parsed.MENTIONEES ?? []).flatMap((mention) =>
				typeof mention.M === "string" ? [mention.M] : []
			),
		)];
	} catch {
		return [];
	}
}

async function readTalkText(client: Client, raw: RawTalkMessage): Promise<ParsedTalkText | null> {
	if (typeof raw.text === "string") {
		return { text: raw.text, mentionMids: talkMentionMids(raw) };
	}
	if (!raw.chunks && !raw.contentMetadata?.e2eeVersion) return null;

	try {
		const decrypted = await client.base.e2ee.decryptE2EEMessage(raw as never) as RawTalkMessage;
		if (typeof decrypted.text === "string") {
			return { text: decrypted.text, mentionMids: talkMentionMids(decrypted) };
		}
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

	const parsed = await readTalkText(client, raw);
	if (parsed === null) return;
	const target = new RawTalkReplyTarget(client, raw, ownMid, parsed.mentionMids);
	if (!parsed.text.startsWith(appConfig.commandPrefix)) {
		await handleSearchPageReply(parsed.text, target);
		return;
	}
	const createdAt = Number(raw.createdTime);
	if (Number.isFinite(createdAt) && createdAt > 1_500_000_000_000) {
		const receiveLagMs = Math.max(0, Date.now() - createdAt);
		if (receiveLagMs >= 1_000 || parsed.text === `${appConfig.commandPrefix}ping`) {
			console.log(`[perf] talk receiveLag=${receiveLagMs}ms`);
		}
	}
	await dispatchText(
		"talk",
		parsed.text,
		target,
	);
	void resolveSenderName(client, "talk", raw.from)
		.then((name) => {
			if (name) rankingStore.updateName("talk", raw.from, name);
		});
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

function isTimeoutError(error: unknown): boolean {
	const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /timeout|timed out|aborted due to timeout/i.test(detail);
}

async function listenRawTalkEvents(
	client: Client,
	ownMid: string,
	signal: AbortSignal,
	onFatal: (error: unknown) => void,
): Promise<void> {
	let revision: number | bigint = 0;
	let globalRev: number | bigint = 0;
	let individualRev: number | bigint = 0;
	// Keep the wait bounded: LINEJS defaults sync() to a 180-second long poll.
	while (!signal.aborted) {
		try {
			const pollStartedAt = Date.now();
			const response = await client.base.talk.sync({
				revision,
				globalRev,
				individualRev,
				limit: 100,
				timeout: appConfig.talkPollTimeoutMs,
			}) as RawTalkSyncResponse;
			const nextRevision = response.fullSyncResponse?.nextRevision;
			if (nextRevision !== undefined) revision = nextRevision;
			const nextGlobalRev = response.operationResponse?.globalEvents?.lastRevision;
			if (nextGlobalRev !== undefined) globalRev = nextGlobalRev;
			const nextIndividualRev = response.operationResponse?.individualEvents?.lastRevision;
			if (nextIndividualRev !== undefined) individualRev = nextIndividualRev;

			const operations = response.operationResponse?.operations ?? [];
			if (operations.length > 0) {
				console.log(`[perf] talk poll=${Date.now() - pollStartedAt}ms events=${operations.length}`);
			}
			for (const event of operations) {
				if (event.revision !== undefined) revision = event.revision;
				void handleRawTalkEvent(client, ownMid, event)
					.catch((error) => handlePollingError("talk", error, onFatal));
			}
		} catch (error) {
			if (!signal.aborted && !isTimeoutError(error)) {
				handlePollingError("talk", error, onFatal);
			}
		}
		await sleepUntilRetry(appConfig.talkPollIntervalMs, signal);
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
		void handleSquareMessage(client, new SquareMessage({
			client,
			raw: rawMessage as never,
		})).catch((error) => handlePollingError("square", error, onFatal));
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
	await runtimeStore.startSession();
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
	let eventLoopCheckedAt = Date.now();
	const eventLoopMonitor = setInterval(() => {
		const now = Date.now();
		const lagMs = Math.max(0, now - eventLoopCheckedAt - 10_000);
		if (lagMs >= 1_000) console.warn(`[perf] event-loop lag=${lagMs}ms`);
		eventLoopCheckedAt = now;
	}, 10_000);
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
	const runtimeCheckpoint = setInterval(() => {
		void runtimeStore.checkpoint().catch((error) => {
			console.warn("[runtime] checkpoint failed", error);
		});
	}, 5 * 60_000);

	try {
		await Promise.race([waitForAbort(shutdownSignal), sessionFailure]);
	} finally {
		clearInterval(watchdog);
		clearInterval(runtimeCheckpoint);
		clearInterval(eventLoopMonitor);
		controller.abort();
		shutdownSignal.removeEventListener("abort", relayShutdown);
		await runtimeStore.endSession().catch((error) => {
			console.warn("[runtime] session uptime save failed", error);
		});
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

	await Promise.all([
		pushSubscriptionStore.initialize(),
		eventPushStore.initialize(),
		rankingStore.initialize(),
		runtimeStore.initialize(),
		permissionStore.initialize(),
	]);
	startEventPushScheduler(() => activeClient, shutdownController.signal);
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
	await rankingStore.flush().catch(() => {});
	await runtimeStore.flush().catch(() => {});
	await permissionStore.flush().catch(() => {});
	await new Promise<void>((resolve) => eventUpdateServer.close(() => resolve()));
}

main().catch((error) => {
	console.error("[app] fatal error", error);
	process.exitCode = 1;
});
