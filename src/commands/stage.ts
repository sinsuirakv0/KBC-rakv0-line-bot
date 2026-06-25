import { getStageUrl, searchStages } from "../search/stageSearch.js";
import type { LineCommand } from "./shared.js";
import { sendError } from "./shared.js";
import { sendSearchResults } from "./searchPages.js";

interface StageResult {
	id: string;
	name: string;
	type: "map" | "stage";
}

export const stageCommand: LineCommand = {
	name: "stage",
	aliases: ["st"],
	async execute({ message, args }) {
		if (args[0]?.toLowerCase() === "help") {
			await message.reply([
				"!st",
				"",
				"!st",
				"  ステージ検索ページのURLを表示します。",
				"!st <名前またはID>",
				"  マップ名やステージ名を検索します。候補が少ない時は詳細ページURL、多い時は一覧を返します。",
				"!st <検索語> -f",
				"  正規化せずに元の名前へ直接検索します。通常検索で拾えない表記を探す時に使います。",
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

		await sendSearchResults(
			message,
			`ステージ「${query}」検索結果`,
			results.map((result) => `${result.id} ${result.name}`),
		);
	},
};
