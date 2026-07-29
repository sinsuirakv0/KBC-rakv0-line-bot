import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const requestDirectory = path.resolve(
	process.cwd(),
	"node_modules",
	"@evex",
	"linejs",
	"base",
	"request",
);
const targetPaths = ["legy.js", "legy.ts"].map((name) => path.join(requestDirectory, name));
const patchedPattern = /headers: this\.#outerHeaders\(request, options\),\r?\n[\t ]*signal: request\.signal,/;
const unpatchedPattern = /(^[\t ]*headers: this\.#outerHeaders\(request, options\),)(\r?\n)([\t ]*)(body: new Uint8Array\(encrypted\),?)/m;
let patchedCount = 0;

for (const targetPath of targetPaths) {
	const source = await readFile(targetPath, "utf8");
	if (patchedPattern.test(source)) continue;
	if (!unpatchedPattern.test(source)) {
		throw new Error(
			`Unsupported linejs LEGY implementation: expected request fragment was not found in ${targetPath}`,
		);
	}
	const patched = source.replace(
		unpatchedPattern,
		"$1$2$3signal: request.signal,$2$3$4",
	);
	await writeFile(targetPath, patched, "utf8");
	patchedCount += 1;
}

console.log(
	patchedCount > 0
		? `[linejs-patch] added AbortSignal propagation to ${patchedCount} LEGY source file(s)`
		: "[linejs-patch] LEGY AbortSignal propagation is ready",
);
