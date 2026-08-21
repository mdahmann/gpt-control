import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRoute } from "./src/capability";
import { parseCommandJson } from "./src/json";
import { operatorPolicyFromEnv, OFFICIAL_OPENAI_BASE_URL } from "./src/policy";
import { runCodexTurn, runResponsesTurn, type CodexFactory, type ProviderTurnResult } from "./src/providers";
import { GptControlService } from "./src/service";
import { RunStore } from "./src/store";
import { passiveTransportDiscovery, probeBridge, probeOracle, runPrivateBridgeRequest, type Launcher } from "./src/transport";
import type { AttachmentManifest } from "./src/domain";
import type { Exec } from "./src/types";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-transport-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const emptyManifest = (root: string): AttachmentManifest => ({
	workspaceRoot: root,
	files: [],
	totalBytes: 0,
	sha256: "0".repeat(64),
	snapshotRoot: join(root, "snapshot"),
	snapshotId: "snapshot-test",
});

describe("transport and operator authorization", () => {
	test("selection never expands authority or foregrounds an unavailable browser", () => {
		const launcher: Launcher = { command: "bridge", args: [], origin: "test" };
		expect(selectRoute({ bridge: { launcher, probe: { ready: true } }, codex: { origin: "test" } }).kind).toBe("chrome_bridge");
		expect(selectRoute({ codex: { origin: "test" } }, { transport: "codex" }).kind).toBe("codex");
		expect(() => selectRoute({ bridgeOffline: { launcher, probe: { ready: false, reason: "offline" } }, codex: { origin: "test" } })).toThrow("No foreground browser was launched");
		expect(() => selectRoute({ oracle: { launcher, version: "1" } }, { transport: "oracle_browser" })).toThrow("disabled");
	});

	test("pins the official OpenAI endpoint and ignores inherited OPENAI_BASE_URL", () => {
		const root = scratch();
		const policy = operatorPolicyFromEnv({ OPENAI_BASE_URL: "https://attacker.invalid/v1" }, {
			workspaceRoot: root,
			storageRoot: join(root, "state"),
			allowedTransports: ["responses"],
			maxConcurrentWorkers: 1,
		});
		expect(policy.openAIBaseUrl).toBe(OFFICIAL_OPENAI_BASE_URL);
		expect(() => operatorPolicyFromEnv({ GPT_CONTROL_OPENAI_BASE_URL: "https://proxy.invalid/v1" }, {
			workspaceRoot: root,
			storageRoot: join(root, "state2"),
			allowedTransports: ["responses"],
			maxConcurrentWorkers: 1,
		})).toThrow("Refused alternate OpenAI endpoint");
		const trusted = operatorPolicyFromEnv({ GPT_CONTROL_OPENAI_BASE_URL: "https://proxy.invalid/v1", GPT_CONTROL_ALLOW_ALTERNATE_OPENAI_ENDPOINT: "1" }, {
			workspaceRoot: root,
			storageRoot: join(root, "state3"),
			allowedTransports: ["responses"],
			maxConcurrentWorkers: 1,
		});
		expect(trusted.openAIBaseUrl).toBe("https://proxy.invalid/v1");
	});

	test("uses only a trusted provider default and ignores inherited response-model environment", async () => {
		const root = scratch();
		const store = new RunStore(join(root, "state"));
		const policy = operatorPolicyFromEnv({ GPT_CONTROL_PROVIDER_MODEL: "trusted-default" }, {
			workspaceRoot: root,
			storageRoot: store.root,
			snapshotRoot: join(store.root, "snapshots"),
			outputRoot: join(store.root, "generated"),
			allowedTransports: ["codex"],
			maxConcurrentWorkers: 1,
		});
		let observedModel: string | undefined;
		const service = new GptControlService(async () => ({ stdout: "", stderr: "", code: 0, killed: false }), store, policy, {
			resolveCapabilities: async () => ({ codex: { origin: "fake" } }),
			runCodexTurn: async (request) => {
				observedModel = request.model;
				return { provider: "codex", terminalStatus: "completed", text: "ok", providerConversationId: "thread-default" };
			},
		});
		expect((await service.start({ kind: "chat", prompt: "default", transport: "codex" })).run.status).toBe("completed");
		expect(observedModel).toBe("trusted-default");
		expect((await service.start({ kind: "chat", prompt: "explicit default", transport: "codex", providerModel: "trusted-default" })).run.status).toBe("completed");
	});

	test("ignores inherited GPT_CONTROL_RESPONSES_MODEL and uses the broker-pinned default", async () => {
		const root = scratch();
		const previous = process.env.GPT_CONTROL_RESPONSES_MODEL;
		process.env.GPT_CONTROL_RESPONSES_MODEL = "attacker-model";
		try {
			let body: Record<string, unknown> | undefined;
			await runResponsesTurn({ kind: "chat", prompt: "hello", manifest: emptyManifest(root) }, {
				responses: {
					create: async (value) => {
						body = value;
						return { id: "resp-default", model: "gpt-5.6", output_text: "answer", usage: {} };
					},
				},
			});
			expect(body?.model).toBe("gpt-5.6");
		} finally {
			if (previous === undefined) delete process.env.GPT_CONTROL_RESPONSES_MODEL;
			else process.env.GPT_CONTROL_RESPONSES_MODEL = previous;
		}
	});

	test("tool-selected provider models must already be trusted", async () => {
		const root = scratch();
		const store = new RunStore(join(root, "state"));
		const policy = operatorPolicyFromEnv({}, {
			workspaceRoot: root,
			storageRoot: store.root,
			snapshotRoot: join(store.root, "snapshots"),
			outputRoot: join(store.root, "generated"),
			allowedTransports: ["codex"],
			allowedProviderModels: ["trusted-model"],
			maxConcurrentWorkers: 1,
		});
		let providerCalls = 0;
		const service = new GptControlService(async () => ({ stdout: "", stderr: "", code: 0, killed: false }), store, policy, {
			resolveCapabilities: async () => ({ codex: { origin: "fake" } }),
			runCodexTurn: async () => {
				providerCalls += 1;
				return { provider: "codex", terminalStatus: "completed", text: "ok", providerConversationId: "thread-1" };
			},
		});
		await expect(service.start({ kind: "chat", prompt: "x", transport: "codex", providerModel: "untrusted" })).rejects.toThrow("not in trusted operator policy");
		expect(providerCalls).toBe(0);
		const result = await service.start({ kind: "chat", prompt: "x", transport: "codex", providerModel: "trusted-model" });
		expect(result.run.status).toBe("completed");
		expect(providerCalls).toBe(1);
	});
});

describe("provider isolation and truthful execution", () => {
	test("Codex receives only the immutable snapshot as its read-only working directory", async () => {
		const root = scratch();
		const manifest: AttachmentManifest = {
			...emptyManifest(root),
			files: [{ path: join(root, "snapshot", "a.ts"), relativePath: "a.ts", size: 4, sha256: "a".repeat(64), lineCount: 1 }],
			totalBytes: 4,
		};
		let options: Record<string, unknown> | undefined;
		let prompt = "";
		const factory: CodexFactory = {
			create: () => ({
				startThread: (value) => {
					options = value;
					return {
						id: "thread-1",
						run: async (input) => {
							prompt = input;
							return { items: [{ id: "message-1", type: "agent_message" }], finalResponse: "done", usage: {} };
						},
					};
				},
				resumeThread: () => { throw new Error("not used"); },
			}),
		};
		const result = await runCodexTurn({ kind: "chat", prompt: "review", manifest, model: "trusted" }, factory);
		expect(options).toMatchObject({
			workingDirectory: manifest.snapshotRoot,
			sandboxMode: "read-only",
			approvalPolicy: "never",
			skipGitRepoCheck: true,
			model: "trusted",
		});
		expect(options).not.toHaveProperty("additionalDirectories");
		expect(prompt).toContain("a.ts");
		expect(prompt).not.toContain(manifest.workspaceRoot);
		expect(result.modelVerified).toBe(false);
		expect(result.observedModel).toBeUndefined();
	});

	test("Responses uses the pinned endpoint and reports only the provider-observed model", async () => {
		const root = scratch();
		let body: Record<string, unknown> | undefined;
		const result = await runResponsesTurn({
			kind: "chat",
			prompt: "hello",
			manifest: emptyManifest(root),
			model: "requested",
			providerConversationId: "prev-1",
			providerEndpoint: OFFICIAL_OPENAI_BASE_URL,
		}, {
			responses: {
				create: async (value) => {
					body = value;
					return { id: "resp-1", model: "observed-model", output_text: "answer", usage: {} };
				},
			},
		});
		expect(body).toMatchObject({ model: "requested", previous_response_id: "prev-1", store: true });
		expect(result.observedModel).toBe("observed-model");
		expect(result.modelVerified).toBe(true);
		expect(result.providerEndpoint).toBe(OFFICIAL_OPENAI_BASE_URL);
	});

	test("requires fresh trusted paid confirmation for every request including follow-ups", async () => {
		const root = scratch();
		const store = new RunStore(join(root, "state"));
		const confirmations: Array<{ followup: boolean; runId: string }> = [];
		let providerCalls = 0;
		const policy = operatorPolicyFromEnv({}, {
			workspaceRoot: root,
			storageRoot: store.root,
			snapshotRoot: join(store.root, "snapshots"),
			outputRoot: join(store.root, "generated"),
			allowedTransports: ["responses"],
			allowedProviderModels: ["paid-model"],
			maxConcurrentWorkers: 1,
			confirmPaidRequest: async (context) => {
				confirmations.push({ followup: context.followup, runId: context.runId });
				return true;
			},
		});
		const fakeTurn = async (): Promise<ProviderTurnResult> => {
			providerCalls += 1;
			return {
				provider: "responses",
				terminalStatus: "completed",
				text: `answer-${providerCalls}`,
				providerConversationId: `resp-${providerCalls}`,
				providerRunId: `resp-${providerCalls}`,
				observedModel: "paid-model",
				modelVerified: true,
				modelEvidenceKind: "provider_response",
				providerEndpoint: OFFICIAL_OPENAI_BASE_URL,
			};
		};
		const service = new GptControlService(async () => ({ stdout: "", stderr: "", code: 0, killed: false }), store, policy, {
			resolveCapabilities: async () => ({ responses: { available: true } }),
			runResponsesTurn: fakeTurn,
		});
		const first = await service.start({ kind: "chat", prompt: "first", transport: "responses", providerModel: "paid-model" });
		const second = await service.start({ kind: "chat", prompt: "second", conversationId: first.conversation.id, providerModel: "paid-model" });
		expect(first.run.status).toBe("completed");
		expect(second.run.status).toBe("completed");
		expect(confirmations).toHaveLength(2);
		expect(confirmations.map((value) => value.followup)).toEqual([false, true]);
		expect(new Set(confirmations.map((value) => value.runId)).size).toBe(2);
		expect(providerCalls).toBe(2);
	});

	test("does not reuse a previous paid confirmation when the follow-up is denied", async () => {
		const root = scratch();
		const store = new RunStore(join(root, "state"));
		let confirmation = 0;
		let providerCalls = 0;
		const policy = operatorPolicyFromEnv({}, {
			workspaceRoot: root,
			storageRoot: store.root,
			snapshotRoot: join(store.root, "snapshots"),
			outputRoot: join(store.root, "generated"),
			allowedTransports: ["responses"],
			maxConcurrentWorkers: 1,
			confirmPaidRequest: async () => ++confirmation === 1,
		});
		const service = new GptControlService(async () => ({ stdout: "", stderr: "", code: 0, killed: false }), store, policy, {
			resolveCapabilities: async () => ({ responses: { available: true } }),
			runResponsesTurn: async () => {
				providerCalls += 1;
				return { provider: "responses", terminalStatus: "completed", text: "ok", providerConversationId: `r-${providerCalls}` };
			},
		});
		const first = await service.start({ kind: "chat", prompt: "first", transport: "responses" });
		const second = await service.start({ kind: "chat", prompt: "followup", conversationId: first.conversation.id });
		expect(second.run.status).toBe("failed");
		expect(second.run.error).toContain("Fresh trusted operator confirmation");
		expect(providerCalls).toBe(1);
	});
});

describe("child-process and diagnostic safety", () => {
	test("non-zero exits fail even when stdout contains successful-looking JSON", () => {
		expect(() => parseCommandJson({
			stdout: JSON.stringify({ success: true, result: { value: "looks good" } }),
			stderr: "real failure",
			code: 7,
			killed: false,
		}, "fake bridge")).toThrow("real failure");
	});

	test("Bridge and Oracle probes treat non-zero exits as failures", async () => {
		const launcher: Launcher = { command: "fake", args: [], origin: "test" };
		const exec: Exec = async () => ({
			stdout: JSON.stringify({ endpointStatus: "reachable", extension: "connected" }),
			stderr: "failed",
			code: 1,
			killed: false,
		});
		expect((await probeBridge(exec, launcher)).ready).toBe(false);
		expect(await probeOracle(exec, launcher)).toBeUndefined();
	});

	test("private Bridge RPC keeps prompt bodies and attachment paths out of argv and removes its request file", async () => {
		const seen: string[][] = [];
		let requestPath = "";
		const launcher: Launcher = {
			command: "bridge",
			args: [],
			origin: "test",
			privateRpc: {
				command: "python3",
				args: ["helper.py"],
				clientScript: "/private/client.py",
				origin: "private",
			},
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

	test("passive discovery and gpt_diagnose do not execute discovered programs", async () => {
		const root = scratch();
		let execCalls = 0;
		const exec: Exec = async () => {
			execCalls += 1;
			throw new Error("must not run");
		};
		const store = new RunStore(join(root, "state"));
		const policy = operatorPolicyFromEnv({}, {
			workspaceRoot: root,
			storageRoot: store.root,
			allowedTransports: ["codex"],
			maxConcurrentWorkers: 1,
		});
		const service = new GptControlService(exec, store, policy);
		const passive = passiveTransportDiscovery({ PATH: "", HOME: root });
		expect(passive).toMatchObject({ mode: "passive" });
		const diagnosis = await service.diagnose();
		expect(diagnosis).toMatchObject({ mode: "passive" });
		expect(execCalls).toBe(0);
		await expect(service.activeSmokeTest()).rejects.toThrow("disabled by trusted operator policy");
		expect(execCalls).toBe(0);
	});
});
