import { buildEntitySearch, type EntitySearchEntry } from "../search/entitySearch.js";
import { omoroirieDataPath } from "../search/dataPaths.js";
import { createEntitySearchCommand } from "./entitySearchCommand.js";

const searchEnemies = buildEntitySearch<EntitySearchEntry>(omoroirieDataPath("enemyname.json"));

export const enemyCommand = createEntitySearchCommand({
	name: "enemy",
	aliases: ["tut"],
	label: "敵ユニット",
	searchPageUrl: "https://jarjarblink.github.io/JDB/tunit_search.html?cc=ja",
	search: searchEnemies,
	originImageUrl(entry) {
		const id = String(entry.id).padStart(3, "0");
		return `https://ponosgames.com/information/appli/battlecats/stage/img/enemy/enemy_icon_${id}.png`;
	},
});
