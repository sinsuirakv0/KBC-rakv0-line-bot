import { runtimeStore } from "../runtime/store.js";
import type { LineCommand } from "./shared.js";

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

export const botCommand: LineCommand = {
	name: "bot",
	async execute({ message, args }) {
		const action = args[0]?.toLowerCase();
		if (action === "help") {
			await message.send([
				"!bot",
				"",
				"!bot status",
				"  現在の稼働時間、累計稼働時間、メモリ使用状況を表示します。",
			].join("\n"));
			return;
		}

		if (action !== "status") {
			await message.send("使い方: !bot status");
			return;
		}

		const status = runtimeStore.snapshot();
		await message.send([
			"bot status",
			`現在の稼働時間: ${formatDuration(status.sessionUptimeMs)}`,
			`累計稼働時間: ${formatDuration(status.totalUptimeMs)}`,
			`メモリ使用率: ${(status.systemUsedRatio * 100).toFixed(1)}%`,
			`プロセスRSS: ${formatBytes(status.rssBytes)}`,
			`ヒープ: ${formatBytes(status.heapUsedBytes)} / ${formatBytes(status.heapTotalBytes)}`,
		].join("\n"));
	},
};
