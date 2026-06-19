import fs from "node:fs";

export interface EntitySearchEntry {
	id: number;
	names: string[];
	url: string;
}

interface NameIndexEntry<T extends EntitySearchEntry> {
	name: string;
	entry: T;
}

export function normalizeSearchText(value: string): string {
	return value
		.trim()
		.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) =>
			String.fromCharCode(char.charCodeAt(0) - 0xfee0)
		)
		.toLowerCase()
		.replace(/[\u30a1-\u30f6]/g, (char) =>
			String.fromCharCode(char.charCodeAt(0) - 0x60)
		)
		.replace(/[~～〜]/g, "〜")
		.replace(/[－−‐⁃‑‒–—―-]/g, "ー");
}

function parseQuery(keyword: string): { query: string; force: boolean } {
	const parts = keyword.trim().split(/\s+/).filter(Boolean);
	const force = parts.some((part) => part === "-force" || part === "-f");
	return {
		query: parts.filter((part) => part !== "-force" && part !== "-f").join(" "),
		force,
	};
}

export function buildEntitySearch<T extends EntitySearchEntry>(jsonPath: string) {
	let loaded = false;
	const byId = new Map<number, T>();
	const nameIndex: NameIndexEntry<T>[] = [];
	const rawData: T[] = [];
	const cache = new Map<string, T[]>();

	function loadOnce(): void {
		if (loaded) return;
		const list = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as T[];
		list.sort((a, b) => a.id - b.id);
		for (const entry of list) {
			byId.set(entry.id, entry);
			rawData.push(entry);
			for (const name of entry.names) {
				nameIndex.push({ name: normalizeSearchText(name), entry });
			}
		}
		loaded = true;
	}

	return function search(keyword: string): T[] {
		const { query, force } = parseQuery(keyword);
		if (!query) return [];
		loadOnce();

		if (!force && /^\d+$/.test(query)) {
			const found = byId.get(Number(query));
			if (found) return [found];
		}

		const words = (force ? query : normalizeSearchText(query))
			.split(/\s+/)
			.filter(Boolean);
		const cacheKey = words.join(" ");
		if (!force) {
			const cached = cache.get(cacheKey);
			if (cached) return cached;
		}

		const resultSet = new Set<T>();
		if (force) {
			for (const entry of rawData) {
				const fullName = entry.names.join(" ");
				if (words.every((word) => fullName.includes(word))) resultSet.add(entry);
			}
		} else {
			for (const { name, entry } of nameIndex) {
				if (words.every((word) => name.includes(word))) resultSet.add(entry);
			}
		}

		const result = [...resultSet].sort((a, b) => a.id - b.id);
		if (!force) {
			cache.set(cacheKey, result);
			if (cache.size > 100) {
				const oldest = cache.keys().next().value;
				if (typeof oldest === "string") cache.delete(oldest);
			}
		}
		return result;
	};
}
