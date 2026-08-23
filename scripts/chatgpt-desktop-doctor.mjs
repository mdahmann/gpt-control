#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedBundlePath = resolve(root, "dist/gpt-control-desktop-driver.js");
const EXPECTED_DRIVER_ID = "chatgpt-desktop-cdp/v1";
const EXPECTED_DRIVER_VERSION = "0.5.0-alpha.2";
const EXPECTED_STATE_WRITER_VERSION = 2;

export function assertCurrentDesktopEnvironment(env = process.env) {
  const legacy = [
    "GPT_CONTROL_DRIVER_CDP_ENDPOINT",
    "GPT_CONTROL_DRIVER_APP_PATH",
    "GPT_CONTROL_DRIVER_STATE_ROOT",
  ].filter((name) => env[name]?.trim());
  if (legacy.length > 0) {
    throw new Error(`Legacy desktop configuration is refused: ${legacy.join(", ")}. Use only GPT_CONTROL_DRIVER_DESKTOP_CDP_ENDPOINT, GPT_CONTROL_DRIVER_DESKTOP_APP_PATH, and GPT_CONTROL_DRIVER_DESKTOP_STATE_ROOT.`);
  }
}

async function invokeProductionProbe(env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(root, "dist/gpt-control-desktop-driver.js")], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", async (code) => {
		if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Desktop driver exited ${code}.`));
		try {
			const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8"));
			resolveResult(await validateProbeEnvelope(envelope));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify({ version: 2, action: "probe", params: {} })}\n`);
  });
}

async function validateProbeEnvelope(envelope) {
  if (!isRecord(envelope) || !hasOnlyKeys(envelope, ["version", "ok", "result", "error"]) || envelope.version !== 2 || envelope.ok !== true || !isRecord(envelope.result)) {
    throw new Error(typeof envelope?.error === "string" && envelope.error ? envelope.error : "Desktop driver returned an invalid probe envelope.");
  }
  const result = envelope.result;
  const resultKeys = ["ready", "driver", "driverVersion", "stateWriterVersion", "secureInput", "protocolVersion", "host", "runtimeExecutable", "runtimeBundlePath", "runtimeBundleSha256"];
  if (!hasOnlyKeys(result, resultKeys)
    || result.ready !== true
    || result.driver !== EXPECTED_DRIVER_ID
    || result.driverVersion !== EXPECTED_DRIVER_VERSION
    || result.stateWriterVersion !== EXPECTED_STATE_WRITER_VERSION
    || result.secureInput !== true
    || result.protocolVersion !== 2
    || !isRecord(result.host)) {
    throw new Error("Desktop driver probe identity or protocol contract did not match this package.");
  }
  const expectedPath = await realpath(expectedBundlePath);
  const observedPath = typeof result.runtimeBundlePath === "string" ? await realpath(result.runtimeBundlePath) : "";
  const expectedExecutable = await realpath(process.execPath);
  const observedExecutable = typeof result.runtimeExecutable === "string" ? await realpath(result.runtimeExecutable) : "";
  const expectedHash = createHash("sha256").update(await readFile(expectedPath)).digest("hex");
  if (observedPath !== expectedPath || observedExecutable !== expectedExecutable || result.runtimeBundleSha256 !== expectedHash) {
    throw new Error("Desktop driver runtime path, executable, or bundle hash did not match this package.");
  }
  return result;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && allowed.filter((key) => key !== "error").every((key) => key in value);
}

export async function runDoctor(env = process.env) {
  assertCurrentDesktopEnvironment(env);
  const result = await invokeProductionProbe(env);
  return {
    ...result,
    mutated: false,
    limitations: [
      "This is unsupported Electron UI automation, not an OpenAI API.",
      "The doctor executes the packaged production driver and never launches, restarts, focuses, types into, or closes ChatGPT.",
      "Independent windows are proved only when a driver create action succeeds.",
    ],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDoctor().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 2;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
