#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("Provide at least one generated JavaScript file to normalize.");

for (const path of paths) {
	const absolute = resolve(path);
	const source = await readFile(absolute, "utf8");
	await writeFile(absolute, source.replace(/[\t ]+$/gm, ""), "utf8");
}
