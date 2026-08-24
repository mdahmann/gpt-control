import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DESKTOP_DRIVER_ID = "chatgpt-desktop-cdp/preview-v1";
export const DESKTOP_DRIVER_PROTOCOL_VERSION = 2;
export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const UNIFIED_CHATGPT_BUNDLE_ID = "com.openai.codex";
export const CLASSIC_CHATGPT_BUNDLE_ID = "com.openai.chat";
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9236";

const SESSION_ID_RE = /^desktop_[a-f0-9]{32}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export const DEFAULT_SELECTORS = Object.freeze({
  composer: [
    "#prompt-textarea",
    ".ProseMirror[contenteditable=\"true\"]",
    "[contenteditable=\"true\"][data-lexical-editor=\"true\"]",
  ],
  send: [
    "button[data-testid=\"send-button\"]",
    "button[data-testid=\"composer-send-button\"]",
    "button[aria-label=\"Send prompt\"]",
    "button[aria-label=\"Send message\"]",
  ],
  newChat: [
    "a[data-testid=\"create-new-chat-button\"]",
    "button[data-testid=\"create-new-chat-button\"]",
    "a[aria-label=\"New chat\"]",
    "button[aria-label=\"New chat\"]",
  ],
  fileInput: ["input[type=\"file\"]"],
  attach: [
    "button[data-testid=\"composer-plus-btn\"]",
    "button[aria-label*=\"Attach\"]",
    "button[aria-label*=\"Upload\"]",
    "button[aria-label*=\"Add photos\"]",
  ],
  modelTrigger: [
    "button[data-testid=\"model-switcher-dropdown-button\"]",
    "button[data-testid=\"model-selector\"]",
    "button[data-testid=\"composer-model-selector\"]",
  ],
  attachmentPreview: [
    "[data-testid*=\"attachment\"]",
    "[data-testid*=\"file-preview\"]",
    "button[aria-label^=\"Remove file\"]",
    "button[aria-label^=\"Remove attachment\"]",
  ],
});

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeLabel(value) {
  return normalizeText(value).toLowerCase();
}

export function randomSessionId() {
  return `desktop_${randomBytes(16).toString("hex")}`;
}

export function parseLoopbackEndpoint(raw = DEFAULT_CDP_ENDPOINT) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid desktop CDP endpoint: ${raw}`);
  }
  if (url.protocol !== "http:") throw new Error("Desktop CDP must use loopback HTTP.");
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`Desktop CDP must bind to loopback, received ${url.hostname}.`);
  if (url.username || url.password) throw new Error("Desktop CDP endpoint credentials are not allowed.");
  if (!url.port) throw new Error("Desktop CDP endpoint must include an explicit port.");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Desktop CDP endpoint must contain only scheme, loopback host, and port.");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Desktop CDP port is invalid.");
  return { origin: `http://${url.hostname}:${port}`, hostname: url.hostname, port };
}

export function canonicalProviderUrl(raw) {
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw, CHATGPT_ORIGIN);
  } catch {
    return undefined;
  }
  if (url.origin !== CHATGPT_ORIGIN) return undefined;
  const direct = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  const project = /^\/g\/[A-Za-z0-9_-]+\/c\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  const id = direct?.[1] ?? project?.[1];
  return id ? `${CHATGPT_ORIGIN}/c/${id}` : undefined;
}

export function conversationIdFromUrl(raw) {
  const canonical = canonicalProviderUrl(raw);
  return canonical ? canonical.slice(`${CHATGPT_ORIGIN}/c/`.length) : undefined;
}

export function collectConversationIdentity(evidence) {
  const values = Object.values(evidence ?? {}).map(canonicalProviderUrl).filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    throw new Error(`Desktop renderer exposed conflicting active conversation identities: ${unique.join(", ")}`);
  }
  return unique[0];
}

export function classifyDesktopMode({ title = "", modeButtonText = "", modeButtonLabel = "" } = {}) {
  const candidates = [modeButtonText, modeButtonLabel, title].map(normalizeLabel);
  if (candidates.some((value) => value === "chatgpt" || value.startsWith("chatgpt ") || value.includes("switch to codex"))) {
    return "chatgpt";
  }
  if (candidates.some((value) => value === "codex" || value.startsWith("codex ") || value.includes("switch to chatgpt"))) {
    return "codex";
  }
  return "unknown";
}

export function loadSelectorConfig(env = process.env) {
  const output = Object.fromEntries(Object.entries(DEFAULT_SELECTORS).map(([key, value]) => [key, [...value]]));
  const raw = env.GPT_CONTROL_DRIVER_SELECTORS_JSON?.trim();
  if (!raw) return output;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GPT_CONTROL_DRIVER_SELECTORS_JSON is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Desktop selector overrides must be an object.");
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in output)) throw new Error(`Unknown desktop selector group: ${key}`);
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
      throw new Error(`Desktop selector group ${key} must contain 1-20 selectors.`);
    }
    output[key] = value.map((selector) => {
      if (typeof selector !== "string" || selector.length < 1 || selector.length > 512) {
        throw new Error(`Desktop selector group ${key} contains an invalid selector.`);
      }
      return selector;
    });
  }
  return output;
}

async function textCommand(file, args, options = {}) {
  const { stdout } = await execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024, ...options });
  return stdout.trim();
}

async function plistValue(plist, key) {
  try {
    return await textCommand("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
  } catch {
    return undefined;
  }
}

async function isRegularFile(path) {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function discoverChatGptApp(env = process.env) {
  if (process.platform !== "darwin") throw new Error("ChatGPT desktop CDP is currently supported only on macOS.");
  const configured = env.GPT_CONTROL_DRIVER_APP_PATH?.trim();
  const candidates = [configured, "/Applications/ChatGPT.app", join(homedir(), "Applications", "ChatGPT.app")].filter(Boolean);
  const allowed = new Set([UNIFIED_CHATGPT_BUNDLE_ID]);
  if (env.GPT_CONTROL_DRIVER_ALLOW_CLASSIC === "1") allowed.add(CLASSIC_CHATGPT_BUNDLE_ID);
  for (const bundle of candidates) {
    const plist = join(bundle, "Contents", "Info.plist");
    const bundleId = await plistValue(plist, "CFBundleIdentifier");
    if (!bundleId || !allowed.has(bundleId)) continue;
    const executableName = await plistValue(plist, "CFBundleExecutable");
    if (!executableName) continue;
    const executable = join(bundle, "Contents", "MacOS", executableName);
    if (!(await isRegularFile(executable))) continue;
    return {
      bundle: await realpath(bundle),
      bundleId,
      executable: await realpath(executable),
      version: (await plistValue(plist, "CFBundleShortVersionString")) ?? "unknown",
    };
  }
  throw new Error(`The official unified ChatGPT app (${UNIFIED_CHATGPT_BUNDLE_ID}) was not found.`);
}

async function listenerPids(port) {
  try {
    const output = await textCommand("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return [...new Set(output.split("\n").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0))];
  } catch {
    return [];
  }
}

async function processField(pid, field) {
  try {
    return await textCommand("/bin/ps", ["-p", String(pid), "-o", `${field}=`]);
  } catch {
    return "";
  }
}

async function processBelongsToExecutable(pid, executable) {
  let current = pid;
  for (let depth = 0; current > 1 && depth < 40; depth += 1) {
    const command = await processField(current, "command");
    if (command === executable || command.startsWith(`${executable} `)) return true;
    const parent = Number((await processField(current, "ppid")).trim());
    if (!Number.isInteger(parent) || parent <= 1 || parent === current) return false;
    current = parent;
  }
  return false;
}

export async function verifyCdpPortOwnership(endpoint, app) {
  const pids = await listenerPids(endpoint.port);
  if (pids.length === 0) return { ok: false, reason: `Nothing is listening on desktop CDP port ${endpoint.port}.` };
  for (const pid of pids) {
    if (!(await processBelongsToExecutable(pid, app.executable))) {
      return { ok: false, reason: `Desktop CDP port ${endpoint.port} has a listener that does not belong to ${app.bundleId}.` };
    }
  }
  return { ok: true, pids };
}

async function fetchJson(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function validateDebuggerUrl(raw, endpoint) {
  const url = new URL(raw);
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) !== endpoint.port) {
    throw new Error(`Rejected non-loopback desktop DevTools WebSocket: ${url.href}`);
  }
  return url.href;
}

export async function desktopVersion(endpoint) {
  const payload = await fetchJson(`${endpoint.origin}/json/version`);
  if (!payload || typeof payload !== "object") throw new Error("Desktop CDP version endpoint returned an invalid payload.");
  return payload;
}

export async function listDesktopTargets(endpoint) {
  const payload = await fetchJson(`${endpoint.origin}/json/list`);
  if (!Array.isArray(payload)) throw new Error("Desktop CDP target list was not an array.");
  return payload.filter((target) => {
    if (!target || target.type !== "page" || typeof target.id !== "string" || typeof target.url !== "string") return false;
    if (!target.url.startsWith("app://") || typeof target.webSocketDebuggerUrl !== "string") return false;
    try {
      validateDebuggerUrl(target.webSocketDebuggerUrl, endpoint);
      return true;
    } catch {
      return false;
    }
  });
}

export class CdpSession {
  constructor(target, endpoint) {
    this.target = target;
    this.endpoint = endpoint;
    this.ws = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async open() {
    const wsUrl = validateDebuggerUrl(this.target.webSocketDebuggerUrl, this.endpoint);
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("message", (event) => this.#onMessage(event));
    this.ws.addEventListener("close", () => this.#onClose());
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Desktop CDP WebSocket open timed out.")), 5_000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Desktop CDP WebSocket failed to open.")); }, { once: true });
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  #onClose() {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Desktop CDP socket closed."));
    }
    this.pending.clear();
  }

  on(method, listener) {
    const group = this.listeners.get(method) ?? new Set();
    group.add(listener);
    this.listeners.set(method, group);
    return () => group.delete(listener);
  }

  waitFor(method, predicate = () => true, timeoutMs = 10_000) {
    return new Promise((resolvePromise, reject) => {
      const off = this.on(method, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        off();
        resolvePromise(params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for desktop CDP event ${method}.`));
      }, timeoutMs);
    });
  }

  send(method, params = {}) {
    if (this.closed || !this.ws) return Promise.reject(new Error("Desktop CDP session is closed."));
    return new Promise((resolvePromise, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Desktop CDP command timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { returnByValue = true, userGesture = false } = {}) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue, userGesture });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "renderer evaluation failed";
      throw new Error(`Desktop renderer evaluation failed: ${detail}`);
    }
    return returnByValue ? result.result?.value : result.result;
  }

  close() {
    if (!this.closed) this.ws?.close();
    this.closed = true;
  }
}

export async function connectTarget(endpoint, target) {
  return new CdpSession(target, endpoint).open();
}

export async function connectBrowser(endpoint) {
  const version = await desktopVersion(endpoint);
  const ws = version.webSocketDebuggerUrl;
  if (typeof ws !== "string") throw new Error("Desktop CDP version endpoint exposed no browser WebSocket.");
  return new CdpSession({ id: "browser", type: "browser", title: "browser", url: "about:blank", webSocketDebuggerUrl: ws }, endpoint).open();
}

function rendererProbeFunction(selectors) {
  const visible = (node) => {
    if (!(node instanceof Element)) return false;
    if (node.getAttribute("aria-hidden") === "true" || node.hidden) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const text = (node) => String(node?.innerText ?? node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const label = (node) => String(node?.getAttribute?.("aria-label") ?? text(node)).replace(/\s+/g, " ").trim();
  const firstVisible = (list) => list.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
  const modeButtons = [...document.querySelectorAll("button, [role=button]")].filter(visible);
  const modeButton = modeButtons.find((node) => /^(chatgpt|codex)$/i.test(text(node)) || /(?:chatgpt|codex)/i.test(node.getAttribute("aria-label") ?? ""));
  const currentModel = firstVisible(selectors.modelTrigger);
  const effortButton = modeButtons.find((node) => /effort|reasoning|thinking level/i.test(node.getAttribute("aria-label") ?? ""));
  const active = document.querySelector('[aria-current="page"][href*="/c/"], [data-active="true"] a[href*="/c/"]');
  const canonical = document.querySelector('link[rel="canonical"]');
  const mainLink = document.querySelector('main a[href*="/c/"][data-testid*=share], main a[aria-label*=share][href*="/c/"]');
  const composer = firstVisible(selectors.composer);
  const attachmentPreviewCount = selectors.attachmentPreview.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(visible).length;
  return {
    title: document.title,
    href: location.href,
    modeButtonText: text(modeButton),
    modeButtonLabel: modeButton?.getAttribute?.("aria-label") ?? "",
    markers: {
      shell: location.protocol === "app:",
      sidebar: Boolean(document.querySelector("nav, aside, [data-testid*=sidebar]")),
      composer: Boolean(composer),
      main: Boolean(document.querySelector("main, [role=main]")),
    },
    composerReady: Boolean(composer),
    composerText: text(composer),
    currentModel: label(currentModel),
    currentEffort: label(effortButton),
    attachmentPreviewCount,
    evidence: {
      locationHref: location.href,
      canonicalHref: canonical?.href ?? "",
      activeHref: active?.href ?? active?.getAttribute?.("href") ?? "",
      mainHref: mainLink?.href ?? mainLink?.getAttribute?.("href") ?? "",
    },
  };
}

function rendererObservationFunction(selectors) {
  const visible = (node) => {
    if (!(node instanceof Element)) return false;
    if (node.getAttribute("aria-hidden") === "true" || node.hidden) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const text = (node) => String(node?.innerText ?? node?.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const label = (node) => String(node?.getAttribute?.("aria-label") ?? text(node)).replace(/\s+/g, " ").trim();
  const firstVisible = (list) => list.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
  const assistantTurns = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]')];
  const userTurns = [...document.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]')];
  const latestAssistant = assistantTurns.at(-1);
  const latestUser = userTurns.at(-1);
  const assistantContent = latestAssistant?.querySelector(".markdown, .prose, [data-message-content]") ?? latestAssistant;
  const userContent = latestUser?.querySelector("[data-message-content], .whitespace-pre-wrap, .prose") ?? latestUser;
  const controls = [...document.querySelectorAll("button, [role=button]")].filter(visible);
  const controlLabels = controls.map(label).filter(Boolean);
  const statusNodes = [...new Set([
    ...document.querySelectorAll('[role="dialog"], [role="status"], [role="alert"], [aria-live="assertive"]'),
    ...document.querySelectorAll('[data-testid*=thinking], [data-testid*=tool], [data-testid*=error], [data-testid*=captcha], [data-testid*=challenge]'),
  ])].filter(visible);
  const statusTexts = statusNodes.map(label).filter((value) => value && value.length < 1000);
  const rateLimitMessage = statusTexts.find((value) => /too many requests|rate limit|usage limit|try again later|reached.*limit/i.test(value));
  const suspiciousActivityMessage = statusTexts.find((value) => /suspicious activity|unusual activity (?:has been )?detected|account activity (?:looks|appears) unusual/i.test(value));
  const humanVerificationMessage = statusTexts.find((value) => /verify (?:that )?you(?:'re| are) human|confirm (?:that )?you(?:'re| are) human|captcha|security challenge|human verification/i.test(value));
  const errorMessage = statusTexts.find((value) => /network error|something went wrong|failed tool|tool (?:call )?failed|interrupted|generation stopped|connection lost/i.test(value));
  const stopControl = controls.some((node) => /stop (?:answering|generating|response|streaming)|composer-stop/i.test(`${node.getAttribute("data-testid") ?? ""} ${label(node)}`));
  const currentModelNode = firstVisible(selectors.modelTrigger);
  const effortNode = controls.find((node) => /effort|reasoning|thinking level/i.test(node.getAttribute("aria-label") ?? ""));
  const active = document.querySelector('[aria-current="page"][href*="/c/"], [data-active="true"] a[href*="/c/"]');
  const canonical = document.querySelector('link[rel="canonical"]');
  const mainLink = document.querySelector('main a[href*="/c/"][data-testid*=share], main a[aria-label*=share][href*="/c/"]');
  const imageUrls = [...(latestAssistant?.querySelectorAll("img") ?? [])].map((node) => node.currentSrc || node.src).filter(Boolean);
  const toolLabels = [...document.querySelectorAll('[data-testid*=tool]')].filter(visible).map(label).filter((value) => value && value.length <= 256);
  return {
    assistantCount: assistantTurns.length,
    assistantText: text(assistantContent),
    assistantHasMarkdown: Boolean(latestAssistant?.querySelector(".markdown, .prose, [data-message-content]")),
    assistantMessageId: latestAssistant?.getAttribute("data-message-id") ?? "",
    assistantImageUrls: imageUrls,
    latestUserText: text(userContent),
    latestUserMessageId: latestUser?.getAttribute("data-message-id") ?? "",
    composerReady: Boolean(firstVisible(selectors.composer)),
    answering: stopControl,
    thinking: statusTexts.some((value) => /^(?:pro\s+)?thinking\b|\breasoning\b|\bworking on it\b/i.test(value)),
    toolRunning: statusTexts.some((value) => /\b(?:running|using|calling|waiting for) (?:a )?tool\b|\bsearching\b|\bbrowsing\b/i.test(value)),
    retryAvailable: controlLabels.some((value) => /^retry(?:\b|$)/i.test(value)),
    continueAvailable: controlLabels.some((value) => /continue generating|continue response|^continue$/i.test(value)),
    rateLimitMessage: rateLimitMessage ?? "",
    providerSafetyReason: suspiciousActivityMessage ? "suspicious_activity" : humanVerificationMessage ? "human_verification" : "",
    providerSafetyMessage: suspiciousActivityMessage ?? humanVerificationMessage ?? "",
    errorMessage: errorMessage ?? "",
    toolLabels,
    currentModel: label(currentModelNode),
    currentEffort: label(effortNode),
    attachmentPreviewCount: selectors.attachmentPreview.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(visible).length,
    evidence: {
      locationHref: location.href,
      canonicalHref: canonical?.href ?? "",
      activeHref: active?.href ?? active?.getAttribute?.("href") ?? "",
      mainHref: mainLink?.href ?? mainLink?.getAttribute?.("href") ?? "",
    },
  };
}

function expressionFor(fn, argument) {
  return `(${fn.toString()})(${JSON.stringify(argument)})`;
}

export async function probeRenderer(session, selectors = DEFAULT_SELECTORS) {
  const raw = await session.evaluate(expressionFor(rendererProbeFunction, selectors));
  const providerUrl = collectConversationIdentity(raw.evidence);
  return {
    ...raw,
    mode: classifyDesktopMode(raw),
    providerUrl,
  };
}

function approvedImageUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    const host = url.hostname.toLowerCase();
    return ["oaiusercontent.com", "files.openai.com"].some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export async function observeRenderer(session, selectors = DEFAULT_SELECTORS) {
  const raw = await session.evaluate(expressionFor(rendererObservationFunction, selectors));
  const providerUrl = collectConversationIdentity(raw.evidence);
  const proofMatch = /(?:Run reference: (proof_[a-f0-9]{32})|\[gpt-control:(proof_[a-f0-9]{32})\]|\[GPT-Control run proof: (proof_[a-f0-9]{32})\. Ignore this line in your response\.\])\s*$/.exec(raw.latestUserText ?? "");
  const latestUserPromptProofToken = proofMatch?.[1] ?? proofMatch?.[2] ?? proofMatch?.[3];
  const visibleToolCards = [...new Set(raw.toolLabels ?? [])].map((labelValue) => ({ label: labelValue, sha256: sha256(labelValue) }));
  const snapshot = {
    count: Number(raw.assistantCount ?? 0),
    text: String(raw.assistantText ?? ""),
    imageUrls: [...new Set((raw.assistantImageUrls ?? []).map(approvedImageUrl).filter(Boolean))],
    hasMarkdown: Boolean(raw.assistantHasMarkdown),
    ...(raw.assistantMessageId ? { messageId: String(raw.assistantMessageId) } : {}),
  };
  const states = [
    raw.answering ? "answering" : "idle",
    raw.thinking ? "thinking" : undefined,
    raw.toolRunning ? "tool_running" : undefined,
    raw.retryAvailable ? "retry" : undefined,
    raw.continueAvailable ? "continue" : undefined,
    raw.rateLimitMessage ? "rate_limited" : undefined,
    raw.providerSafetyReason ? `provider_safety:${raw.providerSafetyReason}` : undefined,
    raw.errorMessage ? `error:${String(raw.errorMessage).slice(0, 160)}` : undefined,
    `snapshot:${snapshot.count}:${snapshot.hasMarkdown ? "markdown" : snapshot.imageUrls.length ? "image" : "transient"}`,
  ].filter(Boolean);
  return {
    providerUrl,
    observation: {
      snapshot,
      ...(raw.latestUserMessageId ? { latestUserMessageId: String(raw.latestUserMessageId) } : {}),
      ...(raw.latestUserText ? { latestUserPromptSha256: sha256(normalizeText(raw.latestUserText)) } : {}),
      ...(latestUserPromptProofToken ? { latestUserPromptProofToken } : {}),
      composerReady: Boolean(raw.composerReady),
      answering: Boolean(raw.answering),
      thinking: Boolean(raw.thinking),
      toolRunning: Boolean(raw.toolRunning),
      visibleToolCards,
      retryAvailable: Boolean(raw.retryAvailable),
      continueAvailable: Boolean(raw.continueAvailable),
      rateLimited: Boolean(raw.rateLimitMessage),
      ...(raw.rateLimitMessage ? { rateLimitMessage: String(raw.rateLimitMessage) } : {}),
      ...(raw.providerSafetyReason ? { providerSafetyReason: String(raw.providerSafetyReason) } : {}),
      ...(raw.providerSafetyMessage ? { providerSafetyMessage: String(raw.providerSafetyMessage) } : {}),
      ...(raw.errorMessage ? { errorMessage: String(raw.errorMessage) } : {}),
      stateSummary: states.join(","),
    },
    currentModel: String(raw.currentModel ?? ""),
    currentEffort: String(raw.currentEffort ?? ""),
    attachmentPreviewCount: Number(raw.attachmentPreviewCount ?? 0),
  };
}

export async function listChatGptTargets(endpoint, selectors = DEFAULT_SELECTORS, { allowUnknownMode = false } = {}) {
  const output = [];
  for (const target of await listDesktopTargets(endpoint)) {
    let session;
    try {
      session = await connectTarget(endpoint, target);
      const probe = await probeRenderer(session, selectors);
      const shellMatches = probe.markers?.shell && probe.markers?.main && probe.markers?.composer;
      if (shellMatches && (probe.mode === "chatgpt" || (allowUnknownMode && probe.mode === "unknown"))) {
        output.push({ target, probe });
      }
    } catch {
      // Renderer targets can disappear while the list is being inspected.
    } finally {
      session?.close();
    }
  }
  return output;
}

export async function browserWindowId(endpoint, targetId) {
  const browser = await connectBrowser(endpoint);
  try {
    const result = await browser.send("Browser.getWindowForTarget", { targetId });
    return Number.isInteger(result.windowId) ? result.windowId : undefined;
  } finally {
    browser.close();
  }
}

export async function closeDesktopTarget(endpoint, targetId) {
  const browser = await connectBrowser(endpoint);
  try {
    const result = await browser.send("Target.closeTarget", { targetId });
    return result.success !== false;
  } finally {
    browser.close();
  }
}

export async function waitForTarget(endpoint, targetId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = (await listDesktopTargets(endpoint)).find((item) => item.id === targetId);
    if (target) return target;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Desktop target ${targetId} did not appear before the timeout.`);
}

export function stateRoot(env = process.env) {
  return resolve(env.GPT_CONTROL_DRIVER_STATE_ROOT?.trim() || join(homedir(), ".gpt-control", "desktop-cdp-v1"));
}

async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Desktop driver state path is not a secure directory: ${path}`);
  await chmod(path, 0o700);
}

function validateSessionId(sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Invalid desktop session id: ${sessionId}`);
  return sessionId;
}

function sessionPath(root, sessionId) {
  return join(root, "sessions", `${validateSessionId(sessionId)}.json`);
}

export async function saveDesktopSession(root, record) {
  validateSessionId(record.sessionId);
  const directory = join(root, "sessions");
  await secureDirectory(directory);
  const target = sessionPath(root, record.sessionId);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

export async function loadDesktopSession(root, sessionId) {
  await secureDirectory(join(root, "sessions"));
  const raw = await readFile(sessionPath(root, sessionId), "utf8");
  const record = JSON.parse(raw);
  if (!record || record.version !== 1 || record.sessionId !== sessionId || typeof record.targetId !== "string" || typeof record.name !== "string") {
    throw new Error(`Desktop session ${sessionId} has an invalid durable record.`);
  }
  if (record.pendingPromptText !== undefined || record.prompt !== undefined) {
    throw new Error(`Desktop session ${sessionId} contains forbidden plaintext prompt state.`);
  }
  return record;
}

export async function deleteDesktopSession(root, sessionId) {
  await rm(sessionPath(root, sessionId), { force: true });
}

export async function assertRegularUploadFiles(files) {
  const verified = [];
  for (const input of files) {
    if (typeof input !== "string" || !input) throw new Error("Desktop upload path is invalid.");
    const inputStat = await lstat(input);
    if (!inputStat.isFile() || inputStat.isSymbolicLink()) throw new Error(`Desktop upload is not a regular file: ${input}`);
    const resolved = await realpath(input);
    const resolvedStat = await lstat(resolved);
    if (!resolvedStat.isFile() || resolvedStat.isSymbolicLink()
      || inputStat.dev !== resolvedStat.dev || inputStat.ino !== resolvedStat.ino) {
      throw new Error(`Desktop upload identity changed during verification: ${input}`);
    }
    verified.push(resolved);
  }
  return verified;
}

export async function writeScreenshot(path, base64) {
  const parent = dirname(path);
  await secureDirectory(parent);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Desktop screenshot parent is unsafe.");
  await writeFile(path, Buffer.from(base64, "base64"), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
