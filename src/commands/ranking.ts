import { rankingStore } from "../ranking/store.js";
import type { LineCommand } from "./shared.js";

const DEFAULT_START = 1;
const DEFAULT_END = 10;
const MAX_RESULTS = 50;

function parseRange(value: string | undefined): { start: number; end: number } | null {
	if (value === undefined) return { start: DEFAULT_START, end: DEFAULT_END };
	const match = value.match(/^(\d+)~(\d+)$/);
	if (!match) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (start < 1 || end < start || end - start + 1 > MAX_RESULTS) return null;
	return { start, end };
}

export const rankingCommand: LineCommand = {
	name: "ranking",
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.send([
				"!ranking",
				"",
				"!ranking",
				"  このトーク内のコマンド実行回数ランキングを1位から10位まで表示します。",
				"!ranking 4~14",
				"  指定した順位範囲を表示します。1回に表示できるのは最大50人までです。",
				"!ranking updatede",
				"  現在のランキングJSONをline-dataへ手動保存します。",
			].join("\n"));
			return;
		}

		if (args[0]?.toLowerCase() === "updatede" || args[0]?.toLowerCase() === "update") {
			await rankingStore.flush();
			await message.send("ランキングJSONを手動更新しました。");
			return;
		}

		const range = parseRange(args[0]);
		if (!range || args.length > 1) {
			await message.send("使い方: !ranking または !ranking 4~14\n一度に表示できるのは50人までです。");
			return;
		}

		const ranking = rankingStore.get(message.destination);
		const rows = ranking.users.slice(range.start - 1, range.end);
		const lines = rows.length > 0
			? rows.map((user, index) => `${range.start + index}位 ${user.name} ${user.count}回`)
			: ["該当する順位はありません"];
		await message.send([
			...lines,
			`トーク内累計実行回数: ${ranking.scopeTotalCommands}回`,
			`全トークの累計実行回数: ${ranking.totalCommands}回`,
		].join("\n"));
	},
};
