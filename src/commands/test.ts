import type { LineCommand } from "./shared.js";
import { sendLong } from "./shared.js";
import { notifyScheduleUpdate } from "../notifications/eventUpdates.js";
import { formatSquareEventDebugLog } from "../runtime/squareEventDebug.js";
import { probeRecentSquareHistory } from "../runtime/squareHistoryProbe.js";
import { pushSubscriptionStore } from "../subscriptions/store.js";

const EVENT_REPO_TREE_API =
	"https://api.github.com/repos/sinsuirakv0/KBC-rakv0-event/git/trees/main?recursive=1";
const EVENT_SITE_URL = process.env.EVENT_SITE_URL ?? "https://kbc-rakv0-event.vercel.app/";
const HISTORY_GROUP_SEC = 120;

interface GitTreeEntry {
	path: string;
}

async function fetchLatestHistory(): Promise<{ unix: number; types: string[] }> {
	const response = await fetch(EVENT_REPO_TREE_API, {
		signal: AbortSignal.timeout(10_000),
		headers: {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "KBC-rakv0-line-bot",
		},
	});
	if (!response.ok) throw new Error(`GitHub履歴取得失敗: HTTP ${response.status}`);

	const body = await response.json() as { tree?: GitTreeEntry[]; truncated?: boolean };
	if (body.truncated) throw new Error("GitHub履歴一覧が大きすぎるため取得できません");

	const files = (body.tree ?? []).flatMap((file) => {
		const match = file.path.match(/^raw\/(gatya|sale|item)_(\d+)\.tsv$/);
		return match ? [{ type: match[1], unix: Number(match[2]) }] : [];
	});
	if (files.length === 0) throw new Error("履歴ファイルが見つかりません");

	const unix = Math.max(...files.map((file) => file.unix));
	const types = [...new Set(
		files
			.filter((file) => unix - file.unix <= HISTORY_GROUP_SEC)
			.map((file) => file.type),
	)];
	return { unix, types };
}

function buildHistoryUrl(unix: number): string {
	const url = new URL(EVENT_SITE_URL);
	url.searchParams.set("tab", "history");
	url.searchParams.set("tsv", String(unix));
	url.searchParams.set("type", "all");
	return url.toString();
}

export const testCommand: LineCommand = {
	name: "test",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!test",
				"",
				"!test event-update",
				"  最新のスケジュール更新履歴を使って、登録済みの通知先へテスト通知を送信します。",
				"  このトークで使う前に !push skd を実行して通知先へ登録してください。",
				"!test thread [本文]",
				"  実行メッセージのスレッドへ送信できるか検証します。",
				"!test thread-log [件数]",
				"  直近のSquareイベント要約を表示します。",
				"!test oc-history",
				"  現在のOCトークから過去10件のイベントとシステムメッセージを取得します。",
			].join("\n"));
			return;
		}

		const action = args[0]?.toLowerCase();
		if (action === "thread") {
			const text = args.slice(1).join(" ").trim() || `thread test ${new Date().toISOString()}`;
			if (!message.sendThread) {
				await message.reply("この送信先はスレッド送信に対応していません。");
				return;
			}
			const lines = message.debugThread
				? await message.debugThread(text)
				: await message.sendThread(text).then((id) => [`sendThread=OK id=${id ?? "(unknown)"}`])
					.catch((error) => [`sendThread=ERROR ${error instanceof Error ? error.message : String(error)}`]);
			await sendLong(message, ["thread send debug", ...lines].join("\n"));
			return;
		}

		if (action === "thread-log" || action === "square-log") {
			const limit = Math.min(Math.max(Number(args[1] ?? 12) || 12, 1), 30);
			await sendLong(message, formatSquareEventDebugLog(limit));
			return;
		}

		if (action === "oc-history" || action === "square-history" || action === "oc-log") {
			if (message.destination.kind !== "square") {
				await message.reply("この検証コマンドはOpenChat内でのみ使用できます。");
				return;
			}
			try {
				const result = await probeRecentSquareHistory(
					message.client,
					message.destination.chatMid,
					10,
				);
				await sendLong(message, result.text);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				console.error("[test-square-history] failed", error);
				await message.reply(`Square履歴取得テストに失敗しました: ${reason}`);
			}
			return;
		}

		if (action !== "event-update") {
			await message.reply("使い方: !test event-update / !test thread / !test thread-log / !test oc-history");
			return;
		}
		if (!pushSubscriptionStore.has(message.destination)) {
			await message.reply("このトークを先に !push skd で通知先へ登録してください。");
			return;
		}

		await message.reply("最新のスケジュール更新履歴を取得しています...");
		try {
			const latest = await fetchLatestHistory();
			const result = await notifyScheduleUpdate(message.client, {
				types: latest.types,
				detectedAt: new Date().toISOString(),
				historyUrl: buildHistoryUrl(latest.unix),
				phase: "updated",
				test: true,
				testId: `line-command-${Date.now()}`,
			});
			await message.send(
				`テスト通知を送信しました。\n種類: ${latest.types.join(", ")}\n送信先: ${result.sent}件`,
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			await message.send(`テスト通知に失敗しました: ${reason}`);
		}
	},
};
