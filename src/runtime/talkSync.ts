import type { BaseClient } from "@evex/linejs/base";
import { LINEStruct } from "@evex/linejs/thrift";

export interface TalkSyncCursor {
	revision: number | bigint;
	globalRev: number | bigint;
	individualRev: number | bigint;
}

export interface TalkSyncResponse<TEvent = unknown> {
	fullSyncResponse?: {
		nextRevision?: number | bigint;
	};
	operationResponse?: {
		globalEvents?: { lastRevision?: number | bigint };
		individualEvents?: { lastRevision?: number | bigint };
		operations?: TEvent[];
	};
}

export type TalkSyncGoneDisposition = "poll-expired" | "cursor-rejected" | "stalled";

function revisionBefore(value: number | bigint): number | bigint {
	if (typeof value === "bigint") return value > 0n ? value - 1n : 0n;
	return Math.max(0, value - 1);
}

export async function requestTalkSyncV3<TEvent>(
	client: BaseClient,
	cursor: TalkSyncCursor,
	timeoutMs: number,
): Promise<TalkSyncResponse<TEvent>> {
	return await client.request.request<TalkSyncResponse<TEvent>>(
		LINEStruct.sync_args({
			request: {
				lastRevision: cursor.revision,
				lastGlobalRevision: cursor.globalRev,
				lastIndividualRevision: cursor.individualRev,
				count: 100,
				fullSyncRequestReason:
					cursor.revision === 0 || cursor.revision === 0n
						? "INITIALIZATION"
						: "PERIODIC_SYNC",
				lastPartialFullSyncs: {},
			},
		}),
		"sync",
		3,
		true,
		"/SYNC3",
		{},
		timeoutMs,
	);
}

export function applyTalkSyncResponse<TEvent extends { revision?: number | bigint }>(
	cursor: TalkSyncCursor,
	response: TalkSyncResponse<TEvent>,
): TEvent[] {
	const nextRevision = response.fullSyncResponse?.nextRevision;
	if (nextRevision !== undefined) cursor.revision = revisionBefore(nextRevision);
	const nextGlobalRev = response.operationResponse?.globalEvents?.lastRevision;
	if (nextGlobalRev !== undefined) cursor.globalRev = nextGlobalRev;
	const nextIndividualRev = response.operationResponse?.individualEvents?.lastRevision;
	if (nextIndividualRev !== undefined) cursor.individualRev = nextIndividualRev;

	const operations = response.operationResponse?.operations ?? [];
	for (const event of operations) {
		if (event.revision !== undefined) cursor.revision = event.revision;
	}
	return operations;
}

export function classifyTalkSyncGone(
	elapsedMs: number,
	timeoutMs: number,
	stallLeaseMs: number,
): TalkSyncGoneDisposition {
	if (elapsedMs >= stallLeaseMs) return "stalled";
	const normalExpiryFloorMs = Math.max(1_000, Math.floor(timeoutMs * 0.5));
	return elapsedMs >= normalExpiryFloorMs ? "poll-expired" : "cursor-rejected";
}
