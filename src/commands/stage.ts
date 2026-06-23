import { getStageUrl, searchStages } from "../search/stageSearch.js";
import type { LineCommand } from "./shared.js";
import { sendError, sendLong } from "./shared.js";

interface StageResult {
	id: string;
	name: string;
	type: "map" | "stage";
}

function formatList(query: string, results: StageResult[]): string {
	const shown = results.slice(0, 20);
	const lines = [
		`ステージ「${query}」検索結果 (${results.length}件)`,
		...shown.map((result) => `${result.id} ${result.name}`),
	];
	if (results.length > shown.length) lines.push(`...ほか ${results.length - shown.length}件`);
	return lines.join("\n");
}

export const stageCommand: LineCommand = {
	name: "stage",
	aliases: ["st"],
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!stage / !st",
				"",
				"!stage",
				"  ステージ検索ページのURLを表示します。",
				"!stage <名前またはID>",
				"  マップ名やステージ名を検索します。候補が少ない時は詳細ページURL、多い時は一覧を返します。",
			].join("\n"));
			return;
		}

		if (args.length === 0) {
			await message.reply("https://jarjarblink.github.io/JDB/map_search.html?cc=ja");
			return;
		}

		const query = args.join(" ").trim();
		if (!query) {
			await sendError(message, "検索語を指定してください");
			return;
		}

		const found = searchStages(query);
		const results: StageResult[] = [
			...found.maps.map((map) => ({ id: map.mapId, name: map.mapName, type: "map" as const })),
			...found.stages.map((stage) => ({ id: stage.stageId, name: stage.stageName, type: "stage" as const })),
		];
		if (results.length === 0) {
			await sendError(message, "該当するステージが見つかりませんでした");
			return;
		}

		if (results.length <= 3) {
			for (let index = 0; index < results.length; index++) {
				const result = results[index];
				const body = `${result.id} ${result.name}\n${getStageUrl(result.id)}`;
				if (index === 0) await message.reply(body);
				else await message.send(body);
			}
			return;
		}

		await sendLong(message, formatList(query, results));
	},
};
