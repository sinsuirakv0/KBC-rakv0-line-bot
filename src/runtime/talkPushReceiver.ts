export interface TalkPushConnection {
	close(): Promise<void> | void;
}

export interface TalkPushTransport<T> {
	currPingId: number;
	opStream: {
		stream: ReadableStream<T>;
		renew(): void;
	};
	initializeConn(state: number, services: number[]): Promise<TalkPushConnection>;
	InitAndRead(services: number[]): Promise<unknown>;
}

interface TalkPushReceiverOptions<T> {
	push: TalkPushTransport<T>;
	signal: AbortSignal;
	staleMs: number;
	heartbeatIntervalMs?: number;
	onEvent(event: T): void;
	onHeartbeat(eventCount: number): void;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function listenTalkPushEvents<T>(
	options: TalkPushReceiverOptions<T>,
): Promise<void> {
	const {
		push,
		signal,
		staleMs,
		heartbeatIntervalMs = 10_000,
		onEvent,
		onHeartbeat,
	} = options;
	push.opStream.renew();
	const reader = push.opStream.stream.getReader();
	let connection: TalkPushConnection | undefined;
	let lastActivityAt = Date.now();
	let lastPingId = push.currPingId;
	let consumeTask: Promise<void> | undefined;
	let connectionTask: Promise<never> | undefined;
	let healthTask: Promise<void> | undefined;

	try {
		connection = await push.initializeConn(1, [8]);
		lastActivityAt = Date.now();
		lastPingId = push.currPingId;
		onHeartbeat(0);
		console.log("[talk:event] LEGY push connected");

		consumeTask = (async () => {
			while (!signal.aborted) {
				const result = await reader.read();
				if (result.done) {
					if (signal.aborted) return;
					throw new Error("Talk push event stream ended");
				}
				lastActivityAt = Date.now();
				onHeartbeat(1);
				onEvent(result.value);
			}
		})();
		connectionTask = push.InitAndRead([8]).then(() => {
			throw new Error("Talk push connection ended");
		});
		healthTask = (async () => {
			while (!signal.aborted) {
				await sleepUntilAbort(heartbeatIntervalMs, signal);
				if (signal.aborted) return;
				const pingId = push.currPingId;
				if (pingId !== lastPingId) {
					lastPingId = pingId;
					lastActivityAt = Date.now();
					onHeartbeat(0);
					continue;
				}
				const idleMs = Date.now() - lastActivityAt;
				if (idleMs >= staleMs) {
					throw new Error(`Talk push heartbeat became stale: idle=${idleMs}ms`);
				}
			}
		})();

		await Promise.race([
			consumeTask,
			connectionTask,
			healthTask,
			waitForAbort(signal),
		]);
	} finally {
		await reader.cancel().catch(() => undefined);
		await Promise.resolve(connection?.close()).catch(() => undefined);
		const tasks: Promise<unknown>[] = [];
		if (consumeTask) tasks.push(consumeTask);
		if (connectionTask) tasks.push(connectionTask);
		if (healthTask) tasks.push(healthTask);
		void Promise.allSettled(tasks);
	}
}
