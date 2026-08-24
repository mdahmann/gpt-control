#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sanitizeBrowserDriverEnv, sanitizeGptControlBrokerEnv } from "./driver-env.mjs";

const execFileAsync = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_ACK = "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS";
const STRESS_ACK = "I_UNDERSTAND_THIS_STARTS_MULTIPLE_CHATGPT_SESSIONS";
const DEFAULT_COOLDOWN_HOURS = 24;
const EXPECTED_VERSION = "0.5.0-alpha.7";
const REQUIRED_LAUNCHERS = [
  "bin/gpt-control-mcp",
  "bin/gpt-control-desktop-pool-driver",
];
const REQUIRED_BUNDLES = [
  "dist/gpt-control-mcp.js",
  "dist/gpt-control-desktop-driver.js",
  "dist/gpt-control-desktop-pool-driver.js",
];
const DESKTOP_SESSION_ID_PATTERN = /^desktop-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DEFAULT_QUESTIONS = [
  "When would you use CSS Grid instead of Flexbox?",
  "What is one practical way to improve a form's accessibility?",
  "Why is semantic HTML useful in a web application?",
  "What makes a website feel fast to a visitor?",
  "When is a container query more useful than a media query?",
  "How do you decide what belongs in a React component?",
];

export function assertInstalledServerInfo(initialized) {
  if (initialized?.serverInfo?.name !== "gpt-control" || initialized?.serverInfo?.version !== EXPECTED_VERSION) {
    throw new Error(`Installed MCP server identity must be gpt-control ${EXPECTED_VERSION}.`);
  }
}

export function assertRuntimeBundleMatch(path, installedHash, trustedHash) {
  if (!/^[a-f0-9]{64}$/.test(installedHash) || !/^[a-f0-9]{64}$/.test(trustedHash) || installedHash !== trustedHash) {
    throw new Error(`Installed runtime bundle does not match trusted exact head: ${path}.`);
  }
}

export async function resolveContainedRegularFile(root, path, label, executable = false) {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  const relation = relative(canonicalRoot, canonical);
  if (relation === "" || relation === ".") throw new Error(`${label} must be a file inside the installed package root.`);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes the installed package root through a symlink or path alias.`);
  }
  const { info } = await readRegularFileNoFollow(canonical, 32 * 1024 * 1024);
  if (executable && (info.mode & 0o111) === 0) throw new Error(`${label} is not executable.`);
  return canonical;
}

async function exactFileHash(path) {
  return sha256Bytes((await readRegularFileNoFollow(path, 32 * 1024 * 1024)).bytes);
}

function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, size: info.size };
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.size === right?.size;
}

async function runtimeFileReceipt(path) {
  const { info, bytes } = await readRegularFileNoFollow(path, 32 * 1024 * 1024);
  return { identity: fileIdentity(info), sha256: sha256Bytes(bytes) };
}

async function assertRuntimeFileStillTrusted(runtime, path) {
  const current = await runtimeFileReceipt(runtime.files[path]);
  if (!sameFileIdentity(current.identity, runtime.fileIdentities?.[path])) {
    throw new Error(`Installed runtime file identity changed after trusted exact-head validation: ${path}.`);
  }
  assertRuntimeBundleMatch(path, current.sha256, runtime.fileHashes[path]);
}

export async function assertRuntimeFilesStillTrusted(runtime) {
  for (const path of Object.keys(runtime.files)) await assertRuntimeFileStillTrusted(runtime, path);
}

export async function spawnTrustedRuntime(runtime, path, args, options, spawnChild = spawn) {
  await assertRuntimeFileStillTrusted(runtime, path);
  const child = spawnChild(runtime.files[path], args, options);
  const trusted = assertRuntimeFileStillTrusted(runtime, path).catch((error) => {
    child.kill?.("SIGKILL");
    throw error;
  });
  return { child, trusted };
}

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

export async function inspectInstalledRuntime(installRoot, env) {
  const root = await realpath(installRoot);
  const files = {};
  for (const path of REQUIRED_LAUNCHERS) files[path] = await resolveContainedRegularFile(root, join(root, path), `Installed launcher ${path}`, true);
  for (const path of REQUIRED_BUNDLES) files[path] = await resolveContainedRegularFile(root, join(root, path), `Installed runtime ${path}`);
  const launcher = files["bin/gpt-control-mcp"];
  const poolDriver = files["bin/gpt-control-desktop-pool-driver"];
  const installedPackage = JSON.parse((await readRegularFileNoFollow(join(root, "package.json"), 1024 * 1024)).text);
  if (!isRecord(installedPackage) || installedPackage.version !== EXPECTED_VERSION) {
    throw new Error(`Installed GPT-Control version must be exactly ${EXPECTED_VERSION}.`);
  }

  const trustedRootInput = env.GPT_CONTROL_ACCEPTANCE_TRUSTED_SOURCE_ROOT;
  const expectedHead = env.GPT_CONTROL_ACCEPTANCE_EXPECTED_HEAD;
  if (!trustedRootInput || !/^[a-f0-9]{40}$/.test(expectedHead ?? "")) {
    throw new Error("Installed acceptance requires a trusted exact-head source root and 40-character expected head SHA.");
  }
  const trustedRoot = await realpath(resolve(trustedRootInput));
  const head = (await execFileAsync("/usr/bin/git", ["-C", trustedRoot, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
  if (head !== expectedHead) throw new Error(`Trusted source head ${head} does not match expected ${expectedHead}.`);
  const dirty = (await execFileAsync("/usr/bin/git", ["-C", trustedRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" })).stdout.trim();
  if (dirty) throw new Error("Trusted exact-head source worktree is not clean.");
  const trustedPackage = JSON.parse((await readRegularFileNoFollow(join(trustedRoot, "package.json"), 1024 * 1024)).text);
  if (!isRecord(trustedPackage) || trustedPackage.version !== EXPECTED_VERSION) {
    throw new Error(`Trusted exact-head package version must be exactly ${EXPECTED_VERSION}.`);
  }
  const fileHashes = {};
  const fileIdentities = {};
  for (const path of [...REQUIRED_LAUNCHERS, ...REQUIRED_BUNDLES]) {
    const trustedPath = await resolveContainedRegularFile(trustedRoot, join(trustedRoot, path), `Trusted exact-head file ${path}`, REQUIRED_LAUNCHERS.includes(path));
    const installed = await runtimeFileReceipt(files[path]);
    const installedHash = installed.sha256;
    const trustedHash = await exactFileHash(trustedPath);
    assertRuntimeBundleMatch(path, installedHash, trustedHash);
    fileHashes[path] = installedHash;
    fileIdentities[path] = installed.identity;
  }
  const bundleHashes = Object.fromEntries(REQUIRED_BUNDLES.map((path) => [path, fileHashes[path]]));
  const launcherHashes = Object.fromEntries(REQUIRED_LAUNCHERS.map((path) => [path, fileHashes[path]]));
  return { root, launcher, poolDriver, files, fileHashes, fileIdentities, bundleHashes, launcherHashes, sourceHead: head };
}

async function startInstalledMcp(installRoot, env, prevalidatedRuntime) {
  const runtime = prevalidatedRuntime ?? await inspectInstalledRuntime(installRoot, env);
  const { root, launcher, poolDriver } = runtime;
  await assertRuntimeFilesStillTrusted(runtime);
  const launched = await spawnTrustedRuntime(runtime, "bin/gpt-control-mcp", [], {
    cwd: root,
    env: sanitizeGptControlBrokerEnv({ ...env, GPT_CONTROL_BROWSER_DRIVER: poolDriver }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { child } = launched;
  await launched.trusted;
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
    assertInstalledServerInfo(initialized);
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list", {}, 15_000);
    const names = new Set((listed.tools ?? []).map((tool) => tool.name));
    for (const required of ["gpt_chat", "gpt_conversation_manage", "gpt_conversation_close"]) {
      if (!names.has(required)) throw new Error(`Installed GPT-Control is missing ${required}.`);
    }
    await assertRuntimeFilesStillTrusted(runtime);
    return { client, initialized, launcher, poolDriver, runtime, assertRuntime: () => assertRuntimeFilesStillTrusted(runtime), stderr: () => stderr };
  } catch (error) {
    await client.close();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? ` stderr: ${stderr.trim()}` : ""}`);
  }
}

async function callTool(client, name, args, timeoutMs = 300_000) {
  const result = await client.request("tools/call", { name, arguments: args }, timeoutMs);
  if (!isRecord(result)) throw new Error(`${name} returned no MCP tool result.`);
  if (result.isError === true) {
    const error = new Error(`${name} returned an MCP error result.`);
    error.toolResult = result;
    throw error;
  }
  return result;
}

async function attestInstalledPool(env, installRoot, action, prevalidatedRuntime) {
  const runtime = prevalidatedRuntime ?? await inspectInstalledRuntime(installRoot, env);
  const { poolDriver } = runtime;
  await assertRuntimeFilesStillTrusted(runtime);
  const request = JSON.stringify({ version: 2, action, params: {} });
  const stdout = await new Promise((resolveOutput, rejectOutput) => {
    void spawnTrustedRuntime(runtime, "bin/gpt-control-desktop-pool-driver", [], {
      env: sanitizeBrowserDriverEnv(env), stdio: ["pipe", "pipe", "pipe"],
    }).then(async ({ child, trusted }) => {
      const output = [];
      const errors = [];
      let outputBytes = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes <= 16 * 1024 * 1024) output.push(chunk);
        else child.kill("SIGKILL");
      });
      let errorBytes = 0;
      child.stderr.on("data", (chunk) => {
        errorBytes += chunk.length;
        if (errorBytes <= 64 * 1024) errors.push(chunk);
      });
      child.on("error", rejectOutput);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          rejectOutput(new Error(Buffer.concat(errors).toString("utf8").trim() || `Installed desktop-pool ${action} exited ${code}.`));
          return;
        }
        if (outputBytes > 16 * 1024 * 1024) {
          rejectOutput(new Error(`Installed desktop-pool ${action} response exceeded 16 MiB.`));
          return;
        }
        resolveOutput(Buffer.concat(output).toString("utf8"));
      });
      await trusted;
      child.stdin.end(request);
    }).catch(rejectOutput);
  });
  const envelope = JSON.parse(stdout.trim());
  if (!isRecord(envelope) || envelope.version !== 2 || envelope.ok !== true || !isRecord(envelope.result)) {
    throw new Error(`Installed desktop-pool ${action} failed: ${envelope?.error ?? "invalid response"}.`);
  }
  await assertRuntimeFilesStillTrusted(runtime);
  validatePoolAttestation(envelope.result, action === "attest_offline" ? "offline" : "active", { runtime });
  return envelope.result;
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

export function compactRunReceipt(toolResult, expected = {}) {
  if (!isRecord(toolResult) || toolResult.isError === true) throw new Error("gpt_chat returned an MCP error result.");
  const structured = toolResult.structuredContent;
  const run = structured?.run;
  const receipt = run?.receipt;
  if (!isRecord(run) || !isRecord(receipt)) throw new Error("gpt_chat omitted its durable run receipt.");
  if (typeof structured.conversationId !== "string" || !/^conv_[a-f0-9]{32}$/.test(structured.conversationId)) {
    throw new Error("gpt_chat omitted its typed broker conversation identity.");
  }
  if (typeof run.runId !== "string" || !/^run_[a-f0-9]{32}$/.test(run.runId)) {
    throw new Error("gpt_chat omitted its typed durable run identity.");
  }
  if (!Number.isSafeInteger(receipt.desktopPoolLane) || receipt.desktopPoolLane < 1 || receipt.desktopPoolLane > 10) {
    throw new Error("gpt_chat omitted its bounded desktop-pool lane receipt.");
  }
  if (run.status !== "completed") throw new Error(`Installed product-path run ${run.runId ?? "unknown"} did not complete.`);
  if (receipt.browserDriverId !== "chatgpt-desktop-pool/v1") throw new Error("gpt_chat did not use the installed desktop-pool driver.");
  for (const [field, value] of [["local browser session", receipt.localBrowserSessionId], ["provider conversation", receipt.providerConversationId], ["provider conversation URL", receipt.providerConversationUrl]]) {
    if (typeof value !== "string" || value.length < 1) throw new Error(`gpt_chat omitted its ${field} identity.`);
  }
  if (!DESKTOP_SESSION_ID_PATTERN.test(receipt.localBrowserSessionId)) {
    throw new Error("gpt_chat returned an invalid local browser-session identity.");
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(receipt.providerConversationId)) {
    throw new Error("gpt_chat returned an invalid provider conversation identity.");
  }
  if (receipt.modelVerified !== true || receipt.modelEvidenceKind !== "composer_selector") {
    throw new Error("gpt_chat omitted exact composer model proof.");
  }
  if (typeof expected.model !== "string" || typeof expected.effort !== "string") {
    throw new Error("Live acceptance requires explicit expected model and effort values.");
  }
  if (receipt.requestedModel !== expected.model || receipt.observedModel !== expected.model
    || receipt.requestedEffort !== expected.effort || receipt.observedEffort !== expected.effort) {
    throw new Error("gpt_chat model or effort proof does not match the acceptance request.");
  }
  if (!isRecord(run.manifest) || typeof run.manifest.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(run.manifest.sha256) || !Array.isArray(run.manifest.files)) {
    throw new Error("gpt_chat omitted its immutable attachment manifest.");
  }
  if ((expected.fileCount ?? 0) !== run.manifest.files.length) throw new Error("gpt_chat attachment proof count does not match the request.");
  if (run.manifest.files.some((file) => !isRecord(file) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new Error("gpt_chat attachment proof omitted an exact file hash.");
  }
  const attachmentSha256s = run.manifest.files.map((file) => file.sha256);
  if (Array.isArray(expected.attachmentSha256s)
    && (attachmentSha256s.length !== expected.attachmentSha256s.length
      || attachmentSha256s.some((hash, index) => hash !== expected.attachmentSha256s[index]))) {
    throw new Error("gpt_chat attachment hashes do not match the exact requested file bytes.");
  }
  return {
    conversationId: structured.conversationId,
    runId: run.runId,
    status: run.status,
    desktopPoolLane: receipt.desktopPoolLane,
    browserDriverId: receipt.browserDriverId,
    localBrowserSessionId: receipt.localBrowserSessionId,
    providerConversationId: receipt.providerConversationId,
    providerConversationUrlSha256: providerConversationUrlReceipt(receipt.providerConversationUrl, receipt.providerConversationId),
    requestedModel: receipt.requestedModel,
    observedModel: receipt.observedModel,
    requestedEffort: receipt.requestedEffort,
    observedEffort: receipt.observedEffort,
    modelVerified: receipt.modelVerified,
    modelEvidenceKind: receipt.modelEvidenceKind,
    attachmentManifestSha256: run.manifest?.sha256,
    attachmentSha256s,
  };
}

function providerConversationUrlReceipt(raw, expectedId) {
  const url = new URL(raw);
  if (url.origin !== "https://chatgpt.com" || !/^\/(?:g\/[A-Za-z0-9_-]+\/)?c\/[A-Za-z0-9_-]{8,128}\/?$/.test(url.pathname)
    || url.search || url.hash) {
    throw new Error("gpt_chat returned an invalid provider conversation URL.");
  }
  const match = /^\/(?:g\/[A-Za-z0-9_-]+\/)?c\/([A-Za-z0-9_-]{8,128})\/?$/.exec(url.pathname);
  if (match?.[1] !== expectedId) throw new Error("gpt_chat provider conversation URL does not match its provider conversation identity.");
  return sha256(url.toString());
}

function assertExactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields: ${extras.join(", ")}.`);
}

export function validatePoolAttestation(proof, mode, options = {}) {
  if (!isRecord(proof)) throw new Error(`Desktop-pool ${mode} attestation is invalid.`);
  assertExactKeys(proof, new Set([
    "driver", "mode", "configuredSize", "managedLaneCount", "startPort", "poolRootSha256",
    "lanes", "attestedAt", "runtimeExecutable", "runtimeBundlePath", "runtimeBundleSha256",
  ]), `Desktop-pool ${mode} attestation`);
  if (proof.driver !== "chatgpt-desktop-pool/v1" || proof.mode !== mode) {
    throw new Error(`Desktop-pool ${mode} attestation has the wrong driver or mode.`);
  }
  if (!Number.isSafeInteger(proof.configuredSize) || proof.configuredSize < 1 || proof.configuredSize > 10
    || !Number.isSafeInteger(proof.managedLaneCount) || proof.managedLaneCount < proof.configuredSize || proof.managedLaneCount > 10
    || !Number.isSafeInteger(proof.startPort) || proof.startPort < 1024 || proof.startPort > 65_535
    || !/^[a-f0-9]{64}$/.test(proof.poolRootSha256)
    || !Number.isFinite(Date.parse(proof.attestedAt ?? ""))
    || !Array.isArray(proof.lanes) || proof.lanes.length !== proof.managedLaneCount) {
    throw new Error(`Desktop-pool ${mode} attestation omitted its bounded pool identity.`);
  }
  if (options.runtime) {
    const expectedBundle = options.runtime.files["dist/gpt-control-desktop-pool-driver.js"];
    const expectedHash = options.runtime.fileHashes["dist/gpt-control-desktop-pool-driver.js"];
    if (proof.runtimeBundlePath !== expectedBundle || proof.runtimeBundleSha256 !== expectedHash
      || typeof proof.runtimeExecutable !== "string" || proof.runtimeExecutable.length < 1) {
      throw new Error(`Desktop-pool ${mode} attestation did not prove the installed runtime bundle identity.`);
    }
  }
  const laneNumbers = new Set();
  const sessionIds = new Set();
  let activeCount = 0;
  for (const lane of proof.lanes) {
    if (!isRecord(lane)) throw new Error(`Desktop-pool ${mode} attestation contains a non-object lane.`);
    const active = lane.state === "active";
    assertExactKeys(lane, new Set(active
      ? ["lane", "port", "profileSha256", "sessionIds", "state", "listenerPid", "browserInstanceId", "bundleId", "teamId"]
      : ["lane", "port", "profileSha256", "sessionIds", "state"]), `Desktop-pool lane ${lane.lane ?? "unknown"}`);
    if (!Number.isSafeInteger(lane.lane) || lane.lane < 1 || lane.lane > 10 || laneNumbers.has(lane.lane)
      || !Number.isSafeInteger(lane.port) || lane.port < 1024 || lane.port > 65_535
      || lane.port !== proof.startPort + lane.lane - 1
      || !/^[a-f0-9]{64}$/.test(lane.profileSha256)
      || !Array.isArray(lane.sessionIds)
      || lane.sessionIds.some((id) => typeof id !== "string" || !DESKTOP_SESSION_ID_PATTERN.test(id) || sessionIds.has(id))) {
      throw new Error(`Desktop-pool ${mode} attestation contains an invalid or duplicate lane identity.`);
    }
    laneNumbers.add(lane.lane);
    for (const id of lane.sessionIds) sessionIds.add(id);
    if (active) {
      activeCount += 1;
      if (mode === "offline" || lane.sessionIds.length !== 1
        || !Number.isSafeInteger(lane.listenerPid) || lane.listenerPid <= 0
        || typeof lane.browserInstanceId !== "string" || lane.browserInstanceId.length < 8
        || !["com.openai.codex", "com.openai.chat"].includes(lane.bundleId)
        || lane.teamId !== "2DC432GLL2") {
        throw new Error(`Desktop-pool ${mode} attestation contains invalid active-lane proof.`);
      }
    } else if (lane.state !== "offline" || lane.sessionIds.length !== 0) {
      throw new Error(`Desktop-pool ${mode} attestation contains invalid offline-lane proof.`);
    }
  }
  if (options.expectedActiveCount !== undefined && activeCount !== options.expectedActiveCount) {
    throw new Error(`Desktop-pool active attestation expected ${options.expectedActiveCount} active lanes; received ${activeCount}.`);
  }
  return proof;
}

export function validateConcurrentReceipts(receipts, activeProof, expectedCount) {
  if (receipts.length !== expectedCount) throw new Error(`Expected ${expectedCount} completed receipts; received ${receipts.length}.`);
  const unique = (field, label) => {
    const values = receipts.map((receipt) => receipt[field]);
    if (values.some((value) => value === undefined || value === null || value === "") || new Set(values).size !== expectedCount) {
      throw new Error(`Acceptance did not prove ${expectedCount} distinct ${label}.`);
    }
  };
  unique("conversationId", "broker conversations");
  unique("runId", "durable runs");
  unique("localBrowserSessionId", "local browser sessions");
  unique("providerConversationId", "provider conversations");
  unique("providerConversationUrlSha256", "provider conversation URLs");
  unique("desktopPoolLane", "desktop-pool lanes");
  validatePoolAttestation(activeProof, "active", { expectedActiveCount: expectedCount });
  const active = activeProof.lanes.filter((lane) => isRecord(lane) && lane.state === "active" && Array.isArray(lane.sessionIds));
  const matched = receipts.map((receipt) => active.find((lane) => lane.lane === receipt.desktopPoolLane && lane.sessionIds.includes(receipt.localBrowserSessionId)));
  if (matched.some((lane) => !lane)) throw new Error("Desktop-pool active attestation does not bind every run to its exact lane session.");
  for (const field of ["listenerPid", "port", "profileSha256", "browserInstanceId"]) {
    const values = matched.map((lane) => lane[field]);
    if (values.some((value) => value === undefined || value === "") || new Set(values).size !== expectedCount) {
      throw new Error(`Desktop-pool active attestation did not prove distinct ${field} values.`);
    }
  }
  if (matched.some((lane) => !Number.isSafeInteger(lane.listenerPid) || lane.listenerPid <= 0
    || !Number.isSafeInteger(lane.port) || lane.port < 1024 || lane.port > 65_535
    || !/^[a-f0-9]{64}$/.test(lane.profileSha256)
    || typeof lane.browserInstanceId !== "string" || lane.browserInstanceId.length < 8)) {
    throw new Error("Desktop-pool active attestation contains an invalid process, port, profile, or browser identity.");
  }
  return true;
}

export async function runAcceptance(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const attestPool = dependencies.attestPool ?? dependencies.assertPoolOffline ?? attestInstalledPool;
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
  if (env.GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET !== "1") {
    throw new Error("Live acceptance requires explicit GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1 authority.");
  }
  if (options.count > 1 && env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STRESS !== STRESS_ACK) {
    throw new Error(`Multiple-session acceptance requires GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STRESS=${STRESS_ACK}.`);
  }
  const installRoot = resolve(options.installRoot ?? env.GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT ?? "");
  if (!options.installRoot && !env.GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT) throw new Error("Live acceptance requires an explicit installed package root.");
  if (await realpath(installRoot) === await realpath(sourceRoot)) throw new Error("Live acceptance must use an installed package, not the source checkout.");
  const config = await loadPrivateRequest(options.requestFile);
  if (typeof config.model !== "string" || typeof config.effort !== "string") {
    throw new Error("Live acceptance requires explicit model and effort in its private request file.");
  }
  const questions = config.questions?.length ? config.questions : DEFAULT_QUESTIONS;
  if (questions.length < options.count) throw new Error("The private request does not contain enough acceptance questions.");
  const workspaceRoot = resolve(config.workspaceRoot ?? sourceRoot);
  const files = (config.files ?? []).map((path) => resolve(workspaceRoot, path));
  const attachmentSha256s = [];
  for (const path of files) {
    const { bytes } = await readRegularFileNoFollow(path, 5 * 1024 * 1024);
    attachmentSha256s.push(sha256Bytes(bytes));
  }
  const cooldownHours = Number(env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_COOLDOWN_HOURS ?? DEFAULT_COOLDOWN_HOURS);
  if (!Number.isFinite(cooldownHours) || cooldownHours < 1 || cooldownHours > 168) throw new Error("Live acceptance cooldown must be 1-168 hours.");
  const cooldownPath = resolve(env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STATE ?? join(homedir(), ".gpt-control", "live-acceptance.json"));
  const prevalidatedRuntime = dependencies.startInstalledMcp ? undefined : await inspectInstalledRuntime(installRoot, env);
  const initialOfflineProof = await attestPool(env, installRoot, "attest_offline", prevalidatedRuntime);
  validatePoolAttestation(initialOfflineProof, "offline", prevalidatedRuntime ? { runtime: prevalidatedRuntime } : {});
  const cooldownLease = await beginCooldown(cooldownPath, options.count, cooldownHours, env.GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_OVERRIDE === "1");
  const childEnv = { ...env, GPT_CONTROL_WORKSPACE_ROOT: workspaceRoot };
  let started;
  try {
    started = await startMcp(installRoot, childEnv, prevalidatedRuntime);
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
        const failedConversationId = result.reason?.toolResult?.structuredContent?.conversationId;
        if (typeof failedConversationId === "string") conversations.add(failedConversationId);
        failures.push(result.reason);
        continue;
      }
      const conversationId = result.value?.structuredContent?.conversationId;
      if (typeof conversationId === "string") conversations.add(conversationId);
      try {
        receipts.push(compactRunReceipt(result.value, {
          model: config.model,
          effort: config.effort,
          fileCount: files.length,
          attachmentSha256s,
        }));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} installed product-path call${failures.length === 1 ? "" : "s"} failed.`);
    const activeProof = await attestPool(env, installRoot, "attest_active", prevalidatedRuntime);
    validateConcurrentReceipts(receipts, activeProof, options.count);
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
    try {
      await started.assertRuntime?.();
    } catch (error) {
      cleanupErrors.push(`installed runtime changed during MCP execution: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let cleanupProof;
  try {
    cleanupProof = await attestPool(env, installRoot, "attest_offline", prevalidatedRuntime);
    validatePoolAttestation(cleanupProof, "offline", prevalidatedRuntime ? { runtime: prevalidatedRuntime } : {});
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
  let result;
  try {
    await started.assertRuntime?.();
    result = {
      mode: "live",
      path: "installed-mcp",
      server: initialized.serverInfo,
      installRootPathSha256: sha256(await realpath(installRoot)),
      launcherSha256: started.runtime?.launcherHashes?.["bin/gpt-control-mcp"] ?? sha256Bytes(await readFile(launcher)),
      poolDriverSha256: started.runtime?.launcherHashes?.["bin/gpt-control-desktop-pool-driver"] ?? sha256Bytes(await readFile(poolDriver)),
      runtimeBundleHashes: started.runtime?.bundleHashes,
      sourceHead: started.runtime?.sourceHead,
      count: options.count,
      receipts,
      cleanup: cleanupProof,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    await finishCooldown(cooldownPath, "failed", cooldownLease);
    throw error;
  }
  await finishCooldown(cooldownPath, "passed", cooldownLease);
  return result;
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
    const bytes = await handle.readFile();
    return { info: after, text: bytes.toString("utf8"), bytes };
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
