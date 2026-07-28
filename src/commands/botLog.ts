import {
	permissionDeniedText,
	permissionStore,
	targetFromDestination,
} from "../permissions/store.js";
import { botLogRelay } from "../runtime/botLogRelay.js";
import type { CommandContext, LineCommand } from "./shared.js";

function helpText(): string {
	return [
		"!bot log on",
		"  botlogグループへの内部ログ転送を開始",
		"!bot log off",
		"  内部ログ転送を停止",
		"!bot log status",
		"  転送状態を表示",
		"!bot log test",
		"  テストログを送信",
		"",
		"!botlog でも同じ操作ができます。",
		"操作にはBOT管理者権限が必要です。",
	].join("\n");
}

function statusText(): string {
	const status = botLogRelay.snapshot();
	return [
		"BOTログ転送",
		`状態: ${status.enabled ? "ON" : "OFF"}`,
		`送信先: ${status.targetTalkMid}`,
		`LINE接続: ${status.clientReady ? "接続済み" : "未接続"}`,
		`送信待ち: ${status.queued}件`,
		`破棄: ${status.dropped}件`,
		`最終送信: ${status.lastSentAt ?? "なし"}`,
		`最終エラー: ${status.lastError ?? "なし"}`,
	].join("\n");
}

export async function executeBotLogCommand(
	command: CommandContext,
	args = command.args,
): Promise<void> {
	const { message } = command;
	const target = targetFromDestination(message.destination);
	if (!permissionStore.hasAtLeast(target, message.destination.senderMid, "admin")) {
		await message.send(permissionDeniedText("admin"));
		return;
	}

	const action = args[0]?.toLowerCase();
	if (!action || action === "help") {
		await message.send(helpText());
		return;
	}
	if (action === "status") {
		await message.send(statusText());
		return;
	}
	if (action === "on" || action === "off") {
		const enabled = action === "on";
		const result = await botLogRelay.setEnabled(enabled, message.destination.senderMid);
		await message.send(result === "unchanged"
			? `BOTログ転送はすでに${enabled ? "ON" : "OFF"}です。\n${statusText()}`
			: `BOTログ転送を${enabled ? "ON" : "OFF"}にしました。\n${statusText()}`);
		return;
	}
	if (action === "test") {
		if (!botLogRelay.snapshot().enabled) {
			await message.send("BOTログ転送はOFFです。先に !bot log on を実行してください。");
			return;
		}
		botLogRelay.emitTest(message.destination.senderMid);
		await message.send("テストログを送信キューへ追加しました。");
		return;
	}
	await message.send(helpText());
}

export const botLogCommand: LineCommand = {
	name: "botlog",
	async execute(command) {
		await executeBotLogCommand(command);
	},
};
