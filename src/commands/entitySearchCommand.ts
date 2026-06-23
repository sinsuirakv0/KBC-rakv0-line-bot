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

const IMAGE_TIMEOUT_MS = 10_000;

function helpText(options: EntityCommandOptions): string {
	const aliases = options.aliases.length ? ` / !${options.aliases.join(" / !")}` : "";
	const formLine = options.forms
		? "\n!ut <名前またはID> origin f/c/s/u\n  指定した形態の画像を送信します。f=第一、c=第二、s=第三、u=特殊です。"
		: "";
	return [
		`!${options.name}${aliases}`,
		"",
		`!${options.name}`,
		"  検索ページのURLを表示します。",
		`!${options.name} <名前またはID>`,
		`  ${options.label}を検索します。候補が少ない時は詳細ページURL、多い時は一覧を返します。`,
		options.originImageUrl
			? `!${options.name} <名前またはID> origin\n  検索結果の先頭に一致した${options.label}の画像を送信します。`
			: "",
		formLine,
	].filter(Boolean).join("\n");
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

function imageFilename(url: string): string {
	const pathname = new URL(url).pathname;
	const name = pathname.split("/").filter(Boolean).at(-1);
	return name || "origin.png";
}

async function fetchImage(url: string): Promise<Blob> {
	const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`画像の取得に失敗しました: HTTP ${response.status}`);
	const type = response.headers.get("content-type") || "image/png";
	return new Blob([await response.arrayBuffer()], { type });
}

export function createEntitySearchCommand(options: EntityCommandOptions): LineCommand {
	return {
		name: options.name,
		aliases: options.aliases,
		async execute({ message, args }) {
			if (args[0]?.toLowerCase() === "help") {
				await message.reply(helpText(options));
				return;
			}

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
				const imageUrl = options.originImageUrl(entry, form);
				await message.reply(`${entry.id} ${entry.names[0]}`);
				await message.sendImage({
					blob: await fetchImage(imageUrl),
					filename: imageFilename(imageUrl),
				});
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
