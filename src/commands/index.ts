import { appConfig } from "../config.js";
import type { LineCommand, ReplyableLineMessage } from "./shared.js";
import { gatyaCommand } from "./gatya.js";
import { itemCommand } from "./item.js";
import { saleCommand } from "./sale.js";

const commands = new Map<string, LineCommand>();

for (const command of [gatyaCommand, saleCommand, itemCommand]) {
	commands.set(command.name, command);
}

export async function handleLineCommand(messageText: string, message: ReplyableLineMessage): Promise<boolean> {
	if (!messageText.startsWith(appConfig.commandPrefix)) return false;
	const body = messageText.slice(appConfig.commandPrefix.length).trim();
	if (!body) return false;
	const [nameRaw, ...args] = body.split(/\s+/);
	const name = nameRaw.toLowerCase();
	const command = commands.get(name);
	if (!command) return false;
	await command.execute({ message, command: name, args });
	return true;
}
