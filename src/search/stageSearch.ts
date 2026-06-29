import fs from "node:fs";
import path from "node:path";
import { normalizeSearchText } from "./entitySearch.js";
import { SEARCH_DATA_DIR, searchDataPath } from "./dataPaths.js";

export interface StageEntry {
	stageIdRaw: number;
	stageId: string;
	stageName: string;
	mapIdRaw: number;
	mapId: string;
	mapName: string;
}

export interface MapEntry {
	mapIdRaw: number;
	mapId: string;
	mapName: string;
}

const CATEGORY_TABLE: Record<number, string> = {
	0: "N",
	1: "S",
	2: "C",
	4: "E",
	6: "T",
	7: "V",
	11: "R",
	12: "M",
	13: "NA",
	14: "B",
	16: "D",
	20: "0Z",
	21: "1Z",
	22: "2Z",
	23: "2_Inv",
	24: "A",
	25: "H",
	27: "CA",
	30: "DM",
	31: "Q",
	33: "L",
	34: "ND",
	36: "SR",
	37: "G",
	38: "2Z_Inv",
};

let loadedData: { stages: StageEntry[]; maps: MapEntry[] } | undefined;

function encodeMapId(rawId: number): string {
	if (rawId >= 3000 && rawId <= 3008) {
		const base = rawId - 3000;
		return `${Math.floor(base / 3)}${(base % 3).toString().padStart(3, "0")}`;
	}
	if (rawId >= 20000 && rawId <= 22002) {
		const type = `${Math.floor((rawId - 20000) / 1000)}Z`;
		return `${type}${(rawId % 1000).toString().padStart(3, "0")}`;
	}
	if (rawId === 23000) return "2_Inv000";
	if (rawId === 38000) return "2Z_Inv000";
	const upper = Math.floor(rawId / 1000);
	const index = rawId % 1000;
	return `${CATEGORY_TABLE[upper] ?? upper.toString()}${index.toString().padStart(3, "0")}`;
}

function loadData(): { stages: StageEntry[]; maps: MapEntry[] } {
	if (loadedData) return loadedData;
	const stages: StageEntry[] = [];
	const maps: MapEntry[] = [];
	const mapNames = new Map<number, string>();

	for (const line of fs.readFileSync(searchDataPath("Map_Name.csv"), "utf8").split(/\r?\n/)) {
		if (!line || line === "@") continue;
		const comma = line.indexOf(",");
		if (comma < 0) continue;
		const raw = Number(line.slice(0, comma).trim());
		const name = line.slice(comma + 1).trim();
		if (!Number.isFinite(raw) || !name) continue;
		mapNames.set(raw, name);
		maps.push({ mapIdRaw: raw, mapId: encodeMapId(raw), mapName: name });
	}

	const files = fs.readdirSync(SEARCH_DATA_DIR)
		.filter((file) => file.startsWith("StageName") && file.endsWith("_ja.csv"))
		.sort();
	for (const file of files) {
		const category = file.replace(/^StageName_?/, "").replace(/_ja\.csv$/, "");
		if (category === "3") continue;
		const numericCategory = /^\d+$/.test(category);
		const lines = fs.readFileSync(path.join(SEARCH_DATA_DIR, file), "utf8").split(/\r?\n/);
		for (let mapIndex = 0; mapIndex < lines.length; mapIndex++) {
			const names = lines[mapIndex].split(",").map((name) => name.trim())
				.filter((name) => name && name !== "@" && name !== "＠");
			if (names.length === 0) continue;

			let mapIdRaw = -1;
			let mapId: string;
			if (category === "0" || category === "1" || category === "2") {
				mapIdRaw = 3000 + Number(category) * 3 + mapIndex;
				mapId = encodeMapId(mapIdRaw);
			} else if (numericCategory) {
				mapIdRaw = Number(category) * 1000 + mapIndex;
				mapId = encodeMapId(mapIdRaw);
			} else {
				mapId = `${category}${mapIndex.toString().padStart(3, "0")}`;
			}
			const mapName = mapIdRaw >= 0 ? mapNames.get(mapIdRaw) ?? category : category;
			for (let stageIndex = 0; stageIndex < names.length; stageIndex++) {
				stages.push({
					stageIdRaw: mapIdRaw >= 0 ? mapIdRaw * 1000 + stageIndex : -1,
					stageId: `${mapId}-${stageIndex.toString().padStart(3, "0")}`,
					stageName: names[stageIndex],
					mapIdRaw,
					mapId,
					mapName,
				});
			}
		}
	}

	loadedData = { stages, maps };
	return loadedData;
}

function isStageIdQuery(value: string): boolean {
	return /^[a-z0-9_]+-[0-9]+$/i.test(value);
}

function isMapIdQuery(value: string): boolean {
	return /^[a-z]+[0-9]+$/i.test(value) || /^\d+$/.test(value);
}

export function getStageUrl(fullId: string): string {
	const [mapPart, stagePart] = fullId.split("-");
	const match = mapPart.match(/^(.*?)(\d{3})$/);
	const type = match ? match[1] : mapPart.replace(/\d+$/, "");
	const map = Number(match ? match[2] : mapPart.match(/\d+$/)?.[0] ?? 0);
	const stage = stagePart === undefined ? "" : `&stage=${Number(stagePart)}`;
	return `https://jarjarblink.github.io/JDB/map.html?cc=ja&type=${type}&map=${map}${stage}`;
}

export function getStageDisplayId(entry: StageEntry | MapEntry): string {
	if (entry.mapIdRaw >= 3000 && entry.mapIdRaw <= 3008 || entry.mapIdRaw >= 20000 && entry.mapIdRaw <= 22002) {
		if ("stageId" in entry) {
			return `${entry.mapIdRaw}-${entry.stageId.split("-")[1]}`;
		}
		return String(entry.mapIdRaw);
	}
	return "stageId" in entry ? entry.stageId : entry.mapId;
}

export function searchStages(keyword: string): { stages: StageEntry[]; maps: MapEntry[] } {
	const data = loadData();
	const parts = keyword.trim().replace(/　/g, " ").split(/\s+/).filter(Boolean);
	const force = parts.some((part) => part === "-force" || part === "-f");
	const raw = parts.filter((part) => part !== "-force" && part !== "-f").join(" ");
	if (!raw) return { stages: [], maps: [] };

	const key = raw.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) =>
		String.fromCharCode(char.charCodeAt(0) - 0xfee0)
	).toLowerCase();
	let stages: StageEntry[] = [];
	let maps: MapEntry[] = [];
	if (!force && !/\s/.test(key) && (isStageIdQuery(key) || isMapIdQuery(key))) {
		if (key.includes("-")) {
			stages = data.stages.filter((stage) => stage.stageId.toLowerCase().startsWith(key));
		} else {
			maps = data.maps.filter((map) =>
				map.mapId.toLowerCase().startsWith(key) || map.mapIdRaw.toString() === key
			);
		}
	}

	const words = (force ? raw : normalizeSearchText(raw)).split(/\s+/).filter(Boolean);
	const matchesName = (name: string) => {
		if (!name || name === "@" || name === "＠") return false;
		const target = force ? name : normalizeSearchText(name);
		return words.every((word) => target.includes(word));
	};
	for (const stage of data.stages) {
		if (matchesName(stage.stageName) && !stages.some((item) => item.stageId === stage.stageId)) {
			stages.push(stage);
		}
	}
	for (const map of data.maps) {
		if (matchesName(map.mapName) && !maps.some((item) => item.mapId === map.mapId)) {
			maps.push(map);
		}
	}
	return { stages, maps };
}
