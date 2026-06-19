import type { EntitySearchEntry } from "../search/entitySearch.js";
import type { LineCommand } from "./shared.js";
import { sendError, sendLong } from "./shared.js";

interface EntityCommandOptions {
	name: string;
	aliases: string[];
	label: string;
	searchPageUrl: string;
	search: (keyword: string) => EntitySearchEntry[];
	originImageUrl?: (entry: EntitySearchEntry, form?: string) => string;
	forms?: string[];
}

function formatList(label: string, query: string, entries: EntitySearchEntry[]): string {
	const shown = entries.slice(0, 20);
	const lines = [
		`${label}「${query}」検索結果 (${entries.length}件)`,
		...shown.map((entry) => `${entry.id} ${entry.names[0]}`),
	];
	if (entries.length > shown.length) lines.push(`...ほか ${entries.length - shown.length}件`);
	return lines.join("\n");
}

export function createEntitySearchCommand(options: EntityCommandOptions): LineCommand {
	return {
		name: options.name,
		aliases: options.aliases,
		async execute({ message, args }) {
			if (args.length === 0) {
				await message.reply(options.searchPageUrl);
				return;
			}

			const hasOrigin = args.some((arg) => arg.toLowerCase() === "origin");
			const form = args.find((arg) => options.forms?.includes(arg.toLowerCase()))?.toLowerCase();
			const queryArgs = args.filter((arg) => {
				const lower = arg.toLowerCase();
				return lower !== "origin" && !options.forms?.includes(lower);
			});
			const query = queryArgs.join(" ").trim();
			if (!query) {
				await sendError(message, "検索語を指定してください");
				return;
			}

			const result = options.search(query);
			if (result.length === 0) {
				await sendError(message, `該当する${options.label}が見つかりませんでした`);
				return;
			}

			if (hasOrigin && queryArgs.length === 1 && options.originImageUrl) {
				const entry = result[0];
				await message.reply(`${entry.id} ${entry.names[0]}\n${options.originImageUrl(entry, form)}`);
				return;
			}

			if (result.length <= 3) {
				for (let index = 0; index < result.length; index++) {
					const entry = result[index];
					const body = `${entry.id} ${entry.names[0]}\n${entry.url}`;
					if (index === 0) await message.reply(body);
					else await message.send(body);
				}
				return;
			}

			await sendLong(message, formatList(options.label, query, result));
		},
	};
}
