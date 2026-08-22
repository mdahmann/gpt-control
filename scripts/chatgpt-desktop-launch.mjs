#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_CDP_ENDPOINT,
  discoverChatGptApp,
  parseLoopbackEndpoint,
  verifyCdpPortOwnership,
} from "../src/desktop-cdp-core.mjs";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function textCommand(file, args) {
  const { stdout } = await execFileAsync(file, args, { maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

async function mainPids(executable) {
  const output = await textCommand("/bin/ps", ["-axo", "pid=,command="]);
  return output.split("\n").map((line) => line.trim()).map((line) => {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    return match && (match[2] === executable || match[2].startsWith(`${executable} `)) ? Number(match[1]) : undefined;
  }).filter(Boolean);
}

async function running(executable) {
  return (await mainPids(executable)).length > 0;
}

async function endpointReady(endpoint, app) {
  const ownership = await verifyCdpPortOwnership(endpoint, app);
  if (!ownership.ok) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`${endpoint.origin}/json/version`, { signal: controller.signal, cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function gracefulStop(app, force) {
  if (!(await running(app.executable))) return;
  await execFileAsync("/usr/bin/osascript", ["-e", `tell application id \"${app.bundleId}\" to quit`]).catch(() => undefined);
  let deadline = Date.now() + 15_000;
  while (Date.now() < deadline && await running(app.executable)) await sleep(250);
  if (!(await running(app.executable))) return;
  if (!force) throw new Error("ChatGPT did not close within 15 seconds. Re-run with --force only after reviewing unsaved work.");
  for (const pid of await mainPids(app.executable)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await running(app.executable)) await sleep(250);
  if (await running(app.executable)) {
    for (const pid of await mainPids(app.executable)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  await sleep(500);
  if (await running(app.executable)) throw new Error("ChatGPT could not be stopped safely.");
}

async function launch(app, endpoint) {
  await execFileAsync("/usr/bin/open", [
    "-na",
    app.bundle,
    "--args",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${endpoint.port}`,
  ]);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await endpointReady(endpoint, app)) return;
    await sleep(350);
  }
  throw new Error(`Timed out waiting for verified ChatGPT CDP on ${endpoint.origin}.`);
}

function parseArgs(argv) {
  const options = { launch: false, restart: false, force: false };
  for (const arg of argv) {
    if (arg === "--launch") options.launch = true;
    else if (arg === "--restart") options.restart = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.force && !options.restart) throw new Error("--force is valid only with --restart.");
  return options;
}

export async function runLauncher(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    return {
      help: "Usage: node scripts/chatgpt-desktop-launch.mjs [--launch | --restart [--force]]. With no mutation flag it performs a read-only doctor check.",
    };
  }
  const app = await discoverChatGptApp(env);
  const endpoint = parseLoopbackEndpoint(env.GPT_CONTROL_DRIVER_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT);
  const isRunning = await running(app.executable);
  const ready = await endpointReady(endpoint, app);
  if (!options.launch && !options.restart) {
    return { mutated: false, app, endpoint: endpoint.origin, running: isRunning, cdpReady: ready };
  }
  if (ready && !options.restart) return { mutated: false, app, endpoint: endpoint.origin, running: true, cdpReady: true };
  if (isRunning && !options.restart) {
    throw new Error("ChatGPT is already running without the verified CDP endpoint. Use --restart to relaunch it explicitly; the driver never restarts the app automatically.");
  }
  if (options.restart) await gracefulStop(app, options.force);
  await launch(app, endpoint);
  return { mutated: true, app, endpoint: endpoint.origin, running: true, cdpReady: true };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runLauncher().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
