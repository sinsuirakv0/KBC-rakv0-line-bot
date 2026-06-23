import type { LineCommand } from "./shared.js";

const COMMAND_LINES = [
	"!ping/応答確認",
	"!gatya/ガチャスケジュール検索",
	"!sale/セールスケジュール検索",
	"!item/アイテムスケジュール検索",
	"!ut/味方キャラ検索",
	"!tut/敵検索",
	"!st/ステージ検索",
	"!ranking/ランキング",
	"!push/プッシュ通知",
	"!コマンド helpでそのコマンドの使い方を表示します",
];

export const helpCommand: LineCommand = {
	name: "help",
	async execute({ message }) {
		await message.send(COMMAND_LINES.join("\n"));
	},
};
