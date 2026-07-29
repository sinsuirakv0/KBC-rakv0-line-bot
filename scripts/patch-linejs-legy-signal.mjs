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

const pushDirectory = path.resolve(
	process.cwd(),
	"node_modules",
	"@evex",
	"linejs",
	"base",
	"push",
);
const pushTargets = [
	{
		path: path.join(pushDirectory, "conn.js"),
		unhandledFetch: [
			"      })();",
			"      setTimeout(resolve, 300);",
		].join("\n"),
		handledFetch: [
			"      })().catch((error)=>{",
			"        if (!abort.signal.aborted) this.manager.log(\"connection fetch failed\", error);",
			"      });",
			"      setTimeout(resolve, 300);",
		].join("\n"),
		shortWait: [
			"    if (!this.resStream) {",
			"      await new Promise((resolve)=>{",
			"        setTimeout(resolve, 500);",
			"      });",
			"      if (!this.resStream) {",
			"        throw new Error(\"no resStream\");",
			"      }",
			"    }",
		].join("\n"),
		boundedWait: [
			"    for(let waitedMs = 0; !this.resStream && waitedMs < 15000; waitedMs += 100){",
			"      await new Promise((resolve)=>setTimeout(resolve, 100));",
			"    }",
			"    if (!this.resStream) {",
			"      throw new Error(\"no resStream after 15000ms\");",
			"    }",
		].join("\n"),
	},
	{
		path: path.join(pushDirectory, "conn.ts"),
		unhandledFetch: [
			"\t\t\t})();",
			"\t\t\tsetTimeout(resolve, 300);",
		].join("\n"),
		handledFetch: [
			"\t\t\t})().catch((error) => {",
			"\t\t\t\tif (!abort.signal.aborted) this.manager.log(\"connection fetch failed\", error);",
			"\t\t\t});",
			"\t\t\tsetTimeout(resolve, 300);",
		].join("\n"),
		shortWait: [
			"\t\tif (!this.resStream) {",
			"\t\t\tawait new Promise<void>((resolve) => {",
			"\t\t\t\tsetTimeout(resolve, 500);",
			"\t\t\t});",
			"\t\t\tif (!this.resStream) {",
			"\t\t\t\tthrow new Error(\"no resStream\");",
			"\t\t\t}",
			"\t\t}",
		].join("\n"),
		boundedWait: [
			"\t\tfor (let waitedMs = 0; !this.resStream && waitedMs < 15_000; waitedMs += 100) {",
			"\t\t\tawait new Promise<void>((resolve) => setTimeout(resolve, 100));",
			"\t\t}",
			"\t\tif (!this.resStream) {",
			"\t\t\tthrow new Error(\"no resStream after 15000ms\");",
			"\t\t}",
		].join("\n"),
	},
];
let pushPatchedCount = 0;

for (const target of pushTargets) {
	let source = await readFile(target.path, "utf8");
	if (!source.includes(target.handledFetch)) {
		if (!source.includes(target.unhandledFetch)) {
			throw new Error(
				`Unsupported linejs PUSH implementation: fetch fragment was not found in ${target.path}`,
			);
		}
		source = source.replace(target.unhandledFetch, target.handledFetch);
		pushPatchedCount += 1;
	}
	if (!source.includes(target.boundedWait)) {
		if (!source.includes(target.shortWait)) {
			throw new Error(
				`Unsupported linejs PUSH implementation: response wait fragment was not found in ${target.path}`,
			);
		}
		source = source.replace(target.shortWait, target.boundedWait);
		pushPatchedCount += 1;
	}
	await writeFile(target.path, source, "utf8");
}

console.log(
	patchedCount > 0
		? `[linejs-patch] added AbortSignal propagation to ${patchedCount} LEGY source file(s)`
		: "[linejs-patch] LEGY AbortSignal propagation is ready",
);
console.log(
	pushPatchedCount > 0
		? `[linejs-patch] added PUSH readiness handling to ${pushPatchedCount} source fragment(s)`
		: "[linejs-patch] PUSH readiness handling is ready",
);
