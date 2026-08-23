#!/usr/bin/env node
import { runDesktopPoolCli } from "../dist/gpt-control-desktop-pool-driver.js";

runDesktopPoolCli().catch((error) => {
	process.stdout.write(`${JSON.stringify({ version: 2, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
	process.exitCode = 1;
});
