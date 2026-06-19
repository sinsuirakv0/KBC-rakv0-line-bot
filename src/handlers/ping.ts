import { appConfig } from "../config.js";
import type { ReplyableLineMessage } from "../commands/shared.js";

export async function handlePing(messageText: string, message: ReplyableLineMessage): Promise<boolean> {
	if (messageText !== `${appConfig.commandPrefix}ping`) return false;
	await message.reply("pong!");
	return true;
}
