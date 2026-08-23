#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Compatibility entry point. Keep both published executable names on the one
// live-verified TypeScript driver rather than exposing the earlier preview
// implementation as a second runtime.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [resolve(root, "dist/gpt-control-desktop-driver.js")], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
