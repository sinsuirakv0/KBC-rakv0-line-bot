import { appConfig } from "../config.js";
import type { ReplyableLineMessage } from "../commands/shared.js";

export async function handlePing(messageText: string, message: ReplyableLineMessage): Promise<boolean> {
	if (messageText === `${appConfig.commandPrefix}ping help`) {
		await message.reply([
			"!ping",
			"",
			"!ping",
			"  botが反応できる状態か確認します。pong! と返れば正常です。",
		].join("\n"));
		return true;
	}
	if (messageText !== `${appConfig.commandPrefix}ping`) return false;
	await message.reply("pong!");
	return true;
}
