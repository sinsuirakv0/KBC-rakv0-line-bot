import path from "node:path";

export const SEARCH_DATA_DIR = path.resolve(
	process.env.SEARCH_DATA_DIR || "./data/search",
);

export function searchDataPath(fileName: string): string {
	return path.join(SEARCH_DATA_DIR, fileName);
}
