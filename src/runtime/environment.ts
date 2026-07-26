import fs from "node:fs/promises";
import os from "node:os";
import v8 from "node:v8";

export interface RuntimeEnvironmentSnapshot {
	platform: string;
	release: string;
	architecture: string;
	nodeVersion: string;
	v8Version: string;
	processUptimeMs: number;
	cpuModel: string;
	visibleCpuCount: number;
	hostCpuCount: number;
	systemMemoryTotalBytes: number;
	systemMemoryFreeBytes: number;
	containerDetected: boolean;
	northflankDetected: boolean;
	cgroupMemoryLimitBytes?: number;
	cgroupMemoryCurrentBytes?: number;
	cgroupCpuLimitCores?: number;
	cgroupPidsLimit?: number;
	diskTotalBytes?: number;
	diskFreeBytes?: number;
}

export function formatRuntimeBytes(bytes: number): string {
	const mib = bytes / 1024 / 1024;
	return `${mib.toFixed(1)}MiB`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const rest = seconds % 60;
	return [
		days > 0 ? `${days}日` : "",
		hours > 0 ? `${hours}時間` : "",
		minutes > 0 ? `${minutes}分` : "",
		`${rest}秒`,
	].filter(Boolean).join("");
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
	try {
		return (await fs.readFile(filePath, "utf8")).trim();
	} catch {
		return undefined;
	}
}

function parseLimit(value: string | undefined): number | undefined {
	if (!value || value === "max" || value === "-1") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseCpuMax(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const [quotaRaw, periodRaw] = value.split(/\s+/);
	const quota = parseLimit(quotaRaw);
	const period = parseLimit(periodRaw);
	if (!quota || !period) return undefined;
	return quota / period;
}

async function collectCgroupLimits(): Promise<{
	memoryLimitBytes?: number;
	memoryCurrentBytes?: number;
	cpuLimitCores?: number;
	pidsLimit?: number;
}> {
	const [memoryMaxV2, memoryCurrentV2, cpuMaxV2, pidsMaxV2, memoryLimitV1, memoryUsageV1, cpuQuotaV1, cpuPeriodV1, pidsMaxV1] = await Promise.all([
		readOptionalText("/sys/fs/cgroup/memory.max"),
		readOptionalText("/sys/fs/cgroup/memory.current"),
		readOptionalText("/sys/fs/cgroup/cpu.max"),
		readOptionalText("/sys/fs/cgroup/pids.max"),
		readOptionalText("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
		readOptionalText("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
		readOptionalText("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
		readOptionalText("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
		readOptionalText("/sys/fs/cgroup/pids/pids.max"),
	]);
	const cpuV1Quota = parseLimit(cpuQuotaV1);
	const cpuV1Period = parseLimit(cpuPeriodV1);
	return {
		memoryLimitBytes: parseLimit(memoryMaxV2) ?? parseLimit(memoryLimitV1),
		memoryCurrentBytes: parseLimit(memoryCurrentV2) ?? parseLimit(memoryUsageV1),
		cpuLimitCores: parseCpuMax(cpuMaxV2) ?? (
			cpuV1Quota && cpuV1Period ? cpuV1Quota / cpuV1Period : undefined
		),
		pidsLimit: parseLimit(pidsMaxV2) ?? parseLimit(pidsMaxV1),
	};
}

async function collectDiskSpace(): Promise<{ totalBytes?: number; freeBytes?: number }> {
	try {
		const stat = await fs.statfs(process.cwd());
		const blockSize = Number(stat.bsize);
		const totalBytes = Number(stat.blocks) * blockSize;
		const freeBytes = Number(stat.bavail) * blockSize;
		return {
			totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
			freeBytes: Number.isFinite(freeBytes) ? freeBytes : undefined,
		};
	} catch {
		return {};
	}
}

async function isContainerized(): Promise<boolean> {
	try {
		await fs.access("/.dockerenv");
		return true;
	} catch {
		const cgroup = await readOptionalText("/proc/1/cgroup");
		return Boolean(cgroup && /docker|containerd|kubepods|podman/i.test(cgroup));
	}
}

export async function collectRuntimeEnvironment(): Promise<RuntimeEnvironmentSnapshot> {
	const [cgroup, disk, detectedByRuntime] = await Promise.all([
		collectCgroupLimits(),
		collectDiskSpace(),
		isContainerized(),
	]);
	const cpus = os.cpus();
	return {
		platform: process.platform,
		release: os.release(),
		architecture: process.arch,
		nodeVersion: process.version,
		v8Version: process.versions.v8,
		processUptimeMs: process.uptime() * 1_000,
		cpuModel: cpus[0]?.model || "unknown",
		visibleCpuCount: typeof os.availableParallelism === "function" ? os.availableParallelism() : cpus.length,
		hostCpuCount: cpus.length,
		systemMemoryTotalBytes: os.totalmem(),
		systemMemoryFreeBytes: os.freemem(),
		containerDetected: detectedByRuntime || Boolean(
			cgroup.memoryLimitBytes || cgroup.cpuLimitCores || cgroup.pidsLimit,
		),
		northflankDetected: Object.keys(process.env).some((key) => key.startsWith("NF_")),
		cgroupMemoryLimitBytes: cgroup.memoryLimitBytes,
		cgroupMemoryCurrentBytes: cgroup.memoryCurrentBytes,
		cgroupCpuLimitCores: cgroup.cpuLimitCores,
		cgroupPidsLimit: cgroup.pidsLimit,
		diskTotalBytes: disk.totalBytes,
		diskFreeBytes: disk.freeBytes,
	};
}

export function formatRuntimeEnvironment(snapshot: RuntimeEnvironmentSnapshot): string {
	const systemUsedBytes = snapshot.systemMemoryTotalBytes - snapshot.systemMemoryFreeBytes;
	const cgroupMemory = snapshot.cgroupMemoryLimitBytes
		? `${formatRuntimeBytes(snapshot.cgroupMemoryCurrentBytes ?? 0)} / ${formatRuntimeBytes(snapshot.cgroupMemoryLimitBytes)}`
		: "取得できませんでした";
	const cpuLimit = snapshot.cgroupCpuLimitCores
		? `${snapshot.cgroupCpuLimitCores.toFixed(2)} core`
		: "取得できませんでした";
	const disk = snapshot.diskTotalBytes && snapshot.diskFreeBytes !== undefined
		? `${formatRuntimeBytes(snapshot.diskTotalBytes - snapshot.diskFreeBytes)} / ${formatRuntimeBytes(snapshot.diskTotalBytes)}`
		: "取得できませんでした";
	return [
		"bot environment test",
		"",
		"platform",
		`実行基盤: ${snapshot.northflankDetected ? "Northflankを検出" : "Northflank環境変数は未検出"}`,
		`コンテナ: ${snapshot.containerDetected ? "コンテナ環境を検出" : "判定できませんでした"}`,
		`OS: ${snapshot.platform} ${snapshot.release} (${snapshot.architecture})`,
		`Node: ${snapshot.nodeVersion} / V8 ${snapshot.v8Version}`,
		`プロセス稼働: ${formatDuration(snapshot.processUptimeMs)}`,
		"",
		"resource",
		`CPU: ${snapshot.visibleCpuCount} core / ${snapshot.cpuModel}`,
		`CPU制限(cgroup): ${cpuLimit}`,
		`メモリ(cgroup): ${cgroupMemory}`,
		`システムメモリ: ${formatRuntimeBytes(systemUsedBytes)} / ${formatRuntimeBytes(snapshot.systemMemoryTotalBytes)}`,
		`PID上限(cgroup): ${snapshot.cgroupPidsLimit?.toLocaleString("ja-JP") ?? "取得できませんでした"}`,
		`ディスク: ${disk}`,
		"",
		"security",
		"環境変数の値、ホスト名、コンテナID、認証情報は表示していません。",
	].join("\n");
}
