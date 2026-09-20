import { readFile } from "node:fs/promises";
import {
  CHATGPT_ORIGIN,
  DEFAULT_CDP_ENDPOINT,
  DESKTOP_DRIVER_ID,
  DESKTOP_DRIVER_PROTOCOL_VERSION,
  assertRegularUploadFiles,
  browserWindowId,
  canonicalProviderUrl,
  closeDesktopTarget,
  collectConversationIdentity,
  connectBrowser,
  connectTarget,
  conversationIdFromUrl,
  deleteDesktopSession,
  discoverChatGptApp,
  errorMessage,
  listChatGptTargets,
  listDesktopTargets,
  loadDesktopSession,
  loadSelectorConfig,
  normalizeLabel,
  normalizeText,
  observeRenderer,
  parseLoopbackEndpoint,
  probeRenderer,
  randomSessionId,
  saveDesktopSession,
  sha256,
  stateRoot,
  verifyCdpPortOwnership,
  waitForTarget,
  writeScreenshot,
} from "./desktop-cdp-core.mjs";

const ROOT_URLS = new Set([CHATGPT_ORIGIN, `${CHATGPT_ORIGIN}/`]);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allowedProviderUrl(raw) {
  if (ROOT_URLS.has(raw)) return CHATGPT_ORIGIN;
  const canonical = canonicalProviderUrl(raw);
  if (!canonical) throw new Error(`Desktop driver refused unprovable ChatGPT URL: ${raw}`);
  return canonical;
}

export function requestedSelection(value) {
  if (typeof value === "string") return { model: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop model selection is invalid.");
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  const effort = typeof value.effort === "string" && value.effort.trim() ? value.effort.trim() : undefined;
  if (!model && !effort) throw new Error("Desktop model selection requires model or effort.");
  return { model, effort };
}

export function assertSessionEnvelope(record, session) {
  if (!session || typeof session !== "object") throw new Error("Desktop action requires an exact session envelope.");
  if (session.sessionId !== record.sessionId) throw new Error("Desktop session id changed before action.");
  if (String(session.pageId) !== String(record.targetId)) throw new Error("Desktop target id changed before action.");
  if (session.name !== record.name) throw new Error("Desktop session name changed before action.");
  const supplied = ROOT_URLS.has(session.url) ? CHATGPT_ORIGIN : canonicalProviderUrl(session.url);
  if (!supplied) throw new Error(`Desktop session returned an invalid provider URL: ${session.url}`);
  if (record.providerUrl && supplied !== CHATGPT_ORIGIN && supplied !== record.providerUrl) {
    throw new Error(`Desktop session URL drifted from ${record.providerUrl} to ${session.url}.`);
  }
}

function publicSession(record) {
  return {
    sessionId: record.sessionId,
    pageId: record.targetId,
    name: record.name,
    url: record.providerUrl ?? CHATGPT_ORIGIN,
  };
}

function exactLabelEquals(actual, expected) {
  return normalizeLabel(actual) === normalizeLabel(expected);
}

function modelVerification(selection, observedModel, observedEffort) {
  if (selection.model && !exactLabelEquals(observedModel, selection.model)) {
    throw new Error(`Desktop model read-back mismatch: requested ${selection.model}, observed ${observedModel || "nothing"}.`);
  }
  if (selection.effort && !exactLabelEquals(observedEffort, selection.effort)) {
    throw new Error(`Desktop effort read-back mismatch: requested ${selection.effort}, observed ${observedEffort || "nothing"}.`);
  }
  const requestedModel = selection.model ?? observedModel;
  if (!requestedModel || !observedModel) throw new Error("Desktop model selector produced no exact model evidence.");
  return {
    requestedModel,
    observedModel,
    ...(selection.effort ? { requestedEffort: selection.effort } : {}),
    ...(observedEffort ? { observedEffort } : {}),
    modelVerified: true,
    modelEvidenceKind: "composer_selector",
    modelVerifiedAt: nowIso(),
  };
}

function visibleNodeHelpers() {
  return String.raw`
    const visible = (node) => {
      if (!(node instanceof Element) || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const text = (node) => String(node?.innerText ?? node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  `;
}

function composerExpression(selectors, operation) {
  return `(() => { ${visibleNodeHelpers()}
    const selectors = ${JSON.stringify(selectors.composer)};
    const node = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    if (!node) return { ok: false, reason: 'composer unavailable' };
    ${operation}
  })()`;
}

async function readComposerText(session, selectors) {
  const result = await session.evaluate(composerExpression(selectors, "return { ok: true, text: String(node.innerText ?? node.textContent ?? '') };"));
  if (!result?.ok) throw new Error("Desktop composer is unavailable.");
  return String(result.text ?? "");
}

async function focusAndClearComposer(session, selectors) {
  const expression = composerExpression(selectors, String.raw`
    node.focus();
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete');
    if (String(node.innerText ?? node.textContent ?? '').trim()) {
      node.textContent = '';
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    }
    return { ok: true };
  `);
  const result = await session.evaluate(expression, { userGesture: true });
  if (!result?.ok) throw new Error("Desktop composer could not be focused and cleared.");
}

async function clickFirst(session, selectors, labelPattern) {
  const expression = `(() => { ${visibleNodeHelpers()}
    const selectors = ${JSON.stringify(selectors)};
    const pattern = ${labelPattern ? `new RegExp(${JSON.stringify(labelPattern)}, 'i')` : "null"};
    const selected = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible)
      ?? [...document.querySelectorAll('button, a, [role=button], [role=menuitem], [role=option]')]
        .filter(visible).find((node) => pattern && pattern.test(text(node) + ' ' + (node.getAttribute('aria-label') ?? '')));
    if (!selected) return false;
    selected.click();
    return true;
  })()`;
  return Boolean(await session.evaluate(expression, { userGesture: true }));
}

async function clickExactOption(session, expected) {
  const expression = `(() => { ${visibleNodeHelpers()}
    const expected = ${JSON.stringify(normalizeLabel(expected))};
    const nodes = [...document.querySelectorAll('[role=menuitem], [role=option], [role=radio], button')].filter(visible);
    const exact = nodes.filter((node) => text(node).toLowerCase() === expected || (node.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === expected);
    if (exact.length !== 1) return { ok: false, count: exact.length, labels: nodes.map(text).filter(Boolean).slice(0, 40) };
    exact[0].click();
    return { ok: true };
  })()`;
  const result = await session.evaluate(expression, { userGesture: true });
  if (!result?.ok) throw new Error(`Desktop picker did not expose one exact option named ${expected}.`);
}

async function ensureNewChat(session, selectors) {
  let probe = await probeRenderer(session, selectors);
  if (!probe.providerUrl) return probe;
  const clicked = await clickFirst(session, selectors.newChat, "^(new chat|start new chat)$");
  if (!clicked) throw new Error("Desktop renderer has no safe New chat control.");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(250);
    probe = await probeRenderer(session, selectors);
    if (!probe.providerUrl && probe.composerReady) return probe;
  }
  throw new Error("Desktop New chat did not produce a blank owned conversation.");
}

async function navigateToConversation(session, desiredUrl, selectors) {
  let probe = await probeRenderer(session, selectors);
  if (probe.providerUrl === desiredUrl) return probe;
  const desiredId = conversationIdFromUrl(desiredUrl);
  const expression = `(() => { ${visibleNodeHelpers()}
    const desired = ${JSON.stringify(desiredId)};
    const canonicalId = (raw) => {
      try {
        const url = new URL(raw, 'https://chatgpt.com');
        const direct = /^\\/c\\/([A-Za-z0-9_-]+)\\/?$/.exec(url.pathname);
        const project = /^\\/g\\/[A-Za-z0-9_-]+\\/c\\/([A-Za-z0-9_-]+)\\/?$/.exec(url.pathname);
        return direct?.[1] ?? project?.[1];
      } catch { return undefined; }
    };
    const matches = [...document.querySelectorAll('a[href*="/c/"]')].filter(visible).filter((node) => canonicalId(node.href || node.getAttribute('href')) === desired);
    if (matches.length !== 1) return { ok: false, count: matches.length };
    matches[0].click();
    return { ok: true };
  })()`;
  const result = await session.evaluate(expression, { userGesture: true });
  if (!result?.ok) throw new Error(`Desktop renderer cannot safely locate one exact link for ${desiredUrl}.`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(250);
    probe = await probeRenderer(session, selectors);
    if (probe.providerUrl === desiredUrl && probe.composerReady) return probe;
  }
  throw new Error(`Desktop renderer did not reach exact conversation ${desiredUrl}.`);
}

async function currentCounts(session, selectors) {
  const observed = await observeRenderer(session, selectors);
  return {
    userHash: observed.observation.latestUserPromptSha256,
    assistantCount: observed.observation.snapshot.count,
    previewCount: observed.attachmentPreviewCount,
  };
}

async function waitForProviderOrUserTurn(session, selectors, previous, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    await sleep(250);
    latest = await observeRenderer(session, selectors);
    if (latest.providerUrl || (latest.observation.latestUserPromptSha256 && latest.observation.latestUserPromptSha256 !== previous.userHash)) return latest;
  }
  return latest;
}

export class DesktopCdpDriver {
  constructor(env = process.env) {
    this.env = env;
    this.endpoint = parseLoopbackEndpoint(env.GPT_CONTROL_DRIVER_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT);
    this.selectors = loadSelectorConfig(env);
    this.root = stateRoot(env);
    this.allowUnknownMode = env.GPT_CONTROL_DRIVER_ALLOW_UNKNOWN_MODE === "1";
    this.allowSharedWindow = env.GPT_CONTROL_DRIVER_ALLOW_SHARED_WINDOW === "1";
  }

  async environment() {
    const app = await discoverChatGptApp(this.env);
    const ownership = await verifyCdpPortOwnership(this.endpoint, app);
    if (!ownership.ok) throw new Error(ownership.reason);
    return { app, ownership };
  }

  async probe() {
    try {
      await this.environment();
      const targets = await listChatGptTargets(this.endpoint, this.selectors, { allowUnknownMode: this.allowUnknownMode });
      if (targets.length === 0) {
        return {
          ready: false,
          driver: DESKTOP_DRIVER_ID,
          secureInput: true,
          protocolVersion: DESKTOP_DRIVER_PROTOCOL_VERSION,
          reason: "ChatGPT.app exposes CDP, but no verified ChatGPT-mode app:// renderer is available.",
        };
      }
      return {
        ready: true,
        driver: DESKTOP_DRIVER_ID,
        secureInput: true,
        protocolVersion: DESKTOP_DRIVER_PROTOCOL_VERSION,
        reason: `${targets.length} verified ChatGPT desktop renderer(s) available; independent ownership is rechecked for every created session.`,
      };
    } catch (error) {
      return {
        ready: false,
        driver: DESKTOP_DRIVER_ID,
        secureInput: true,
        protocolVersion: DESKTOP_DRIVER_PROTOCOL_VERSION,
        reason: errorMessage(error),
      };
    }
  }

  async create({ name, url }) {
    if (typeof name !== "string" || !name.startsWith("gpt-control:") || name.length > 256) {
      throw new Error("Desktop sessions require a bounded gpt-control ownership name.");
    }
    const desired = allowedProviderUrl(url);
    await this.environment();
    const existing = await listChatGptTargets(this.endpoint, this.selectors, { allowUnknownMode: this.allowUnknownMode });
    if (existing.length === 0) throw new Error("No verified ChatGPT desktop renderer is available as a creation template.");
    const existingWindowIds = new Set();
    for (const item of existing) {
      const id = await browserWindowId(this.endpoint, item.target.id).catch(() => undefined);
      if (id !== undefined) existingWindowIds.add(id);
    }
    const template = existing[0];
    const browser = await connectBrowser(this.endpoint);
    let targetId;
    try {
      const result = await browser.send("Target.createTarget", {
        url: template.target.url,
        newWindow: true,
        background: true,
      });
      targetId = result.targetId;
    } finally {
      browser.close();
    }
    if (typeof targetId !== "string") throw new Error("ChatGPT desktop did not return a new renderer target.");
    let target;
    let session;
    try {
      target = await waitForTarget(this.endpoint, targetId);
      session = await connectTarget(this.endpoint, target);
      let probe = await probeRenderer(session, this.selectors);
      if (probe.mode !== "chatgpt" && !(this.allowUnknownMode && probe.mode === "unknown")) {
        throw new Error(`New desktop renderer opened in ${probe.mode} mode instead of ChatGPT mode.`);
      }
      if (!probe.composerReady) throw new Error("New desktop renderer has no ready ChatGPT composer.");
      const windowId = await browserWindowId(this.endpoint, targetId);
      if (!this.allowSharedWindow && (windowId === undefined || existingWindowIds.has(windowId))) {
        throw new Error("ChatGPT desktop did not create an independently owned window; Chrome remains required for parallel Workers.");
      }
      if (desired === CHATGPT_ORIGIN) probe = await ensureNewChat(session, this.selectors);
      else probe = await navigateToConversation(session, desired, this.selectors);
      const record = {
        version: 1,
        sessionId: randomSessionId(),
        targetId,
        windowId,
        name,
        providerUrl: probe.providerUrl,
        rendererUrl: target.url,
        state: "working",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await saveDesktopSession(this.root, record);
      return publicSession(record);
    } catch (error) {
      if (targetId) await closeDesktopTarget(this.endpoint, targetId).catch(() => undefined);
      throw error;
    } finally {
      session?.close();
    }
  }

  async resolveOwned(sessionId, suppliedSession) {
    await this.environment();
    let record = await loadDesktopSession(this.root, sessionId);
    if (suppliedSession) assertSessionEnvelope(record, suppliedSession);
    let target = (await listDesktopTargets(this.endpoint)).find((item) => item.id === record.targetId);
    if (!target) {
      if (!record.providerUrl) throw new Error(`Desktop session ${sessionId} lost its target before a provider conversation identity was established.`);
      const candidates = await listChatGptTargets(this.endpoint, this.selectors, { allowUnknownMode: this.allowUnknownMode });
      const exact = candidates.filter((item) => item.probe.providerUrl === record.providerUrl);
      if (exact.length !== 1) throw new Error(`Desktop session ${sessionId} cannot reattach exactly; ${exact.length} renderer(s) show ${record.providerUrl}.`);
      target = exact[0].target;
      record = { ...record, targetId: target.id, windowId: await browserWindowId(this.endpoint, target.id), rendererUrl: target.url, updatedAt: nowIso() };
    }
    const connected = await connectTarget(this.endpoint, target);
    try {
      const probe = await probeRenderer(connected, this.selectors);
      if (probe.mode !== "chatgpt" && !(this.allowUnknownMode && probe.mode === "unknown")) {
        throw new Error(`Owned desktop target drifted to ${probe.mode} mode.`);
      }
      if (record.providerUrl && probe.providerUrl && probe.providerUrl !== record.providerUrl) {
        throw new Error(`Owned desktop conversation drifted from ${record.providerUrl} to ${probe.providerUrl}.`);
      }
      if (!record.providerUrl && probe.providerUrl) record = { ...record, providerUrl: probe.providerUrl, updatedAt: nowIso() };
      const currentWindowId = await browserWindowId(this.endpoint, target.id).catch(() => undefined);
      if (record.windowId !== undefined && currentWindowId !== undefined && record.targetId === target.id && record.windowId !== currentWindowId) {
        throw new Error("Owned desktop target moved to a different native window.");
      }
      record = { ...record, targetId: target.id, windowId: currentWindowId ?? record.windowId, rendererUrl: target.url, updatedAt: nowIso() };
      await saveDesktopSession(this.root, record);
      return { record, target, session: connected, probe };
    } catch (error) {
      connected.close();
      throw error;
    }
  }

  async show({ sessionId }) {
    const owned = await this.resolveOwned(sessionId);
    owned.session.close();
    return publicSession(owned.record);
  }

  async navigate({ session, url }) {
    const desired = allowedProviderUrl(url);
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      const probe = desired === CHATGPT_ORIGIN
        ? await ensureNewChat(owned.session, this.selectors)
        : await navigateToConversation(owned.session, desired, this.selectors);
      const record = { ...owned.record, providerUrl: probe.providerUrl, updatedAt: nowIso() };
      await saveDesktopSession(this.root, record);
      return publicSession(record);
    } finally {
      owned.session.close();
    }
  }

  async upload({ session, files }) {
    if (!Array.isArray(files) || files.length === 0) return null;
    const verified = await assertRegularUploadFiles(files);
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      const before = await observeRenderer(owned.session, this.selectors);
      await owned.session.send("DOM.enable");
      const input = await owned.session.evaluate(`(() => { ${visibleNodeHelpers()}
        const selectors = ${JSON.stringify(this.selectors.fileInput)};
        return selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible) ?? null;
      })()`, { returnByValue: false });
      if (input?.objectId) {
        const node = await owned.session.send("DOM.requestNode", { objectId: input.objectId });
        await owned.session.send("DOM.setFileInputFiles", { files: verified, nodeId: node.nodeId });
      } else {
        await owned.session.send("Page.setInterceptFileChooserDialog", { enabled: true });
        const chooser = owned.session.waitFor("Page.fileChooserOpened", () => true, 10_000);
        const clicked = await clickFirst(owned.session, this.selectors.attach, "attach|upload|add photos|add files");
        if (!clicked) throw new Error("Desktop composer has no safe attachment control.");
        const event = await chooser;
        await owned.session.send("DOM.setFileInputFiles", { files: verified, backendNodeId: event.backendNodeId });
        await owned.session.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
      }
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await sleep(250);
        const after = await observeRenderer(owned.session, this.selectors);
        if (after.attachmentPreviewCount > before.attachmentPreviewCount) return null;
      }
      throw new Error("Desktop file selection produced no visible attachment preview; upload was not accepted.");
    } finally {
      owned.session.close();
    }
  }

  async fill({ session, prompt }) {
    if (typeof prompt !== "string" || !prompt) throw new Error("Desktop prompt is empty.");
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      await focusAndClearComposer(owned.session, this.selectors);
      await owned.session.send("Input.insertText", { text: prompt });
      const observed = await readComposerText(owned.session, this.selectors);
      if (normalizeText(observed) !== normalizeText(prompt)) throw new Error("Desktop composer text did not match the supplied prompt.");
      const record = {
        ...owned.record,
        pendingPromptSha256: sha256(normalizeText(prompt)),
        pendingPromptBytes: Buffer.byteLength(prompt, "utf8"),
        updatedAt: nowIso(),
      };
      await saveDesktopSession(this.root, record);
      return null;
    } finally {
      owned.session.close();
    }
  }

  async discoverModels({ session }) {
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      const current = await probeRenderer(owned.session, this.selectors);
      const opened = await clickFirst(owned.session, this.selectors.modelTrigger, "model|intelligence");
      if (!opened) throw new Error("Desktop composer model picker is unavailable.");
      await sleep(300);
      const options = await owned.session.evaluate(`(() => { ${visibleNodeHelpers()}
        return [...document.querySelectorAll('[role=menuitem], [role=option], [role=radio]')]
          .filter(visible).map(text).filter(Boolean).slice(0, 100);
      })()`);
      await owned.session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }).catch(() => undefined);
      const unique = [...new Set((options ?? []).map(normalizeText).filter(Boolean))];
      const effortNames = new Set(["auto", "instant", "thinking", "medium", "high", "extra high", "pro", "standard", "extended", "max"]);
      const efforts = unique.filter((label) => effortNames.has(normalizeLabel(label))).map((label) => ({ label }));
      const models = unique.filter((label) => !effortNames.has(normalizeLabel(label))).map((label) => ({ label }));
      if (models.length === 0 && efforts.length === 0) throw new Error("Desktop model picker exposed no readable options.");
      return {
        ...(current.currentModel ? { currentModel: current.currentModel } : {}),
        ...(current.currentEffort ? { currentEffort: current.currentEffort } : {}),
        models,
        efforts,
        discoveredAt: nowIso(),
      };
    } finally {
      owned.session.close();
    }
  }

  async discoverProjects({ session }) {
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      const names = await owned.session.evaluate(`(() => { ${visibleNodeHelpers()}
        const values = [];
        for (const node of document.querySelectorAll('a[href*="/g/"]')) {
          if (!visible(node)) continue;
          let url;
          try { url = new URL(node.href || node.getAttribute('href'), 'https://chatgpt.com'); } catch { continue; }
          if (!/^\\/g\\/[A-Za-z0-9_-]+\\/?$/.test(url.pathname)) continue;
          const value = text(node);
          if (value) values.push(value);
        }
        return [...new Set(values)].slice(0, 200);
      })()`);
      return { projects: (names ?? []).map((name) => ({ name })), discoveredAt: nowIso() };
    } finally {
      owned.session.close();
    }
  }

  async manageConversation() {
    throw new Error("The desktop-CDP preview does not mutate conversation organization. Use the Chrome driver for pin, rename, move, or archive.");
  }

  async selectModel({ session, model }) {
    const selection = requestedSelection(model);
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      if (selection.model) {
        const opened = await clickFirst(owned.session, this.selectors.modelTrigger, "model|intelligence");
        if (!opened) throw new Error("Desktop model picker is unavailable.");
        await sleep(250);
        await clickExactOption(owned.session, selection.model);
        await sleep(400);
      }
      if (selection.effort) {
        const opened = await clickFirst(owned.session, [], "effort|reasoning|thinking level|^(auto|instant|thinking|medium|high|extra high|pro)$");
        if (!opened) throw new Error("Desktop effort picker is unavailable.");
        await sleep(250);
        await clickExactOption(owned.session, selection.effort);
        await sleep(400);
      }
      const observed = await probeRenderer(owned.session, this.selectors);
      return modelVerification(selection, observed.currentModel, observed.currentEffort);
    } finally {
      owned.session.close();
    }
  }

  async verifyModel({ session, model }) {
    const selection = requestedSelection(model);
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      const observed = await probeRenderer(owned.session, this.selectors);
      return modelVerification(selection, observed.currentModel, observed.currentEffort);
    } finally {
      owned.session.close();
    }
  }

  async send({ session }) {
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      if (!owned.record.pendingPromptSha256) throw new Error("Desktop send has no verified pending composer hash.");
      if (owned.record.sendStartedAt) throw new Error("Desktop send already crossed its one-shot crash boundary.");
      const composer = await readComposerText(owned.session, this.selectors);
      if (sha256(normalizeText(composer)) !== owned.record.pendingPromptSha256) {
        throw new Error("Desktop composer changed after fill; send refused.");
      }
      const before = await currentCounts(owned.session, this.selectors);
      const submittedHash = owned.record.pendingPromptSha256;
      const record = { ...owned.record, lastSubmittedPromptSha256: submittedHash, sendStartedAt: nowIso(), updatedAt: nowIso() };
      delete record.pendingPromptSha256;
      delete record.pendingPromptBytes;
      await saveDesktopSession(this.root, record);
      const clicked = await clickFirst(owned.session, this.selectors.send, "^send (?:prompt|message)$");
      if (!clicked) {
        await owned.session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await owned.session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }
      const after = await waitForProviderOrUserTurn(owned.session, this.selectors, before);
      const finalRecord = { ...record, providerUrl: after?.providerUrl ?? record.providerUrl, updatedAt: nowIso() };
      await saveDesktopSession(this.root, finalRecord);
      return null;
    } finally {
      owned.session.close();
    }
  }

  async observe({ session }) {
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      const observed = await observeRenderer(owned.session, this.selectors);
      if (owned.record.providerUrl && observed.providerUrl && observed.providerUrl !== owned.record.providerUrl) {
        throw new Error(`Desktop conversation drifted from ${owned.record.providerUrl} to ${observed.providerUrl}.`);
      }
      if (!owned.record.providerUrl && observed.providerUrl) {
        await saveDesktopSession(this.root, { ...owned.record, providerUrl: observed.providerUrl, updatedAt: nowIso() });
      }
      return observed.observation;
    } finally {
      owned.session.close();
    }
  }

  async recover({ session, action }) {
    if (!["reload", "continue", "retry", "stop"].includes(action)) throw new Error(`Unknown desktop recovery action: ${action}`);
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      if (action === "reload") await owned.session.send("Page.reload", { ignoreCache: false });
      else {
        const pattern = action === "continue" ? "continue generating|continue response|^continue$" : action === "retry" ? "^retry" : "stop answering|stop generating|stop response|stop streaming";
        const clicked = await clickFirst(owned.session, [], pattern);
        if (!clicked) throw new Error(`Desktop renderer exposes no safe ${action} control.`);
      }
      return null;
    } finally {
      owned.session.close();
    }
  }

  async setState({ sessionId, state }) {
    if (!["working", "needs_user", "completed"].includes(state)) throw new Error(`Invalid desktop session state: ${state}`);
    const record = await loadDesktopSession(this.root, sessionId);
    await saveDesktopSession(this.root, { ...record, state, updatedAt: nowIso() });
    return null;
  }

  async close({ sessionId }) {
    const record = await loadDesktopSession(this.root, sessionId);
    const target = (await listDesktopTargets(this.endpoint)).find((item) => item.id === record.targetId);
    if (target) {
      const session = await connectTarget(this.endpoint, target);
      try {
        const probe = await probeRenderer(session, this.selectors);
        if (record.providerUrl && probe.providerUrl && record.providerUrl !== probe.providerUrl) {
          throw new Error("Desktop close refused a target showing a different conversation.");
        }
      } finally {
        session.close();
      }
      await closeDesktopTarget(this.endpoint, record.targetId);
    }
    await deleteDesktopSession(this.root, sessionId);
    return null;
  }

  async screenshot({ session, outputPath }) {
    if (typeof outputPath !== "string" || !outputPath) throw new Error("Desktop screenshot output path is missing.");
    const owned = await this.resolveOwned(session.sessionId, session);
    try {
      const result = await owned.session.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      if (typeof result.data !== "string") throw new Error("Desktop screenshot returned no PNG data.");
      return writeScreenshot(outputPath, result.data);
    } finally {
      owned.session.close();
    }
  }
}

export async function handleDriverRequest(request, driver = new DesktopCdpDriver()) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Desktop driver request must be an object.");
  if (request.version !== DESKTOP_DRIVER_PROTOCOL_VERSION) throw new Error(`Desktop driver requires protocol version ${DESKTOP_DRIVER_PROTOCOL_VERSION}.`);
  if (typeof request.action !== "string" || !request.action) throw new Error("Desktop driver action is missing.");
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params : {};
  switch (request.action) {
    case "probe": return driver.probe();
    case "create": return driver.create(params);
    case "show": return driver.show(params);
    case "navigate": return driver.navigate(params);
    case "upload": return driver.upload(params);
    case "fill": return driver.fill(params);
    case "discover_models": return driver.discoverModels(params);
    case "discover_projects": return driver.discoverProjects(params);
    case "manage_conversation": return driver.manageConversation(params);
    case "select_model": return driver.selectModel(params);
    case "verify_model": return driver.verifyModel(params);
    case "send": return driver.send(params);
    case "observe": return driver.observe(params);
    case "recover": return driver.recover(params);
    case "set_state": return driver.setState(params);
    case "close": return driver.close(params);
    case "screenshot": return driver.screenshot(params);
    default: throw new Error(`Unknown desktop driver action: ${request.action}`);
  }
}

export async function runDriverCli({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw new Error("Desktop driver request exceeded 16 MiB.");
    chunks.push(chunk);
  }
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
  } catch {
    const envelope = { version: DESKTOP_DRIVER_PROTOCOL_VERSION, ok: false, error: "Desktop driver received invalid JSON." };
    stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  try {
    const result = await handleDriverRequest(request);
    stdout.write(`${JSON.stringify({ version: DESKTOP_DRIVER_PROTOCOL_VERSION, ok: true, result })}\n`);
  } catch (error) {
    stdout.write(`${JSON.stringify({ version: DESKTOP_DRIVER_PROTOCOL_VERSION, ok: false, error: errorMessage(error) })}\n`);
  }
}

export async function readProtocolRequest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
