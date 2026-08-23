#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_ACK = "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS";
const STRESS_ACK = "I_UNDERSTAND_THIS_STARTS_MULTIPLE_CHATGPT_SESSIONS";
const DEFAULT_COOLDOWN_HOURS = 24;
const DEFAULT_QUESTIONS = [
  "When would you use CSS Grid instead of Flexbox?",
  "What is one practical way to improve a form's accessibility?",
  "Why is semantic HTML useful in a web application?",
  "What makes a website feel fast to a visitor?",
  "When is a container query more useful than a media query?",
  "How do you decide what belongs in a React component?",
];

function parseArgs(argv) {
  const options = { count: 1, confirm: false, send: false, stress: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm") options.confirm = true;
    else if (arg === "--send") options.send = true;
    else if (arg === "--stress") options.stress = true;
    else if (arg === "--count") options.count = Number(argv[++index]);
    else if (arg === "--request-file") options.requestFile = argv[++index];
    else if (arg === "--install-root") options.installRoot = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 6) throw new Error("--count must be between 1 and 6.");
  if (options.count > 1 && !options.stress) throw new Error("Multiple-session acceptance requires --stress.");
  return options;
}

async function loadPrivateRequest(path) {
  if (!path) return {};
  const absolute = resolve(path);
  const { info, text } = await readRegularFileNoFollow(absolute, 64 * 1024);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) {
    throw new Error("Acceptance request file must be a private regular file no larger than 64 KiB.");
  }
  const value = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Acceptance request file must contain one JSON object.");
  const allowed = new Set(["questions", "files", "model", "effort", "workspaceRoot"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown acceptance request key: ${key}`);
  if (value.questions !== undefined && (!Array.isArray(value.questions) || value.questions.some((item) => typeof item !== "string" || item.length < 1 || item.length > 512))) {
    throw new Error("Acceptance questions must be non-empty strings no longer than 512 characters.");
  }
  if (value.files !== undefined && (!Array.isArray(value.files) || value.files.length > 8 || value.files.some((item) => typeof item !== "string" || item.length < 1))) {
    throw new Error("Acceptance files must contain at most eight non-empty paths.");
  }
  for (const key of ["model", "effort", "workspaceRoot"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length < 1)) throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

class McpClient {
  constructor(process) {
    this.process = process;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.failed = undefined;
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk) => this.onData(chunk));
    process.on("error", (error) => this.fail(error));
    process.on("exit", (code) => this.fail(new Error(`Installed GPT-Control MCP exited ${code}.`)));
  }

  fail(error) {
    this.failed = error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("Installed GPT-Control MCP returned invalid JSON-RPC output."));
        this.process.kill("SIGTERM");
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "MCP request failed."));
      else entry.resolve(message.result);
    }
  }

  notify(method, params = {}) {
    if (this.failed) throw this.failed;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method, params = {}, timeoutMs = 300_000) {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`MCP ${method} exceeded ${timeoutMs} milliseconds.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.end();
    if (await waitForChildExit(this.process, 5_000)) return;
    this.process.kill("SIGTERM");
    if (await waitForChildExit(this.process, 5_000)) return;
    this.process.kill("SIGKILL");
    if (!await waitForChildExit(this.process, 5_000)) throw new Error("Installed GPT-Control MCP did not exit after SIGKILL.");
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolveExit(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolveExit(true); };
    child.once("exit", onExit);
  });
}

async function startInstalledMcp(installRoot, env) {
  const launcher = await realpath(join(installRoot, "bin", "gpt-control-mcp"));
  const poolDriver = await realpath(join(installRoot, "bin", "gpt-control-desktop-pool-driver"));
  const child = spawn(launcher, [], {
    cwd: installRoot,
    env: { ...env, GPT_CONTROL_BROWSER_DRIVER: poolDriver },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
  const client = new McpClient(child);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gpt-control-installed-acceptance", version: "1" },
    }, 15_000);
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list", {}, 15_000);
    const names = new Set((listed.tools ?? []).map((tool) => tool.name));
    for (const required of ["gpt_chat", "gpt_conversation_manage", "gpt_conversation_close"]) {
      if (!names.has(required)) throw new Error(`Installed GPT-Control is missing ${required}.`);
    }
    return { client, initialized, launcher, poolDriver, stderr: () => stderr };
  } catch (error) {
    await client.close();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? ` stderr: ${stderr.trim()}` : ""}`);
  }
}

async function callTool(client, name, args, timeoutMs = 300_000) {
  const result = await client.request("tools/call", { name, arguments: args }, timeoutMs);
  if (!isRecord(result)) throw new Error(`${name} returned no MCP tool result.`);
  return result;
}

async function readCooldown(path) {
  try {
    const { text } = await readRegularFileNoFollow(path, 16 * 1024);
    const value = JSON.parse(text);
    if (!isRecord(value) || value.version !== 1 || !Number.isFinite(Date.parse(value.attemptedAt ?? ""))) {
      throw new Error("Invalid live-acceptance cooldown receipt.");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function beginCooldown(path, count, hours, override) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const lease = { path: `${path}.active`, token: randomUUID() };
  try {
    await writeFile(lease.path, `${lease.token}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another live acceptance attempt is active. Refusing concurrent ChatGPT activity.");
    throw error;
  }
  try {
    const current = await readCooldown(path);
    const last = Date.parse(current?.attemptedAt ?? "");
    const nextAllowedAt = Number.isFinite(last) ? last + hours * 60 * 60_000 : 0;
    if (!override && Date.now() < nextAllowedAt) {
      throw new Error(`Live acceptance is cooling down until ${new Date(nextAllowedAt).toISOString()}. Deterministic tests remain available.`);
    }
    const temporary = `${path}.pending-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, attemptedAt: new Date().toISOString(), count, state: "attempted" })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    return lease;
  } catch (error) {
    await releaseCooldownLease(lease);
    throw error;
  }
}

async function finishCooldown(path, state, lease) {
  try {
    const current = await readCooldown(path);
    const temporary = `${path}.pending-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({ ...current, state, finishedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await releaseCooldownLease(lease);
  }
}

async function releaseCooldownLease(lease) {
  const { text } = await readRegularFileNoFollow(lease.path, 512);
  const token = text.trim();
  if (token !== lease.token) throw new Error("Live-acceptance lease ownership changed unexpectedly.");
  await unlink(lease.path);
}

async function assertPoolOffline(env) {
  const root = resolve(env.GPT_CONTROL_DRIVER_DESKTOP_POOL_ROOT ?? join(homedir(), ".gpt-control", "desktop-worker-pool"));
  const startPort = Number(env.GPT_CONTROL_DRIVER_DESKTOP_POOL_START_PORT ?? 9237);
  const size = Number(env.GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE ?? 6);
  const processList = (await execFileAsync("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  const lanes = [];
  for (let offset = 0; offset < size; offset += 1) {
    const lane = String(offset + 1).padStart(2, "0");
    const laneRoot = join(root, "lanes", lane);
    const statePath = join(laneRoot, "state", "state.json");
    let sessions = [];
    try {
      const { text } = await readRegularFileNoFollow(statePath, 16 * 1024 * 1024);
      const value = JSON.parse(text);
      sessions = Object.keys(value.sessions ?? {});
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const port = startPort + offset;
    let listener = "";
    try {
      listener = (await execFileAsync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"])).stdout;
    } catch (error) {
      if (!(error?.code === 1 && String(error.stdout ?? "") === "")) throw error;
    }
    const profile = join(laneRoot, "profile");
    const profilePids = processList.split("\n").filter((line) => line.includes(`--user-data-dir=${profile}`) || line.includes(`--database=${join(profile, "Crashpad")}`));
    if (sessions.length > 0 || /^p\d+$/m.test(listener) || profilePids.length > 0) {
      throw new Error(`Desktop acceptance cleanup was not proved for lane ${lane}.`);
    }
    lanes.push({ lane: offset + 1, port, sessionCount: 0, listenerCount: 0, profileProcessCount: 0 });
  }
  return { rootSha256: sha256(root), lanes };
}

function compactRunReceipt(toolResult) {
  const structured = toolResult.structuredContent;
  const run = structured?.run;
  const receipt = run?.receipt;
  if (!isRecord(run) || !isRecord(receipt)) throw new Error("gpt_chat omitted its durable run receipt.");
  if (!Number.isSafeInteger(receipt.desktopPoolLane) || receipt.desktopPoolLane < 1 || receipt.desktopPoolLane > 10) {
    throw new Error("gpt_chat omitted its bounded desktop-pool lane receipt.");
  }
  return {
    conversationId: structured.conversationId,
    runId: run.runId,
    status: run.status,
    desktopPoolLane: receipt.desktopPoolLane,
    browserDriverId: receipt.browserDriverId,
    localBrowserSessionId: receipt.localBrowserSessionId,
    providerConversationId: receipt.providerConversationId,
    providerConversationUrlSha256: receipt.providerConversationUrl ? sha256(receipt.providerConversationUrl) : undefined,
    requestedModel: receipt.requestedModel,
    observedModel: receipt.observedModel,
    requestedEffort: receipt.requestedEffort,
    observedEffort: receipt.observedEffort,
    modelVerified: receipt.modelVerified,
    modelEvidenceKind: receipt.modelEvidenceKind,
    attachmentManifestSha256: run.manifest?.sha256,
  };
}

export async function runAcceptance(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const provePoolOffline = dependencies.assertPoolOffline ?? assertPoolOffline;
  const startMcp = dependencies.startInstalledMcp ?? startInstalledMcp;
  const options = parseArgs(argv);
  if (options.help) {
    return {
      help: "Usage: node scripts/chatgpt-desktop-acceptance.mjs --confirm [--send] [--count 1] [--stress] --install-root PATH [--request-file PRIVATE_JSON].",
      warning: "Live send is opt-in, defaults to one chat, uses the installed MCP product path, archives every disposable chat, and enforces a 24-hour local cooldown.",
    };
  }
  if (!options.confirm) throw new Error("Acceptance requires --confirm after closing sensitive desktop chats.");
  if (!options.send) {
    const { runDoctor } = await import("./chatgpt-desktop-doctor.mjs");
    return { mode: "diagnostic", ...(await runDoctor(env)) };
  }
  if (env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE !== LIVE_ACK) throw new Error(`Live acceptance requires GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE=${LIVE_ACK}.`);
  if (options.count > 1 && env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STRESS !== STRESS_ACK) {
    throw new Error(`Multiple-session acceptance requires GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STRESS=${STRESS_ACK}.`);
  }
  const installRoot = resolve(options.installRoot ?? env.GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT ?? "");
  if (!options.installRoot && !env.GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT) throw new Error("Live acceptance requires an explicit installed package root.");
  if (await realpath(installRoot) === await realpath(sourceRoot)) throw new Error("Live acceptance must use an installed package, not the source checkout.");
  const config = await loadPrivateRequest(options.requestFile);
  const questions = config.questions?.length ? config.questions : DEFAULT_QUESTIONS;
  if (questions.length < options.count) throw new Error("The private request does not contain enough acceptance questions.");
  const workspaceRoot = resolve(config.workspaceRoot ?? sourceRoot);
  const files = (config.files ?? []).map((path) => resolve(workspaceRoot, path));
  const cooldownHours = Number(env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_COOLDOWN_HOURS ?? DEFAULT_COOLDOWN_HOURS);
  if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 168) throw new Error("Live acceptance cooldown must be 1-168 hours.");
  const cooldownPath = resolve(env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STATE ?? join(homedir(), ".gpt-control", "live-acceptance.json"));
  await provePoolOffline(env);
  const cooldownLease = await beginCooldown(cooldownPath, options.count, cooldownHours, env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_OVERRIDE === "1");
  const childEnv = { ...env, GPT_CONTROL_WORKSPACE_ROOT: workspaceRoot };
  let started;
  try {
    started = await startMcp(installRoot, childEnv);
  } catch (error) {
    await finishCooldown(cooldownPath, "failed", cooldownLease);
    throw error;
  }
  const { client, initialized, launcher, poolDriver, stderr } = started;
  const conversations = new Set();
  const cleanupErrors = [];
  let primaryError;
  let receipts = [];
  try {
    const results = await Promise.allSettled(Array.from({ length: options.count }, (_, index) => callTool(client, "gpt_chat", {
      prompt: questions[index],
      wait: true,
      timeout_ms: 180_000,
      idempotency_key: `desktop-acceptance-${randomUUID()}`,
      ...(files.length > 0 ? { files } : {}),
      ...(config.model ? { chatgpt_model: config.model } : {}),
      ...(config.effort ? { chatgpt_effort: config.effort } : {}),
    })));
    const failures = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
        continue;
      }
      const conversationId = result.value?.structuredContent?.conversationId;
      if (typeof conversationId === "string") conversations.add(conversationId);
      try {
        receipts.push(compactRunReceipt(result.value));
      } catch (error) {
        failures.push(error);
      }
    }
    for (const receipt of receipts) {
      if (receipt.status !== "completed") {
        throw new Error(`Installed product-path run ${receipt.runId ?? "unknown"} did not complete with an exact pool-lane receipt.`);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} installed product-path call${failures.length === 1 ? "" : "s"} failed.`);
  } catch (error) {
    primaryError = error;
  } finally {
    for (const conversationId of conversations) {
      try {
        const archived = await callTool(client, "gpt_conversation_manage", { conversation_id: conversationId, action: "archive" }, 120_000);
        if (archived.isError) throw new Error("archive returned an MCP error result");
      } catch (error) {
        cleanupErrors.push(`archive ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
        try {
          await callTool(client, "gpt_conversation_close", { conversation_id: conversationId }, 120_000);
        } catch (closeError) {
          cleanupErrors.push(`close ${conversationId}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
      }
    }
    try {
      await client.close();
    } catch (error) {
      cleanupErrors.push(`MCP close: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let cleanupProof;
  try {
    cleanupProof = await provePoolOffline(env);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (primaryError || cleanupErrors.length > 0) {
    await finishCooldown(cooldownPath, "failed", cooldownLease);
    throw new AggregateError(
      [...(primaryError ? [primaryError] : []), ...cleanupErrors.map((message) => new Error(message))],
      `Installed desktop acceptance failed${cleanupErrors.length ? ` with ${cleanupErrors.length} cleanup blocker${cleanupErrors.length === 1 ? "" : "s"}` : ""}.${stderr().trim() ? ` MCP stderr: ${stderr().trim()}` : ""}`,
    );
  }
  await finishCooldown(cooldownPath, "passed", cooldownLease);
  return {
    mode: "live",
    path: "installed-mcp",
    server: initialized.serverInfo,
    installRootPathSha256: sha256(await realpath(installRoot)),
    launcherSha256: sha256Bytes(await readFile(launcher)),
    poolDriverSha256: sha256Bytes(await readFile(poolDriver)),
    count: options.count,
    receipts,
    cleanup: cleanupProof,
    completedAt: new Date().toISOString(),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRegularFileNoFollow(path, maxBytes) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) throw new Error(`Refused unsafe or oversized regular file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.size > maxBytes) {
      throw new Error(`Regular-file identity changed before read: ${path}`);
    }
    return { info: after, text: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAcceptance().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof AggregateError
      ? [error.message, ...error.errors.map((item) => item instanceof Error ? item.message : String(item))].join("\n")
      : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
