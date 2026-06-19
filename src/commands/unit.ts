import { buildEntitySearch, type EntitySearchEntry } from "../search/entitySearch.js";
import { omoroirieDataPath } from "../search/dataPaths.js";
import { createEntitySearchCommand } from "./entitySearchCommand.js";

const searchUnits = buildEntitySearch<EntitySearchEntry>(omoroirieDataPath("charaname.json"));

export const unitCommand = createEntitySearchCommand({
	name: "unit",
	aliases: ["ut"],
	label: "ユニット",
	searchPageUrl: "https://jarjarblink.github.io/JDB/unit_search.html?cc=ja",
	search: searchUnits,
	forms: ["f", "c", "s", "u"],
	originImageUrl(entry, form = "f") {
		const id = String(entry.id).padStart(3, "0");
		return `https://jarjarblink.github.io/JDB/static/img/unit_icon/uni${id}_${form}00.png`;
	},
});
