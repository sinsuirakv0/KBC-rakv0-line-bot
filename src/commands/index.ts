import { appConfig } from "../config.js";
import type {
	CommandPolicy,
	LineCommand,
	ReplyableLineMessage,
} from "./shared.js";
import { startCommandProgress } from "./progress.js";
import { banCommand } from "./ban.js";
import { botCommand } from "./bot.js";
import { enemyCommand } from "./enemy.js";
import { eventCommand } from "./event.js";
import { gatyaCommand } from "./gatya.js";
import { helpCommand } from "./help.js";
import { idCommand } from "./id.js";
import { itemCommand } from "./item.js";
import { introCommand } from "./intro.js";
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
const DEFAULT_COMMAND_POLICY: CommandPolicy = {
	priority: "normal",
	progress: "auto",
};

for (const command of [
	gatyaCommand,
	introCommand,
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

interface ResolvedCommand {
	body: string;
	name: string;
	args: string[];
	command: LineCommand;
	policy: CommandPolicy;
}

function resolveCommand(messageText: string): ResolvedCommand | undefined {
	if (!messageText.startsWith(appConfig.commandPrefix)) return undefined;
	const body = messageText.slice(appConfig.commandPrefix.length).trim();
	if (!body) return undefined;
	const [nameRaw, ...args] = body.split(/\s+/);
	const name = nameRaw.toLowerCase();
	const command = commands.get(name);
	if (!command) return undefined;
	const configured = typeof command.policy === "function"
		? command.policy(args, name)
		: command.policy;
	return {
		body,
		name,
		args,
		command,
		policy: { ...DEFAULT_COMMAND_POLICY, ...configured },
	};
}

export function getLineCommandPolicy(messageText: string): CommandPolicy | undefined {
	return resolveCommand(messageText)?.policy;
}

export async function handleLineCommand(messageText: string, message: ReplyableLineMessage): Promise<boolean> {
	const resolved = resolveCommand(messageText);
	if (!resolved) return false;
	const { body, name, args, command, policy } = resolved;
	rankingStore.record(message.destination);
	const progress = await startCommandProgress(message, name, policy.progress);
	try {
		await command.execute({ message, command: name, args, rawText: messageText, body, progress });
	} finally {
		await progress.finish();
	}
	return true;
}
