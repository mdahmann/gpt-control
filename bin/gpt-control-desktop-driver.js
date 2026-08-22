#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runDriverCli } from "../src/desktop-cdp-driver.mjs";

export async function main() {
  await runDriverCli();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ version: 2, ok: false, error: message })}\n`);
    process.exitCode = 1;
  });
}
