import fs from "node:fs/promises";

export interface MemoryPressureSnapshot {
	currentBytes: number;
	limitBytes: number;
	ratio: number;
	rssBytes: number;
	heapUsedBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
}

export interface MemoryGuardOptions {
	signal: AbortSignal;
	thresholdRatio: number;
	intervalMs: number;
	onThreshold(snapshot: MemoryPressureSnapshot): void | Promise<void>;
	readSnapshot?: () => Promise<MemoryPressureSnapshot | undefined>;
}

const CGROUP_V2_CURRENT = "/sys/fs/cgroup/memory.current";
const CGROUP_V2_LIMIT = "/sys/fs/cgroup/memory.max";
const CGROUP_V1_CURRENT = "/sys/fs/cgroup/memory/memory.usage_in_bytes";
const CGROUP_V1_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

async function readText(filePath: string): Promise<string | undefined> {
	try {
		return (await fs.readFile(filePath, "utf8")).trim();
	} catch {
		return undefined;
	}
}

function parseBytes(value: string | undefined): number | undefined {
	if (!value || value === "max") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function readMemoryPressureSnapshot(): Promise<MemoryPressureSnapshot | undefined> {
	const [currentV2, limitV2, currentV1, limitV1] = await Promise.all([
		readText(CGROUP_V2_CURRENT),
		readText(CGROUP_V2_LIMIT),
		readText(CGROUP_V1_CURRENT),
		readText(CGROUP_V1_LIMIT),
	]);
	const currentBytes = parseBytes(currentV2) ?? parseBytes(currentV1);
	const limitBytes = parseBytes(limitV2) ?? parseBytes(limitV1);
	if (!currentBytes || !limitBytes || currentBytes > limitBytes * 10) return undefined;
	const memory = process.memoryUsage();
	return {
		currentBytes,
		limitBytes,
		ratio: currentBytes / limitBytes,
		rssBytes: memory.rss,
		heapUsedBytes: memory.heapUsed,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers,
	};
}

export function startMemoryGuard(options: MemoryGuardOptions): () => void {
	let stopped = false;
	let running = false;
	let triggered = false;
	const readSnapshot = options.readSnapshot ?? readMemoryPressureSnapshot;
	let timer: NodeJS.Timeout;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		options.signal.removeEventListener("abort", stop);
	};
	const sample = async () => {
		if (stopped || running || triggered || options.signal.aborted) return;
		running = true;
		try {
			const snapshot = await readSnapshot();
			if (!snapshot || snapshot.ratio < options.thresholdRatio) return;
			triggered = true;
			await options.onThreshold(snapshot);
		} catch (error) {
			console.warn("[memory-guard] sampling failed", error);
		} finally {
			running = false;
		}
	};
	timer = setInterval(() => void sample(), Math.max(1_000, options.intervalMs));
	timer.unref();
	options.signal.addEventListener("abort", stop, { once: true });
	if (options.signal.aborted) {
		stop();
		return stop;
	}
	void sample();
	return stop;
}
