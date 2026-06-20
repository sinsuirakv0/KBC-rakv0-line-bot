import type { LineCommand } from "./shared.js";
import { notifyScheduleUpdate } from "../notifications/eventUpdates.js";
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
		if (args[0]?.toLowerCase() !== "event-update") {
			await message.reply("使い方: !test event-update");
			return;
		}
		if (!pushSubscriptionStore.has(message.destination)) {
			await message.reply("このトークを先に !pushskd で通知先へ登録してください。");
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
