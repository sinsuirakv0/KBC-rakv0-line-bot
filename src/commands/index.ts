import { appConfig } from "../config.js";
import type { LineCommand, ReplyableLineMessage } from "./shared.js";
import { startCommandProgress } from "./progress.js";
import { banCommand } from "./ban.js";
import { botCommand } from "./bot.js";
import { enemyCommand } from "./enemy.js";
import { eventCommand } from "./event.js";
import { gatyaCommand } from "./gatya.js";
import { helpCommand } from "./help.js";
import { idCommand } from "./id.js";
import { itemCommand } from "./item.js";
import { logCommand } from "./log.js";
import { ocCommand } from "./oc.js";
import { pushCommand } from "./push.js";
import { rankingCommand } from "./ranking.js";
import { saleCommand } from "./sale.js";
import { stageCommand } from "./stage.js";
import { testCommand } from "./test.js";
import { unitCommand } from "./unit.js";
import { rankingStore } from "../ranking/store.js";

const commands = new Map<string, LineCommand>();

for (const command of [
	gatyaCommand,
	idCommand,
	logCommand,
	saleCommand,
	itemCommand,
	unitCommand,
	enemyCommand,
	eventCommand,
	stageCommand,
	ocCommand,
	pushCommand,
	rankingCommand,
	banCommand,
	testCommand,
	helpCommand,
	botCommand,
]) {
	commands.set(command.name, command);
	for (const alias of command.aliases ?? []) commands.set(alias, command);
}

export async function handleLineCommand(messageText: string, message: ReplyableLineMessage): Promise<boolean> {
	if (!messageText.startsWith(appConfig.commandPrefix)) return false;
	const body = messageText.slice(appConfig.commandPrefix.length).trim();
	if (!body) return false;
	const [nameRaw, ...args] = body.split(/\s+/);
	const name = nameRaw.toLowerCase();
	const command = commands.get(name);
	if (!command) return false;
	rankingStore.record(message.destination);
	const progress = await startCommandProgress(message, name);
	try {
		await command.execute({ message, command: name, args, progress });
	} finally {
		await progress.finish();
	}
	return true;
}
