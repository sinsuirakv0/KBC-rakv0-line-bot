import type { LineCommand } from "./shared.js";

export const idCommand: LineCommand = {
	name: "id",
	async execute({ message, args }) {
		if (args.length === 0) {
			await message.send(`ID: ${message.destination.senderMid}`);
			return;
		}

		const mentionedMid = message.mentionMids[0];
		if (!mentionedMid) {
			await message.send("IDを取得する相手をメンションしてください。\n使い方: !id @メンション");
			return;
		}

		await message.send(`ID: ${mentionedMid}`);
	},
};
