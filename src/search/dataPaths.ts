import path from "node:path";

export const OMOROIRIE_DATA_DIR = path.resolve(
	process.env.OMOROIRIE_DATA_DIR || "./data/omoroirie",
);

export function omoroirieDataPath(fileName: string): string {
	return path.join(OMOROIRIE_DATA_DIR, fileName);
}
