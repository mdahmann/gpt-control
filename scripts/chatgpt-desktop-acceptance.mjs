#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DesktopCdpDriver } from "../src/desktop-cdp-driver.mjs";
import { loadDesktopSession, sha256, stateRoot } from "../src/desktop-cdp-core.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { count: 2, confirm: false, send: false, keep: false, attachments: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm") options.confirm = true;
    else if (arg === "--send") options.send = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--count") options.count = Number(argv[++index]);
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--effort") options.effort = argv[++index];
    else if (arg === "--attach") options.attachments.push(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 10) throw new Error("--count must be between 1 and 10.");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000)) throw new Error("--timeout-ms must be at least 10000.");
  return options;
}

async function waitForStableReply(driver, session, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let fingerprint;
  let stable = 0;
  let latest;
  while (Date.now() < deadline) {
    await sleep(1_000);
    latest = await driver.observe({ session });
    if (latest.snapshot.count <= baseline || latest.answering || latest.thinking || latest.toolRunning || latest.errorMessage || latest.retryAvailable || latest.continueAvailable) {
      fingerprint = undefined;
      stable = 0;
      continue;
    }
    const current = sha256(`${latest.snapshot.text}\u0000${latest.snapshot.imageUrls.join(",")}`);
    if (current === fingerprint) stable += 1;
    else { fingerprint = current; stable = 0; }
    if (stable >= 2) return latest;
  }
  throw new Error(`Desktop acceptance timed out after ${timeoutMs} ms.`);
}

export async function runAcceptance(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    return {
      help: "Usage: node scripts/chatgpt-desktop-acceptance.mjs --confirm [--count 2] [--send] [--model LABEL] [--effort LABEL] [--attach PATH] [--keep].",
      warning: "This creates and normally closes ChatGPT desktop windows. --send also submits disposable prompts.",
    };
  }
  if (!options.confirm) throw new Error("Acceptance is mutating. Re-run with --confirm after closing sensitive desktop chats.");
  const driver = new DesktopCdpDriver(env);
  const probe = await driver.probe();
  if (!probe.ready) throw new Error(probe.reason ?? "Desktop driver is unavailable.");
  const sessions = [];
  const report = {
    startedAt: new Date().toISOString(),
    requestedCount: options.count,
    sendEnabled: options.send,
    sessions: [],
  };
  try {
    for (let index = 0; index < options.count; index += 1) {
      const session = await driver.create({ name: `gpt-control:desktop-acceptance:${index + 1}:${randomBytes(4).toString("hex")}`, url: "https://chatgpt.com" });
      sessions.push(session);
      const record = await loadDesktopSession(stateRoot(env), session.sessionId);
      report.sessions.push({ sessionId: session.sessionId, pageId: session.pageId, windowId: record.windowId });
    }
    const pageIds = new Set(report.sessions.map((item) => String(item.pageId)));
    const windowIds = new Set(report.sessions.map((item) => String(item.windowId)));
    if (pageIds.size !== sessions.length) throw new Error("Desktop acceptance did not receive distinct renderer targets.");
    if (env.GPT_CONTROL_DRIVER_ALLOW_SHARED_WINDOW !== "1" && windowIds.size !== sessions.length) {
      throw new Error("Desktop acceptance did not receive distinct native windows.");
    }
    if (options.send) {
      const token = `DESKTOP_CDP_PONG_${randomBytes(8).toString("hex")}`;
      const session = sessions[0];
      const restarted = new DesktopCdpDriver(env);
      const before = await restarted.observe({ session });
      if (options.attachments.length) await restarted.upload({ session, files: options.attachments });
      if (options.model || options.effort) {
        await restarted.selectModel({ session, model: { model: options.model, effort: options.effort } });
        await restarted.verifyModel({ session, model: { model: options.model, effort: options.effort } });
      }
      await restarted.fill({ session, prompt: `Reply with exactly: ${token}` });
      await restarted.send({ session });
      const reply = await waitForStableReply(restarted, await restarted.show({ sessionId: session.sessionId }), before.snapshot.count, options.timeoutMs ?? 600_000);
      report.firstTurn = {
        exact: reply.snapshot.text.trim() === token,
        resultSha256: sha256(reply.snapshot.text),
        assistantCount: reply.snapshot.count,
      };
      if (!report.firstTurn.exact) throw new Error("Desktop acceptance reply was not the exact disposable token.");
      const continued = await restarted.show({ sessionId: session.sessionId });
      const secondToken = `DESKTOP_CDP_CONTINUE_${randomBytes(8).toString("hex")}`;
      const secondBefore = await restarted.observe({ session: continued });
      await restarted.fill({ session: continued, prompt: `Reply with exactly: ${secondToken}` });
      await restarted.send({ session: continued });
      const secondReply = await waitForStableReply(new DesktopCdpDriver(env), await restarted.show({ sessionId: session.sessionId }), secondBefore.snapshot.count, options.timeoutMs ?? 600_000);
      report.continuation = {
        exact: secondReply.snapshot.text.trim() === secondToken,
        resultSha256: sha256(secondReply.snapshot.text),
        assistantCount: secondReply.snapshot.count,
      };
      if (!report.continuation.exact) throw new Error("Desktop exact-conversation continuation failed.");
    }
    report.completedAt = new Date().toISOString();
    report.passed = true;
    return report;
  } finally {
    if (!options.keep) {
      for (const session of sessions.reverse()) {
        await new DesktopCdpDriver(env).close({ sessionId: session.sessionId }).catch(() => undefined);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAcceptance().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
