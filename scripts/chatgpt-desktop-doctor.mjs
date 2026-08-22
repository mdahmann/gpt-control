#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CDP_ENDPOINT,
  browserWindowId,
  discoverChatGptApp,
  listChatGptTargets,
  loadSelectorConfig,
  parseLoopbackEndpoint,
  verifyCdpPortOwnership,
} from "../src/desktop-cdp-core.mjs";

export async function runDoctor(env = process.env) {
  const endpoint = parseLoopbackEndpoint(env.GPT_CONTROL_DRIVER_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT);
  const app = await discoverChatGptApp(env);
  const ownership = await verifyCdpPortOwnership(endpoint, app);
  if (!ownership.ok) {
    return {
      ready: false,
      mutated: false,
      app: { bundleId: app.bundleId, version: app.version, bundle: app.bundle },
      endpoint: endpoint.origin,
      reason: ownership.reason,
    };
  }
  const selectors = loadSelectorConfig(env);
  const targets = await listChatGptTargets(endpoint, selectors, { allowUnknownMode: env.GPT_CONTROL_DRIVER_ALLOW_UNKNOWN_MODE === "1" });
  const windows = [];
  for (const item of targets) {
    const windowId = await browserWindowId(endpoint, item.target.id).catch(() => undefined);
    if (windowId !== undefined) windows.push(windowId);
  }
  return {
    ready: targets.length > 0,
    mutated: false,
    app: { bundleId: app.bundleId, version: app.version, bundle: app.bundle },
    endpoint: endpoint.origin,
    listenerPids: ownership.pids,
    chatRendererCount: targets.length,
    distinctWindowCount: new Set(windows).size,
    modes: [...new Set(targets.map((item) => item.probe.mode))],
    limitations: [
      "This is unsupported Electron UI automation, not an OpenAI API.",
      "The doctor never launches, restarts, focuses, types into, or closes ChatGPT.",
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
