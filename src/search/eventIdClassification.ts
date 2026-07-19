interface IdRange {
	from: number;
	to: number;
	type?: string;
	label?: string;
}

export interface EventIdClassification {
	id: number;
	kind: "sale" | "mission";
	tagLabel: string;
	displayType: string | null;
	displayCode: string | null;
	jdbUrl: string | null;
	dbUrl: string | null;
	stageProxyUrl: string | null;
}

const STAGE_TYPE_RANGES: IdRange[] = [
	{ from: 1_000, to: 1_999, type: "S" },
	{ from: 2_000, to: 2_999, type: "C" },
	{ from: 4_000, to: 4_999, type: "E" },
	{ from: 6_000, to: 6_999, type: "T" },
	{ from: 7_000, to: 7_999, type: "V" },
	{ from: 11_000, to: 11_999, type: "R" },
	{ from: 12_000, to: 12_999, type: "M" },
	{ from: 13_000, to: 13_999, type: "NA" },
	{ from: 14_000, to: 14_999, type: "B" },
	{ from: 16_000, to: 16_999, type: "D" },
	{ from: 24_000, to: 24_999, type: "A" },
	{ from: 25_000, to: 25_999, type: "H" },
	{ from: 27_000, to: 27_999, type: "CA" },
	{ from: 30_000, to: 30_999, type: "DM" },
	{ from: 31_000, to: 31_999, type: "Q" },
	{ from: 33_000, to: 33_999, type: "L" },
	{ from: 34_000, to: 34_999, type: "ND" },
	{ from: 36_000, to: 36_999, type: "SR" },
	{ from: 37_000, to: 37_999, type: "G" },
];

const STAGE_DISPLAY_TYPE_RANGES: IdRange[] = STAGE_TYPE_RANGES.map((entry) => ({
	...entry,
	type: entry.from === 1_000 ? "A" : entry.from === 24_000 ? "S" : entry.type,
}));

const STAGE_TAG_RANGES: IdRange[] = [
	{ from: 1_000, to: 1_999, label: "イベント" },
	{ from: 2_000, to: 2_999, label: "コラボ" },
	{ from: 4_000, to: 4_999, label: "EX" },
	{ from: 5_000, to: 5_999, label: "ガマトト" },
	{ from: 6_000, to: 6_999, label: "道場" },
	{ from: 7_000, to: 7_999, label: "にゃんこ塔" },
	{ from: 8_000, to: 8_999, label: "ウィークリー" },
	{ from: 9_000, to: 9_999, label: "スペシャル" },
	{ from: 10_000, to: 10_999, label: "進化権" },
	{ from: 11_000, to: 11_999, label: "極道場" },
	{ from: 14_000, to: 14_999, label: "ビタン" },
	{ from: 15_000, to: 15_999, label: "メイン" },
	{ from: 17_000, to: 17_999, label: "マンスリー" },
	{ from: 18_000, to: 18_999, label: "猫缶" },
	{ from: 24_000, to: 24_999, label: "強襲" },
	{ from: 25_000, to: 25_999, label: "地図ステ" },
	{ from: 26_000, to: 26_999, label: "地図グル" },
	{ from: 27_000, to: 27_999, label: "コラボ強襲" },
	{ from: 28_000, to: 28_999, label: "第三解放" },
	{ from: 31_000, to: 31_999, label: "超獣" },
	{ from: 33_000, to: 33_999, label: "地底迷宮" },
	{ from: 35_000, to: 35_999, label: "ログボ" },
	{ from: 36_000, to: 36_999, label: "コロシアム" },
	{ from: 37_000, to: 37_999, label: "検定" },
];

function findRange(id: number, ranges: IdRange[]): IdRange | undefined {
	return ranges.find((entry) => id >= entry.from && id <= entry.to);
}

export function isMissionEventId(id: number): boolean {
	return (id >= 8_000 && id <= 8_999) ||
		(id >= 9_000 && id <= 9_999) ||
		(id >= 15_000 && id <= 15_999) ||
		(id >= 17_000 && id <= 17_999);
}

export function missionLookupId(id: number): number {
	return id >= 15_000 && id <= 15_999 ? id - 15_000 : id;
}

export function getStageDisplayType(id: number): string | null {
	return findRange(id, STAGE_DISPLAY_TYPE_RANGES)?.type ?? null;
}

export function getStageDisplayCode(id: number): string | null {
	const entry = findRange(id, STAGE_DISPLAY_TYPE_RANGES);
	if (!entry?.type) return null;
	return `${entry.type}${String(id - entry.from).padStart(3, "0")}`;
}

export function classifyEventId(id: number): EventIdClassification {
	const external = findRange(id, STAGE_TYPE_RANGES);
	const tag = findRange(id, STAGE_TAG_RANGES);
	const displayType = getStageDisplayType(id);
	const displayCode = getStageDisplayCode(id);
	const externalCode = external?.type ? String(id - external.from).padStart(3, "0") : null;
	return {
		id,
		kind: isMissionEventId(id) ? "mission" : "sale",
		tagLabel: tag?.label ?? "その他",
		displayType,
		displayCode,
		jdbUrl: external?.type && externalCode
			? `https://jarjarblink.github.io/JDB/map.html?cc=ja&type=${external.type}&map=${externalCode}`
			: null,
		dbUrl: external
			? `https://battlecats-db.com/stage/s${String(id).padStart(5, "0")}.html`
			: null,
		stageProxyUrl: external?.type && externalCode
			? `https://kbc-rakv0.vercel.app/stage/${external.type}${externalCode}.html`
			: null,
	};
}

export function formatEventIdTags(id: number): string {
	const classification = classifyEventId(id);
	return [
		classification.kind,
		classification.tagLabel,
		classification.displayCode,
	].filter(Boolean).join(" / ");
}
