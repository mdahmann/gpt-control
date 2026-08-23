#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = { count: 2, confirm: false, send: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm") options.confirm = true;
    else if (arg === "--send") options.send = true;
    else if (arg === "--count") options.count = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 10) throw new Error("--count must be between 1 and 10.");
  return options;
}

export async function runAcceptance(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    return {
      help: "Usage: node scripts/chatgpt-desktop-acceptance.mjs --confirm [--count 2] [--send].",
      warning: "Without --send this is read-only. With --send it asks ordinary web-development questions and archives the disposable chats.",
    };
  }
  if (!options.confirm) throw new Error("Acceptance requires --confirm after closing sensitive desktop chats.");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = [resolve(root, "scripts/desktop-cdp-live-smoke.mjs")];
  if (options.send) args.push("--live", "--concurrency", String(options.count));
  const childEnv = {
    ...env,
    ...(options.send ? { GPT_CONTROL_DESKTOP_LIVE_MUTATION: "1" } : {}),
  };
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code !== 0) rejectRun(new Error(stderr.trim() || `Canonical desktop acceptance exited ${code}.`));
      else resolveRun(JSON.parse(stdout));
    });
  });
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAcceptance().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
