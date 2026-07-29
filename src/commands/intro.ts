import {
	collectRuntimeEnvironment,
	type RuntimeEnvironmentSnapshot,
} from "../runtime/environment.js";
import type { LineCommand } from "./shared.js";

function displayPlatform(snapshot: RuntimeEnvironmentSnapshot): string {
	const name = snapshot.platform === "linux"
		? "Linux"
		: snapshot.platform === "win32"
			? "Windows"
			: snapshot.platform;
	return `${name} ${snapshot.release} ${snapshot.architecture}`;
}

function displayCpuModel(model: string): string {
	return model
		.replace(/\(R\)/gi, "")
		.replace(/\bCPU\b/gi, "")
		.replace(/\bINTEL\b/gi, "Intel")
		.replace(/\bXEON\b/gi, "Xeon")
		.replace(/\bPLATINUM\b/gi, "Platinum")
		.replace(/\s+/g, " ")
		.trim();
}

function displayCpuAllocation(snapshot: RuntimeEnvironmentSnapshot): string {
	if (snapshot.cgroupCpuLimitCores === undefined) {
		return `約${snapshot.visibleCpuCount}コア`;
	}
	return `約${snapshot.cgroupCpuLimitCores.toFixed(snapshot.cgroupCpuLimitCores < 1 ? 1 : 2)}コア`;
}

function displayMemoryAllocation(snapshot: RuntimeEnvironmentSnapshot): string {
	const bytes = snapshot.cgroupMemoryLimitBytes ?? snapshot.systemMemoryTotalBytes;
	return `約${Math.round(bytes / 1024 / 1024)}MiB`;
}

function displayV8Version(version: string): string {
	return version.split(".").slice(0, 2).join(".");
}

export function introText(snapshot: RuntimeEnvironmentSnapshot): string {
	return [
		"こんにちは！超健康botのMuninです！",
		"",
		"私はKBCprojectの一環として開発されている、二対のbotの片割れです",
		"",
		"Northflankの小さなコンテナで動作しています。",
		`OS: ${displayPlatform(snapshot)}`,
		`頭脳: Node.js ${snapshot.nodeVersion} / V8 ${displayV8Version(snapshot.v8Version)}`,
		`CPU: ${displayCpuModel(snapshot.cpuModel)}`,
		`割り当て: ${displayCpuAllocation(snapshot)} / メモリ${displayMemoryAllocation(snapshot)}`,
		"保存先: GitHub連携ストレージ",
		"状態: 省エネでがんばってます",
		"",
		"まだ育成途中ですが、健康第一で働きます！",
		"コマンド一覧は !help をどうぞ。",
	].join("\n");
}

export const introCommand: LineCommand = {
	name: "intro",
	policy: { progress: "none" },
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.send("!intro\nMuninの自己紹介と現在の動作環境を表示します。");
			return;
		}
		try {
			await message.send(introText(await collectRuntimeEnvironment()));
		} catch (error) {
			console.error("[intro] environment collection failed", error);
			await message.send("こんにちは！超健康botのMuninです！\n自己紹介用の環境情報を取得できませんでした。");
		}
	},
};
