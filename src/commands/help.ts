import type { LineCommand } from "./shared.js";

const COMMAND_LINES = [
	"!ping",
	"!gatya",
	"!sale",
	"!item",
	"!unit / !ut",
	"!enemy / !tut",
	"!stage / !st",
	"!id",
	"!ranking",
	"!push",
	"!test",
	"!help",
];

export const helpCommand: LineCommand = {
	name: "help",
	async execute({ message }) {
		await message.send(COMMAND_LINES.join("\n"));
	},
};
