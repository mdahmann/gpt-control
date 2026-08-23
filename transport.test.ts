import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_DRIVER_PROTOCOL_VERSION, ExternalCommandBrowserDriver, type WebChatDriver } from "./src/browser-driver";
import { selectRoute, type Capabilities } from "./src/capability";
import { GptControlService } from "./src/service";
import { operatorPolicyFromEnv } from "./src/policy";
import { RunStore } from "./src/store";
import { passiveTransportDiscovery, parseCommandJson, probeBridge, runPrivateBridgeRequest, type Launcher } from "./src/transport";
import type { Exec } from "./src/types";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-driver-v2-test-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const session = { sessionId: "s", pageId: "p", name: "gpt-control:chat:x", url: "https://chatgpt.com/c/exact" };
const readyProbe = {
	ready: true as const,
	driver: "test-driver/v2",
	secureInput: true,
	protocolVersion: BROWSER_DRIVER_PROTOCOL_VERSION,
} as const;
const driver: WebChatDriver = {
	id: readyProbe.driver,
	probe: async () => readyProbe,
	create: async (name, url) => ({ ...session, name, url }),
	show: async () => session,
	navigate: async (_session, url) => ({ ...session, url }),
	upload: async () => undefined,
	fill: async () => undefined,
	discoverModels: async () => ({ currentModel: "GPT-5.6 Sol", currentEffort: "Pro", models: [{ label: "GPT-5.6 Sol" }], efforts: [{ label: "Pro" }], discoveredAt: new Date().toISOString() }),
	discoverProjects: async () => ({ projects: [], discoveredAt: new Date().toISOString() }),
	manageConversation: async () => ({ verifiedAt: new Date().toISOString() }),
	selectModel: async () => ({ requestedModel: "Pro", observedModel: "Pro", modelVerified: true, modelEvidenceKind: "composer_selector", modelVerifiedAt: new Date().toISOString() }),
	verifyModel: async () => ({ requestedModel: "Pro", observedModel: "Pro", modelVerified: true, modelEvidenceKind: "composer_selector", modelVerifiedAt: new Date().toISOString() }),
	send: async () => undefined,
	observe: async () => ({ snapshot: { count: 1, text: "ok", imageUrls: [], hasMarkdown: true }, composerReady: true, answering: false, thinking: false, toolRunning: false, visibleToolCards: [], retryAvailable: false, continueAvailable: false, stateSummary: "idle" }),
	recover: async () => undefined,
	setState: async () => undefined,
	close: async () => undefined,
	screenshot: async () => undefined,
};

describe("secure browser routing", () => {
	test("uses only a ready secure protocol-v2 driver", () => {
		const capabilities: Capabilities = { browser: { driver, probe: readyProbe, source: "test" } };
		expect(selectRoute(capabilities)).toEqual({ kind: "browser", driver });
		expect(() => selectRoute(capabilities, { transport: "oracle_browser" })).toThrow("disabled");
	});

	test("does not fall back when the configured driver is unavailable", () => {
		const capabilities: Capabilities = {
			browserOffline: {
				probe: { ready: false, driver: "custom", secureInput: false, protocolVersion: BROWSER_DRIVER_PROTOCOL_VERSION, reason: "leased" },
				source: "env",
			},
		};
		expect(() => selectRoute(capabilities)).toThrow("No fallback");
	});
});

describe("external browser-driver protocol v2", () => {
	test("splits fill/send and carries secrets only on stdin", async () => {
		const root = scratch();
		const script = join(root, "driver.js");
		const log = join(root, "actions.jsonl");
		writeFileSync(script, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  appendFileSync(process.env.GPT_CONTROL_DRIVER_LOG, JSON.stringify({ argv: process.argv.slice(2), action: request.action, params: request.params }) + "\\n");
  const base = { sessionId: "s1", pageId: "p1", name: "gpt-control:chat:x", url: "https://chatgpt.com/c/exact" };
  let result = {};
  if (request.action === "probe") result = {
    ready: true, driver: "fixture/v2", secureInput: true, protocolVersion: 2,
    driverVersion: "0.5.0-alpha.4", stateWriterVersion: 2,
    host: { appPath: "/Applications/ChatGPT.app", bundleId: "com.openai.codex", teamId: "2DC432GLL2", listenerPid: 123, endpoint: "http://127.0.0.1:9236", browserVersion: "Chrome/151", browserInstanceId: "/devtools/browser/12345678" },
    runtimeExecutable: "/usr/bin/node", runtimeBundlePath: "/plugin/dist/driver.js", runtimeBundleSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  else if (request.action === "create") result = { ...base, name: request.params.name, url: request.params.url, desktopPoolLane: 1 };
  else if (request.action === "show") result = base;
  else if (request.action === "navigate") result = { ...base, url: request.params.url };
  else if (request.action === "select_model" || request.action === "verify_model") result = { requestedModel: "Pro", observedModel: "Pro", modelVerified: true, modelEvidenceKind: "composer_selector", modelVerifiedAt: "2026-08-21T00:00:00.000Z" };
  else if (request.action === "observe") result = { snapshot: { count: 1, text: "answer", imageUrls: [], hasMarkdown: true, messageId: "m1" }, latestUserMessageId: "u1", latestUserPromptSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", latestUserPromptProofToken: "proof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", composerReady: true, answering: false, thinking: false, toolRunning: false, retryAvailable: false, continueAvailable: false, stateSummary: "idle" };
  else if (request.action === "screenshot") result = request.params.outputPath;
  console.log(JSON.stringify({ version: 2, ok: true, result }));
});
`);
		chmodSync(script, 0o755);
		const previous = process.env.GPT_CONTROL_DRIVER_LOG;
		process.env.GPT_CONTROL_DRIVER_LOG = log;
		try {
			const external = new ExternalCommandBrowserDriver(script);
			expect(await external.probe()).toMatchObject({ ready: true, driver: "fixture/v2", driverVersion: "0.5.0-alpha.4", stateWriterVersion: 2, runtimeBundleSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
			const created = await external.create("gpt-control:chat:x", "https://chatgpt.com");
			expect(created.desktopPoolLane).toBe(1);
			await external.upload(created, ["/private/snapshot/a.ts"]);
			await external.fill(created, "secret prompt carried only on stdin");
			expect((await external.selectModel(created, "pro")).observedModel).toBe("Pro");
			expect((await external.verifyModel(created, "pro")).modelVerified).toBe(true);
			await external.send(created);
			const observation = await external.observe(created);
			expect(observation.snapshot.text).toBe("answer");
			expect(observation.latestUserMessageId).toBe("u1");
			expect(observation.latestUserPromptProofToken).toBe("proof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
			await external.recover(created, "reload");
			await external.setState("s1", "completed");
			expect(await external.screenshot(created, "/tmp/out.png")).toBe("/tmp/out.png");
			await external.close("s1");
			const entries = (await Bun.file(log).text()).trim().split("\n").map((line) => JSON.parse(line));
			expect(entries.map((entry) => entry.action)).toContain("fill");
			expect(entries.map((entry) => entry.action)).toContain("send");
			expect(entries.flatMap((entry) => entry.argv).join(" ")).not.toContain("secret prompt");
			expect(entries.find((entry) => entry.action === "fill").params.prompt).toBe("secret prompt carried only on stdin");
		} finally {
			if (previous === undefined) delete process.env.GPT_CONTROL_DRIVER_LOG;
			else process.env.GPT_CONTROL_DRIVER_LOG = previous;
		}
	});

	test("cleans a successful external create when its pool lane receipt is invalid", async () => {
		const root = scratch();
		const script = join(root, "invalid-lane.js");
		const log = join(root, "actions.jsonl");
		writeFileSync(script, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  appendFileSync(process.env.GPT_CONTROL_DRIVER_LOG, request.action + "\\n");
  const result = request.action === "create"
    ? { sessionId: "leaked-unless-closed", pageId: "p1", name: request.params.name, url: request.params.url, desktopPoolLane: 11 }
    : {};
  console.log(JSON.stringify({ version: 2, ok: true, result }));
});
`);
		chmodSync(script, 0o755);
		const previous = process.env.GPT_CONTROL_DRIVER_LOG;
		process.env.GPT_CONTROL_DRIVER_LOG = log;
		try {
			await expect(new ExternalCommandBrowserDriver(script).create("gpt-control:chat:x", "https://chatgpt.com")).rejects.toThrow();
			expect((await Bun.file(log).text()).trim().split("\n")).toEqual(["create", "close"]);
		} finally {
			if (previous === undefined) delete process.env.GPT_CONTROL_DRIVER_LOG;
			else process.env.GPT_CONTROL_DRIVER_LOG = previous;
		}
	});

	test("fails closed without secure-stdin attestation", async () => {
		const script = join(scratch(), "insecure.js");
		writeFileSync(script, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ version: 2, ok: true, result: { ready: true, driver: "insecure", secureInput: false, protocolVersion: 2 } }));\n`);
		chmodSync(script, 0o755);
		expect(await new ExternalCommandBrowserDriver(script).probe()).toMatchObject({ ready: false, secureInput: false });
	});

	test("rejects failed and wrong-version envelopes", async () => {
		const root = scratch();
		const failed = join(root, "failed.js");
		writeFileSync(failed, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ version: 2, ok: false, error: "driver refused" }));\n`);
		chmodSync(failed, 0o755);
		await expect(new ExternalCommandBrowserDriver(failed).probe()).rejects.toThrow("driver refused");
		const old = join(root, "old.js");
		writeFileSync(old, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ version: 1, ok: true, result: {} }));\n`);
		chmodSync(old, 0o755);
		await expect(new ExternalCommandBrowserDriver(old).probe()).rejects.toThrow();
	});
});

describe("child-process and diagnosis safety", () => {
	test("non-zero exits fail despite success-looking stdout", () => {
		expect(() => parseCommandJson({ stdout: JSON.stringify({ success: true }), stderr: "real failure", code: 7, killed: false }, "fake")).toThrow("real failure");
	});

	test("structured bridge errors outrank generic process-wrapper stderr", () => {
		expect(() => parseCommandJson({
			stdout: JSON.stringify({ success: false, error: "expectedTarget exact URL changed before the browser action" }),
			stderr: "Command failed: private bridge helper",
			code: 1,
			killed: false,
		}, "fake")).toThrow("expectedTarget exact URL changed before the browser action");
	});

	test("private Chrome Bridge RPC keeps prompt and snapshot paths out of argv and removes its request", async () => {
		const seen: string[][] = [];
		let requestPath = "";
		const launcher: Launcher = {
			command: "bridge", args: [], origin: "test",
			privateRpc: { command: "python3", args: ["helper.py"], clientScript: "/private/client.py", origin: "private" },
		};
		const exec: Exec = async (_command, args) => {
			seen.push([...args]);
			requestPath = args.at(-1)!;
			const request = JSON.parse(await Bun.file(requestPath).text()) as { payload: Record<string, unknown> };
			expect(request.payload).toMatchObject({ text: "top secret prompt", files: ["/private/snapshot/secret.txt"] });
			return { stdout: JSON.stringify({ success: true, result: { success: true } }), stderr: "", code: 0, killed: false };
		};
		await runPrivateBridgeRequest(exec, launcher, "fill", { text: "top secret prompt", files: ["/private/snapshot/secret.txt"] });
		expect(seen.flat().join(" ")).not.toContain("top secret prompt");
		expect(seen.flat().join(" ")).not.toContain("secret.txt");
		expect(await Bun.file(requestPath).exists()).toBe(false);
	});

	test("passive discovery and diagnosis execute no discovered program", async () => {
		const root = scratch();
		let calls = 0;
		const exec: Exec = async () => { calls += 1; throw new Error("must not run"); };
		const store = new RunStore(join(root, "state"));
		const policy = operatorPolicyFromEnv({}, { workspaceRoot: root, storageRoot: store.root, allowedTransports: ["browser"], maxConcurrentWorkers: 1 });
		const service = new GptControlService(exec, store, policy);
		expect(passiveTransportDiscovery({ PATH: "", HOME: root })).toMatchObject({ mode: "passive" });
		expect(await service.diagnose()).toMatchObject({ mode: "passive" });
		expect(calls).toBe(0);
		await expect(service.activeSmokeTest()).rejects.toThrow("disabled");
		expect(calls).toBe(0);
	});

	test("Bridge probe treats non-zero exit as unavailable", async () => {
		const launcher: Launcher = { command: "fake", args: [], origin: "test" };
		const exec: Exec = async () => ({ stdout: JSON.stringify({ endpointStatus: "reachable", extension: "connected" }), stderr: "failed", code: 1, killed: false });
		expect((await probeBridge(exec, launcher)).ready).toBe(false);
	});
});
