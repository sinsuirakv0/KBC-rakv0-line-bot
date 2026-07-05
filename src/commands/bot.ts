import type { Client } from "@evex/linejs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import v8 from "node:v8";
import {
	botStopTargetFromDestination,
	botStopTargetLabel,
	permissionDeniedText,
	permissionStore,
	requiredPermissionLabel,
	roleLabel,
	targetFromDestination,
	type PermissionChatType,
	type PermissionRole,
} from "../permissions/store.js";
import { runtimeStore } from "../runtime/store.js";
import { argValue, parseTarget, targetLabel } from "./permissionArgs.js";
import type { LineCommand, LineDestination } from "./shared.js";

type RoleSnapshot = ReturnType<typeof permissionStore.snapshot>["roles"][number];
type SquareRole = string | number | undefined;

interface BenchmarkProfile {
	name: "light" | "normal" | "heavy";
	eventLoopMs: number;
	cpuMs: number;
	jsonRows: number;
	fileBytes: number;
}

interface BenchmarkResult {
	profile: BenchmarkProfile;
	elapsedMs: number;
	beforeMemory: NodeJS.MemoryUsage;
	afterMemory: NodeJS.MemoryUsage;
	systemTotalBytes: number;
	systemFreeBytes: number;
	heapLimitBytes: number;
	cpuModel: string;
	cpuCount: number;
	loadAverage: number[];
	eventLoop: {
		meanMs: number;
		p95Ms: number;
		maxMs: number;
	};
	cpu: {
		iterations: number;
		elapsedMs: number;
		opsPerSecond: number;
		cpuUsedMs: number;
		utilizationRatio: number;
		hash: number;
	};
	json: {
		rows: number;
		bytes: number;
		stringifyMs: number;
		parseMs: number;
		throughputMbps: number;
	};
	file: {
		bytes: number;
		writeMs: number;
		readMs: number;
		writeMbps: number;
		readMbps: number;
	};
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}日`);
	if (hours > 0) parts.push(`${hours}時間`);
	if (minutes > 0) parts.push(`${minutes}分`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
	return parts.join("");
}

function formatBytes(bytes: number): string {
	const mib = bytes / 1024 / 1024;
	return `${mib.toFixed(1)}MiB`;
}

function formatNumber(value: number): string {
	return Math.round(value).toLocaleString("ja-JP");
}

function formatMs(value: number): string {
	if (!Number.isFinite(value)) return "0.0ms";
	return `${value.toFixed(value >= 100 ? 0 : 1)}ms`;
}

function formatMbps(value: number): string {
	if (!Number.isFinite(value)) return "0.0MB/s";
	return `${value.toFixed(value >= 100 ? 0 : 1)}MB/s`;
}

function benchmarkProfile(value: string | undefined): BenchmarkProfile {
	const mode = value?.toLowerCase();
	if (mode === "light") {
		return { name: "light", eventLoopMs: 300, cpuMs: 120, jsonRows: 1_000, fileBytes: 512 * 1024 };
	}
	if (mode === "heavy") {
		return { name: "heavy", eventLoopMs: 1_000, cpuMs: 1_000, jsonRows: 20_000, fileBytes: 8 * 1024 * 1024 };
	}
	return { name: "normal", eventLoopMs: 600, cpuMs: 300, jsonRows: 5_000, fileBytes: 2 * 1024 * 1024 };
}

function helpText(): string {
	return [
		"!bot",
		"",
		"!bot status",
		"  稼働状態を表示",
		"!bot status test [light|normal|heavy]",
		"  BOT管理者用の性能テスト",
		"!bot stop",
		"  このトークでbotを停止",
		"!bot start",
		"  このトークでbotを再開",
		"!bot stop all",
		"  全てのトークでbotを停止",
		"!bot start all",
		"  全体停止を解除。個別停止は維持",
		"!bot admin [talkID:<MID>]",
		"  管理者/モデレーター一覧",
		"!bot setting status",
		"  自分のBOT実行権限を確認",
		"!bot setting admin/mod @ユーザー",
		"  現在のトークで登録",
		"!bot setting admin/mod del @ユーザー",
		"  現在のトークで解除",
		"!bot setting admin/mod userID:<MID> [talkID:<MID>] [del]",
		"  MID指定。talkIDは遠隔設定時のみ",
		"",
		"talkIDの種類は通常自動判定します。",
	].join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measureEventLoopDelay(durationMs: number): Promise<BenchmarkResult["eventLoop"]> {
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	await sleep(durationMs);
	histogram.disable();
	const meanMs = Number(histogram.mean) / 1_000_000;
	const p95Ms = Number(histogram.percentile(95)) / 1_000_000;
	const maxMs = Number(histogram.max) / 1_000_000;
	return {
		meanMs: Number.isFinite(meanMs) ? meanMs : 0,
		p95Ms: Number.isFinite(p95Ms) ? p95Ms : 0,
		maxMs: Number.isFinite(maxMs) ? maxMs : 0,
	};
}

function runCpuBenchmark(durationMs: number): BenchmarkResult["cpu"] {
	const started = performance.now();
	const cpuStarted = process.cpuUsage();
	let iterations = 0;
	let hash = 0x811c9dc5;
	while (performance.now() - started < durationMs) {
		for (let index = 0; index < 10_000; index++) {
			hash ^= iterations + index;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		iterations += 10_000;
	}
	const elapsedMs = performance.now() - started;
	const cpuUsed = process.cpuUsage(cpuStarted);
	const cpuUsedMs = (cpuUsed.user + cpuUsed.system) / 1_000;
	return {
		iterations,
		elapsedMs,
		opsPerSecond: iterations / Math.max(0.001, elapsedMs / 1_000),
		cpuUsedMs,
		utilizationRatio: cpuUsedMs / Math.max(1, elapsedMs),
		hash,
	};
}

function sampleLogRows(count: number): unknown[] {
	const rows: unknown[] = [];
	for (let index = 0; index < count; index++) {
		rows.push({
			id: `bench-${index}`,
			kind: "square",
			chatMid: "m-benchmark",
			scopeMid: "s-benchmark",
			chatType: "SQUARE",
			senderMid: `p${String(index % 500).padStart(32, "0")}`,
			senderName: `user-${index % 500}`,
			createdAt: Date.now() - index * 60_000,
			content: `検索テスト用メッセージ ${index} にゃんこ 大戦争 イベント ログ performance benchmark`,
			contentType: "0",
			metadata: { source: "benchmark", index },
		});
	}
	return rows;
}

async function runJsonBenchmark(rows: number): Promise<BenchmarkResult["json"]> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	const data = sampleLogRows(rows);
	const stringifyStarted = performance.now();
	const json = JSON.stringify(data);
	const stringifyMs = performance.now() - stringifyStarted;
	const bytes = Buffer.byteLength(json, "utf8");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const parseStarted = performance.now();
	JSON.parse(json) as unknown;
	const parseMs = performance.now() - parseStarted;
	const totalMs = stringifyMs + parseMs;
	return {
		rows,
		bytes,
		stringifyMs,
		parseMs,
		throughputMbps: bytes / 1024 / 1024 / Math.max(0.001, totalMs / 1_000),
	};
}

function benchmarkBuffer(bytes: number): Buffer {
	const buffer = Buffer.alloc(bytes);
	for (let index = 0; index < bytes; index += 4096) {
		buffer.writeUInt32LE((index * 2_654_435_761) >>> 0, index);
	}
	return buffer;
}

async function runFileBenchmark(bytes: number): Promise<BenchmarkResult["file"]> {
	const directory = path.resolve("./storage/benchmark");
	await fs.mkdir(directory, { recursive: true });
	const filePath = path.join(directory, `bot-status-test-${process.pid}-${Date.now()}.bin`);
	const buffer = benchmarkBuffer(bytes);
	try {
		const writeStarted = performance.now();
		await fs.writeFile(filePath, buffer);
		const writeMs = performance.now() - writeStarted;
		const readStarted = performance.now();
		const read = await fs.readFile(filePath);
		const readMs = performance.now() - readStarted;
		return {
			bytes: read.length,
			writeMs,
			readMs,
			writeMbps: bytes / 1024 / 1024 / Math.max(0.001, writeMs / 1_000),
			readMbps: bytes / 1024 / 1024 / Math.max(0.001, readMs / 1_000),
		};
	} finally {
		await fs.unlink(filePath).catch(() => {});
	}
}

async function runBenchmark(profile: BenchmarkProfile): Promise<BenchmarkResult> {
	const started = performance.now();
	const beforeMemory = process.memoryUsage();
	const eventLoop = await measureEventLoopDelay(profile.eventLoopMs);
	const cpu = runCpuBenchmark(profile.cpuMs);
	const json = await runJsonBenchmark(profile.jsonRows);
	const file = await runFileBenchmark(profile.fileBytes);
	const cpus = os.cpus();
	return {
		profile,
		elapsedMs: performance.now() - started,
		beforeMemory,
		afterMemory: process.memoryUsage(),
		systemTotalBytes: os.totalmem(),
		systemFreeBytes: os.freemem(),
		heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
		cpuModel: cpus[0]?.model || "unknown",
		cpuCount: typeof os.availableParallelism === "function" ? os.availableParallelism() : cpus.length,
		loadAverage: os.loadavg(),
		eventLoop,
		cpu,
		json,
		file,
	};
}

function performanceJudge(result: BenchmarkResult): string[] {
	const lines: string[] = [];
	if (result.eventLoop.p95Ms >= 100) {
		lines.push("イベントループ: 重い処理中に返信遅延が出やすい");
	} else if (result.eventLoop.p95Ms >= 40) {
		lines.push("イベントループ: やや余裕少なめ");
	} else {
		lines.push("イベントループ: 良好");
	}
	if (result.json.throughputMbps < 30) {
		lines.push("JSON検索: 大きいログの全走査は避けたい");
	} else if (result.json.throughputMbps < 80) {
		lines.push("JSON検索: 中規模なら可、索引があると安心");
	} else {
		lines.push("JSON検索: 余裕あり");
	}
	if (result.file.readMbps < 20 || result.file.writeMbps < 10) {
		lines.push("ディスク: 保存/検索の頻度を抑えたい");
	} else {
		lines.push("ディスク: 通常運用は問題なさそう");
	}
	return lines;
}

function benchmarkText(result: BenchmarkResult): string {
	const memoryDelta = result.afterMemory.rss - result.beforeMemory.rss;
	const estimatedFiveMiBParseMs = (5 / Math.max(0.001, result.json.throughputMbps)) * 1_000;
	const estimatedHundredMiBScanMs = (100 / Math.max(0.001, Math.min(result.json.throughputMbps, result.file.readMbps))) * 1_000;
	return [
		"bot status test",
		`mode: ${result.profile.name}`,
		`測定時間: ${formatMs(result.elapsedMs)}`,
		"",
		"system",
		`Node: ${process.version}`,
		`CPU: ${result.cpuCount} core / ${result.cpuModel}`,
		`LoadAvg: ${result.loadAverage.map((value) => value.toFixed(2)).join(", ")}`,
		`System Memory: ${formatBytes(result.systemTotalBytes - result.systemFreeBytes)} / ${formatBytes(result.systemTotalBytes)}`,
		`RSS: ${formatBytes(result.afterMemory.rss)} (${memoryDelta >= 0 ? "+" : ""}${formatBytes(memoryDelta)})`,
		`Heap: ${formatBytes(result.afterMemory.heapUsed)} / ${formatBytes(result.afterMemory.heapTotal)} / limit ${formatBytes(result.heapLimitBytes)}`,
		"",
		"benchmark",
		`EventLoop: mean ${formatMs(result.eventLoop.meanMs)} / p95 ${formatMs(result.eventLoop.p95Ms)} / max ${formatMs(result.eventLoop.maxMs)}`,
		`CPU loop: ${formatNumber(result.cpu.opsPerSecond)} ops/s / util ${(result.cpu.utilizationRatio * 100).toFixed(0)}%`,
		`JSON: ${formatNumber(result.json.rows)}件 ${formatBytes(result.json.bytes)} / stringify ${formatMs(result.json.stringifyMs)} / parse ${formatMs(result.json.parseMs)} / ${formatMbps(result.json.throughputMbps)}`,
		`File I/O: ${formatBytes(result.file.bytes)} / write ${formatMs(result.file.writeMs)} ${formatMbps(result.file.writeMbps)} / read ${formatMs(result.file.readMs)} ${formatMbps(result.file.readMbps)}`,
		"",
		"log検索の目安",
		`5MiBパート1個のJSON処理推定: ${formatMs(estimatedFiveMiBParseMs)}`,
		`100MiB全走査の最低推定: ${formatMs(estimatedHundredMiBScanMs)}`,
		"",
		"判定",
		...performanceJudge(result),
		"",
		"注意: LINE送信/API待ち時間、GitHub同期は測定していません。",
	].join("\n");
}

async function sendBenchmark(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args, progress } = command;
	const target = targetFromDestination(message.destination);
	if (!permissionStore.hasAtLeast(target, message.destination.senderMid, "admin")) {
		await message.send(permissionDeniedText("admin"));
		return;
	}
	const profile = benchmarkProfile(args[2]);
	await progress.update(`性能テストを開始します。mode: ${profile.name}`);
	try {
		const result = await runBenchmark(profile);
		await message.send(benchmarkText(result));
	} catch (error) {
		await message.send(`性能テストに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function settingHelpText(): string {
	return [
		"!bot setting",
		"",
		"!bot setting status",
		"  自分のBOT実行権限を確認",
		"!bot setting admin/mod @ユーザー",
		"  現在のトークで登録",
		"!bot setting admin/mod del @ユーザー",
		"  現在のトークで解除",
		"!bot setting admin/mod userID:<MID> [talkID:<MID>] [del]",
		"  MID指定。talkIDは遠隔設定時のみ",
		"",
		"talkIDの種類は通常自動判定します。",
	].join("\n");
}

function isOpenChatManagerRole(role: SquareRole): boolean {
	return role === 1 || role === 2 || role === "ADMIN" || role === "CO_ADMIN" ||
		role === "1" || role === "2";
}

async function isOpenChatManager(message: Parameters<LineCommand["execute"]>[0]["message"]): Promise<boolean> {
	if (message.destination.kind !== "square") return false;
	try {
		const response = await message.client.base.square.getSquareMember({
			squareMemberMid: message.destination.senderMid,
		});
		return isOpenChatManagerRole(response.squareMember.role);
	} catch (error) {
		console.warn(`[bot] failed to resolve OpenChat role for ${message.destination.senderMid}`, error);
		return false;
	}
}

async function canControlBotState(command: Parameters<LineCommand["execute"]>[0], all: boolean): Promise<boolean> {
	const { message } = command;
	const currentTarget = targetFromDestination(message.destination);
	if (permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) return true;
	if (all) return false;
	return await isOpenChatManager(message);
}

function botControlDeniedText(all: boolean): string {
	if (all) return permissionDeniedText("admin");
	return "実行権限がありません。BOT管理者、またはOpenChatの管理人/副官のみ操作できます。";
}

async function executeBotControl(
	command: Parameters<LineCommand["execute"]>[0],
	action: "start" | "stop",
): Promise<void> {
	const { message, args } = command;
	const all = args[1]?.toLowerCase() === "all";
	if (!await canControlBotState(command, all)) {
		await message.send(botControlDeniedText(all));
		return;
	}

	if (all) {
		if (action === "stop") {
			const result = permissionStore.stopBotAll(message.destination.senderMid);
			await permissionStore.flush();
			await message.send(result === "stopped"
				? "全体停止しました。全てのトークルーム/個人チャットでbotは動作しません。"
				: "すでに全体停止中です。");
			return;
		}

		const result = permissionStore.startBotAll();
		await permissionStore.flush();
		await message.send(result === "started"
			? "全体停止を解除しました。個別に停止していたトークは停止したままです。"
			: "全体停止は有効ではありません。個別停止は変更していません。");
		return;
	}

	const target = botStopTargetFromDestination(message.destination);
	if (action === "stop") {
		const result = permissionStore.stopBot(target, message.destination.senderMid);
		await permissionStore.flush();
		await message.send(result === "stopped"
			? `このトークでbotを停止しました。\n対象: ${botStopTargetLabel(target)}`
			: `このトークはすでに停止中です。\n対象: ${botStopTargetLabel(target)}`);
		return;
	}

	const result = permissionStore.startBot(target);
	await permissionStore.flush();
	const status = permissionStore.botStopStatus(target);
	const lines = [
		result === "started"
			? `このトークでbotを再開しました。\n対象: ${botStopTargetLabel(target)}`
			: `このトークは個別停止されていません。\n対象: ${botStopTargetLabel(target)}`,
	];
	if (status.allStopped) {
		lines.push("ただし全体停止中のため、!bot start all まで実際の動作は再開しません。");
	}
	await message.send(lines.join("\n"));
}

function rawUserName(raw: unknown): string | undefined {
	const value = raw as {
		targetProfileDetail?: { profileName?: string };
		profileName?: string;
		displayName?: string;
		name?: string;
	};
	return value.targetProfileDetail?.profileName || value.profileName || value.displayName || value.name;
}

async function resolveUserName(
	client: Client,
	chatType: PermissionChatType | LineDestination["chatType"],
	userMid: string,
	fallback?: string,
): Promise<string> {
	if (fallback) return fallback;
	try {
		if (chatType === "SQUARE") {
			const response = await client.base.square.getSquareMember({ squareMemberMid: userMid });
			return response.squareMember.displayName || "(名前なし)";
		}
		const user = await client.getUser(userMid);
		return rawUserName(user.raw) || "(名前なし)";
	} catch (error) {
		console.warn(`[bot] failed to resolve user name for ${userMid}`, error);
		return "(取得失敗)";
	}
}

async function adminListText(client: Client, chatType: PermissionChatType, roles: RoleSnapshot[]): Promise<string[]> {
	if (roles.length === 0) return ["  なし"];
	const lines: string[] = [];
	for (const role of roles) {
		const name = await resolveUserName(client, chatType, role.userMid);
		lines.push(`  ${roleLabel(role.role)}: ${name}`);
		lines.push(`  MID: ${role.userMid}`);
	}
	return lines;
}

async function sendAdminList(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const target = parseTarget(command.args.slice(1), command.message.destination);
	if (!target) {
		await command.message.send("対象トークを判定できませんでした。talkID:<MID> を指定してください。");
		return;
	}
	const snapshot = permissionStore.snapshot(target);
	await command.message.send([
		"BOT管理者一覧",
		`対象: ${targetLabel(target)}`,
		"管理者/モデレーター:",
		...(await adminListText(command.message.client, target.chatType, snapshot.roles)),
	].join("\n"));
}

async function sendPermissionStatus(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const target = parseTarget(args.slice(2), message.destination);
	if (!target) {
		await message.send("対象トークを判定できませんでした。talkID:<MID> を指定してください。");
		return;
	}
	const status = permissionStore.executionStatus(target, message.destination.senderMid);
	const name = await resolveUserName(
		message.client,
		message.destination.chatType,
		message.destination.senderMid,
		message.destination.senderName,
	);
	await message.send([
		"bot実行権限",
		`名前: ${name}`,
		`あなたの状態: ${status.banned ? "BAN" : "正常"}`,
		`権限: ${roleLabel(status.role)}`,
	].join("\n"));
}

function mentionedOrArgUserMid(command: Parameters<LineCommand["execute"]>[0]): string | undefined {
	return command.message.mentionMids[0] ||
		argValue(command.args, "userID") ||
		argValue(command.args, "userId") ||
		argValue(command.args, "userid");
}

async function executeSetting(command: Parameters<LineCommand["execute"]>[0]): Promise<void> {
	const { message, args } = command;
	const action = args[1]?.toLowerCase();
	const currentTarget = targetFromDestination(message.destination);
	if (!currentTarget) {
		await message.send("このコマンドはグループまたはOpenChatで実行してください。");
		return;
	}

	if (action === "help" || !action) {
		await message.send(settingHelpText());
		return;
	}

	if (action === "status") {
		await sendPermissionStatus(command);
		return;
	}

	if (action !== "admin" && action !== "mod") {
		await message.send("使い方: !bot setting [status|admin|mod]\n詳しくは !bot setting help");
		return;
	}

	if (!permissionStore.hasAtLeast(currentTarget, message.destination.senderMid, "admin")) {
		await message.send(permissionDeniedText("admin"));
		return;
	}

	const target = parseTarget(args.slice(2), message.destination);
	if (!target) {
		await message.send("対象トークを判定できませんでした。talkID:<MID> を指定してください。");
		return;
	}
	const userMid = mentionedOrArgUserMid(command);
	if (!userMid) {
		await message.send("対象ユーザーをメンションするか userID:<MID> を指定してください。");
		return;
	}

	const role = action as PermissionRole;
	const isDelete = args.some((arg) => arg.toLowerCase() === "del");
	if (isDelete) {
		const result = permissionStore.removeRole(target, userMid, role);
		await permissionStore.flush();
		await message.send(result === "removed"
			? `${requiredPermissionLabel(role)}を解除しました。\n対象: ${targetLabel(target)}`
			: `${requiredPermissionLabel(role)}は登録されていません。\n対象: ${targetLabel(target)}`);
		return;
	}

	const result = permissionStore.setRole(target, userMid, role, message.destination.senderMid);
	await permissionStore.flush();
	const verb = result === "created" ? "登録しました" : result === "updated" ? "更新しました" : "すでに登録されています";
	await message.send([
		`${requiredPermissionLabel(role)}を${verb}。`,
		`対象: ${targetLabel(target)}`,
		`ユーザーMID: ${userMid}`,
	].join("\n"));
}

export const botCommand: LineCommand = {
	name: "bot",
	async execute(command) {
		const { message, args } = command;
		const action = args[0]?.toLowerCase();
		if (action === "help") {
			await message.send(helpText());
			return;
		}

		if (action === "admin") {
			await sendAdminList(command);
			return;
		}

		if (action === "setting") {
			await executeSetting(command);
			return;
		}

		if (action === "stop" || action === "start") {
			await executeBotControl(command, action);
			return;
		}

		if (action !== "status") {
			await message.send("使い方: !bot [status|start|stop|admin|setting]\n詳しくは !bot help");
			return;
		}

		if (args[1]?.toLowerCase() === "test") {
			await sendBenchmark(command);
			return;
		}

		const status = runtimeStore.snapshot();
		const stopTarget = botStopTargetFromDestination(message.destination);
		const stopStatus = permissionStore.botStopStatus(stopTarget);
		await message.send([
			"bot status",
			`動作状態: ${stopStatus.stopped ? "停止中" : "稼働中"}`,
			`全体停止: ${stopStatus.allStopped ? "有効" : "無効"}`,
			`このトークの個別停止: ${stopStatus.targetStopped ? "有効" : "無効"}`,
			`現在の稼働時間: ${formatDuration(status.sessionUptimeMs)}`,
			`累計稼働時間: ${formatDuration(status.totalUptimeMs)}`,
			`メモリ使用率: ${(status.systemUsedRatio * 100).toFixed(1)}%`,
			`プロセスRSS: ${formatBytes(status.rssBytes)}`,
			`ヒープ: ${formatBytes(status.heapUsedBytes)} / ${formatBytes(status.heapTotalBytes)}`,
		].join("\n"));
	},
};
