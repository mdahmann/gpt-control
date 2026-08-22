import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import gptControl, { resolveOutputDir } from "./src/index";
import { codexCallbackOptionsFromEnv, createMcpServer } from "./src/mcp";
import { operatorPolicyFromEnv } from "./src/policy";
import { secureDirectory } from "./src/store";
import { DurableTaskStore } from "./src/task_store";
import type { ExtensionAPI, SchemaNode, ToolDefinition, TypeBuilder } from "./src/types";
import { FakeChromeBridge, makeChromeService, TEST_OPERATOR_ABANDON_TOKEN } from "./test_helpers";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-contract-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const Type: TypeBuilder = {
	Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
	Array: (item, options = {}) => ({ type: "array", items: item, ...options }),
	String: (options = {}) => ({ type: "string", ...options }),
	Number: (options = {}) => ({ type: "number", ...options }),
	Integer: (options = {}) => ({ type: "integer", ...options }),
	Boolean: (options = {}) => ({ type: "boolean", ...options }),
	Literal: (value) => ({ const: value }),
	Union: (nodes) => ({ anyOf: nodes }),
	Optional: (node) => ({ ...node, optional: true }),
};

describe("public extension contract", () => {
	test("defaults to six workers and permits an operator ceiling through ten", () => {
		const root = scratch();
		const common = { workspaceRoot: root, storageRoot: join(root, "state") };
		expect(operatorPolicyFromEnv({}, common).maxConcurrentWorkers).toBe(6);
		expect(operatorPolicyFromEnv({ GPT_CONTROL_MAX_WORKERS: "8" }, common).maxConcurrentWorkers).toBe(8);
		expect(operatorPolicyFromEnv({ GPT_CONTROL_MAX_WORKERS: "7", GPT_CONTROL_MAX_PRO_WORKERS: "4" }, common).maxConcurrentWorkers).toBe(7);
		expect(operatorPolicyFromEnv({ GPT_CONTROL_MAX_PRO_WORKERS: "6" }, common).maxConcurrentWorkers).toBe(6);
		expect(operatorPolicyFromEnv({ GPT_CONTROL_MAX_PRO_WORKERS: "10" }, common).maxConcurrentWorkers).toBe(10);
		expect(() => operatorPolicyFromEnv({ GPT_CONTROL_MAX_PRO_WORKERS: "11" }, common)).toThrow("maxConcurrentWorkers");
		expect(() => operatorPolicyFromEnv({ GPT_CONTROL_MAX_WORKERS: "11" }, common)).toThrow("maxConcurrentWorkers");
	});

	test("operator abandonment token rotation does not change execution policy identity", () => {
		const root = scratch();
		const common = { workspaceRoot: root, storageRoot: join(root, "state") };
		const first = operatorPolicyFromEnv({}, { ...common, providerTurnAbandonmentToken: "first-operator-token-000000000000000" });
		const second = operatorPolicyFromEnv({}, { ...common, providerTurnAbandonmentToken: "second-operator-token-00000000000000" });
		expect(first.fingerprint).toBe(second.fingerprint);
		expect(first.providerTurnAbandonmentTokenHash).not.toBe(second.providerTurnAbandonmentTokenHash);
	});

	test("registers image, bounded GPT Worker, durable recovery, and split diagnostics", () => {
		const tools: ToolDefinition[] = [];
		let label = "";
		const api: ExtensionAPI = {
			typebox: { Type },
			zod: {},
			setLabel: (value) => { label = value; },
			registerTool: (tool) => tools.push(tool),
		};
		gptControl(api);
		expect(label).toBe("GPT-Control");
		const names = tools.map((tool) => tool.name);
		for (const expected of [
			"gpt_consult", "gpt_chat", "gpt_image", "gpt_models", "gpt_projects", "gpt_worker_run", "gpt_worker_get", "gpt_worker_cancel", "gpt_worker_list",
			"gpt_run", "gpt_run_cancel", "gpt_run_abandon_pending", "gpt_conversation_attach", "gpt_conversation_close", "gpt_diagnose", "gpt_diagnose_active",
			"gpt_conversation_manage",
		]) expect(names).toContain(expected);
		expect(tools.find((tool) => tool.name === "gpt_diagnose")?.approval).toBe("read");
		expect(tools.find((tool) => tool.name === "gpt_diagnose_active")?.approval).toBe("exec");
	});

	test("model input cannot widen workspace, sensitive-file, paid, focus, endpoint, or output authority", () => {
		const tools: ToolDefinition[] = [];
		gptControl({ typebox: { Type }, registerTool: (tool) => tools.push(tool) });
		const forbidden = ["workspace_root", "allow_outside_workspace", "allow_sensitive_files", "api_confirmed", "allow_focus_steal", "openai_base_url", "allow_external_output"];
		for (const tool of tools) {
			const properties = ((tool.parameters as { properties?: Record<string, SchemaNode> }).properties ?? {});
			for (const field of forbidden) expect(properties).not.toHaveProperty(field);
		}
		const subagent = tools.find((tool) => tool.name === "gpt_worker_run")!;
		const subagentProperties = (subagent.parameters as { properties: Record<string, SchemaNode> }).properties;
		expect(subagentProperties).toHaveProperty("idempotency_key");
		expect(subagentProperties).toHaveProperty("chatgpt_model");
		expect(subagentProperties).toHaveProperty("chatgpt_effort");
		expect(subagentProperties).toHaveProperty("connectors");
		expect(subagentProperties).toHaveProperty("connector_mode");
		expect(subagentProperties).not.toHaveProperty("conversation_id");
		expect(subagentProperties).not.toHaveProperty("transport");
	});

	test("confines image output to the trusted root and refuses symlink components", async () => {
		const root = scratch();
		expect(resolveOutputDir("images", undefined, root)).toBe(join(root, "images"));
		expect(() => resolveOutputDir("../escape", undefined, root)).toThrow("outside trusted output root");
		expect(() => resolveOutputDir("/tmp/external", undefined, root)).toThrow("outside trusted output root");
		mkdirSync(join(root, "safe"));
		const outside = scratch();
		symlinkSync(outside, join(root, "safe", "linked"), "dir");
		await expect(secureDirectory(join(root, "safe", "linked", "child"))).rejects.toThrow("symlink");
	});
});

describe("MCP plugin contract", () => {
	test("derives the parent callback only from trusted Codex runtime state", () => {
		const root = scratch();
		const codex = join(root, "codex");
		writeFileSync(codex, "#!/bin/sh\nexit 0\n");
		chmodSync(codex, 0o700);
		const exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
		const callback = codexCallbackOptionsFromEnv({
			CODEX_THREAD_ID: "019c8f58-41ac-72b0-a9f6-43653b3ea80c",
			PATH: root,
		}, exec);
		expect(callback).toMatchObject({
			threadId: "019c8f58-41ac-72b0-a9f6-43653b3ea80c",
			command: codex,
		});
	});

	test("advertises optional task execution and omits authority-expanding schemas", async () => {
		const pluginMcp = JSON.parse(readFileSync(join(import.meta.dir, ".mcp.json"), "utf8")) as {
			mcpServers: { gpt_control: { command: string; args: string[]; env_vars: string[] } };
		};
		expect(pluginMcp.mcpServers.gpt_control.command).toBe("node");
		expect(pluginMcp.mcpServers.gpt_control.args).toEqual(["./dist/gpt-control-mcp.js"]);
		expect(pluginMcp.mcpServers.gpt_control.env_vars).toContain("GPT_CONTROL_PROVIDER_ABANDON_TOKEN");
		expect(pluginMcp.mcpServers.gpt_control.env_vars).toContain("GPT_CONTROL_MAX_WORKERS");
		expect(pluginMcp.mcpServers.gpt_control.env_vars).toContain("CODEX_THREAD_ID");
		const root = scratch();
		const { service } = makeChromeService(join(root, "state"), join(root, "workspace"), new FakeChromeBridge());
		mkdirSync(join(root, "workspace"), { recursive: true });
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
		const server = createMcpServer({ service, taskStore, recover: false });
		const client = new Client({ name: "contract-test", version: "1" }, {
			capabilities: { tasks: { requests: { tools: { call: {} } } } },
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			const listed = await client.listTools();
			const subagent = listed.tools.find((tool) => tool.name === "gpt_worker_run");
			expect(subagent?.execution?.taskSupport).toBe("optional");
			expect(subagent?.inputSchema.required).toContain("idempotency_key");
			expect(subagent?.inputSchema.properties).toHaveProperty("chatgpt_model");
			expect(subagent?.inputSchema.properties).toHaveProperty("chatgpt_effort");
			expect(subagent?.inputSchema.properties).toHaveProperty("connectors");
			expect(subagent?.inputSchema.properties).toHaveProperty("connector_mode");
			const properties = subagent?.inputSchema.properties ?? {};
			for (const field of ["workspace_root", "allow_sensitive_files", "api_confirmed", "allow_focus_steal", "conversation_id", "transport", "parent_thread_id"]) {
				expect(properties).not.toHaveProperty(field);
			}
			expect(listed.tools.map((tool) => tool.name)).toContain("gpt_image");
			expect(listed.tools.map((tool) => tool.name)).toContain("gpt_models");
			expect(listed.tools.map((tool) => tool.name)).toContain("gpt_projects");
			expect(listed.tools.map((tool) => tool.name)).toContain("gpt_conversation_manage");
			expect(listed.tools.map((tool) => tool.name)).toContain("gpt_run_abandon_pending");
			expect(listed.tools.map((tool) => tool.name)).toContain("gpt_run_claim");
		} finally {
			await client.close();
			await server.close();
		}
	});

	test("confines ordinary runs and conversations to their durable MCP session", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const { service } = makeChromeService(join(root, "state"), workspace, new FakeChromeBridge());
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
		const serverA = createMcpServer({ service, taskStore, recover: false });
		const serverB = createMcpServer({ service, taskStore, recover: false });
		const serverFallback = createMcpServer({ service, taskStore, recover: false, taskSupport: false });
		const clientA = new Client({ name: "session-a", version: "1" }, {});
		const clientB = new Client({ name: "session-b", version: "1" }, {});
		const clientFallback = new Client({ name: "fallback-session", version: "1" }, {});
		const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
		const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
		const [clientTransportFallback, serverTransportFallback] = InMemoryTransport.createLinkedPair();
		serverTransportA.sessionId = "mcp-session-a";
		serverTransportB.sessionId = "mcp-session-b";
		serverTransportFallback.sessionId = "mcp-session-fallback";
		await Promise.all([
			serverA.connect(serverTransportA), clientA.connect(clientTransportA),
			serverB.connect(serverTransportB), clientB.connect(clientTransportB),
			serverFallback.connect(serverTransportFallback), clientFallback.connect(clientTransportFallback),
		]);
		try {
			const started = await clientA.callTool({
				name: "gpt_chat",
				arguments: { prompt: "session-owned ordinary run", idempotency_key: "ordinary-session-owner", wait: false, timeout_ms: 1000 },
			});
			const content = started.structuredContent as { conversationId: string; run: { runId: string } };
			const runId = content.run.runId;
			const conversationId = content.conversationId;
			expect((await service.store.getConversation(conversationId)).mcpSessionId).toBe("mcp-session-a");

			const ownerRead = await clientA.callTool({ name: "gpt_run", arguments: { action: "status", run_id: runId } });
			expect((ownerRead.structuredContent as { runId?: string } | undefined)?.runId).toBe(runId);
			const foreignRead = await clientB.callTool({ name: "gpt_run", arguments: { action: "status", run_id: runId } });
			expect(foreignRead.isError).toBe(true);
			const foreignCancel = await clientB.callTool({ name: "gpt_run_cancel", arguments: { run_id: runId } });
			expect(foreignCancel.isError).toBe(true);
			const foreignFollowUp = await clientB.callTool({
				name: "gpt_chat",
				arguments: { prompt: "must not continue foreign conversation", conversation_id: conversationId, wait: false },
			});
			expect(foreignFollowUp.isError).toBe(true);
			const independentIdempotentStart = await clientB.callTool({
				name: "gpt_chat",
				arguments: { prompt: "session-b owns the same key text", idempotency_key: "ordinary-session-owner", wait: false, timeout_ms: 1000 },
			});
			const sessionBConversationId = (independentIdempotentStart.structuredContent as { conversationId?: string } | undefined)?.conversationId;
			expect(sessionBConversationId).toMatch(/^conv_/);
			expect((await service.store.getConversation(sessionBConversationId!)).mcpSessionId).toBe("mcp-session-b");

			const legacy = await service.start({
				kind: "subagent",
				prompt: "legacy task-owned run",
				idempotencyKey: "legacy-task-owner",
				wait: false,
			}, { deferExecution: true });
			const legacyTask = await taskStore.createTask(
				{ ttl: 60_000 },
				2,
				{ method: "tools/call", params: { name: "gpt_worker_run", arguments: {} } } as never,
				"mcp-session-a",
			);
			await taskStore.bindRun(legacyTask.taskId, legacy.run.id);
			const legacyOwnerRead = await clientA.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacy.run.id } });
			expect(legacyOwnerRead.isError).not.toBe(true);
			const legacyForeignRead = await clientB.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacy.run.id } });
			expect(legacyForeignRead.isError).toBe(true);
			const transferredTaskRun = await clientB.callTool({
				name: "gpt_run_claim",
				arguments: { run_id: legacy.run.id, confirmation: `CLAIM ${legacy.run.id}`, operator_token: TEST_OPERATOR_ABANDON_TOKEN },
			});
			expect(transferredTaskRun.isError).not.toBe(true);
			expect(await taskStore.getTask(legacyTask.taskId, "mcp-session-a")).toBeNull();
			expect((await taskStore.getTask(legacyTask.taskId, "mcp-session-b"))?.taskId).toBe(legacyTask.taskId);
			expect((await clientA.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacy.run.id } })).isError).toBe(true);
			expect((await clientB.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacy.run.id } })).isError).not.toBe(true);

			const legacyOrdinary = await service.start({ kind: "chat", prompt: "legacy ordinary run", wait: false, timeoutMs: 1000 });
			expect((await clientA.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacyOrdinary.run.id } })).isError).toBe(true);
			const wrongClaim = await clientA.callTool({
				name: "gpt_run_claim",
				arguments: { run_id: legacyOrdinary.run.id, confirmation: `CLAIM ${legacyOrdinary.run.id}`, operator_token: "wrong-operator-token-000000000000000000" },
			});
			expect(wrongClaim.isError).toBe(true);
			const claimed = await clientA.callTool({
				name: "gpt_run_claim",
				arguments: { run_id: legacyOrdinary.run.id, confirmation: `CLAIM ${legacyOrdinary.run.id}`, operator_token: TEST_OPERATOR_ABANDON_TOKEN },
			});
			expect(claimed.isError).not.toBe(true);
			expect((await service.store.getConversation(legacyOrdinary.conversation.id)).mcpSessionId).toBe("mcp-session-a");
			const claimedOwnerRead = await clientA.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacyOrdinary.run.id } });
			expect((claimedOwnerRead.structuredContent as { runId?: string } | undefined)?.runId).toBe(legacyOrdinary.run.id);
			expect((await clientB.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacyOrdinary.run.id } })).isError).toBe(true);
			const transferredOrdinary = await clientB.callTool({
				name: "gpt_run_claim",
				arguments: { run_id: legacyOrdinary.run.id, confirmation: `CLAIM ${legacyOrdinary.run.id}`, operator_token: TEST_OPERATOR_ABANDON_TOKEN },
			});
			expect(transferredOrdinary.isError).not.toBe(true);
			expect((await service.store.getConversation(legacyOrdinary.conversation.id)).mcpSessionId).toBe("mcp-session-b");
			expect((await clientA.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacyOrdinary.run.id } })).isError).toBe(true);
			const transferredOwnerRead = await clientB.callTool({ name: "gpt_run", arguments: { action: "status", run_id: legacyOrdinary.run.id } });
			expect((transferredOwnerRead.structuredContent as { runId?: string } | undefined)?.runId).toBe(legacyOrdinary.run.id);

			const fallbackStarted = await clientFallback.callTool({
				name: "gpt_worker_run",
				arguments: { prompt: "taskless fallback owner", idempotency_key: "taskless-fallback-owner", timeout_ms: 1000 },
			});
			const fallbackRunId = ((fallbackStarted.structuredContent as { run?: { runId?: string } } | undefined)?.run?.runId)!;
			expect(fallbackRunId).toMatch(/^run_/);
			expect(await taskStore.findTaskIdByRun(fallbackRunId)).toBeUndefined();
			const fallbackOwnerRead = await clientFallback.callTool({ name: "gpt_run", arguments: { action: "status", run_id: fallbackRunId } });
			expect((fallbackOwnerRead.structuredContent as { runId?: string } | undefined)?.runId).toBe(fallbackRunId);
			expect((await clientA.callTool({ name: "gpt_run", arguments: { action: "status", run_id: fallbackRunId } })).isError).toBe(true);
		} finally {
			await service.suspendActiveRunsForRestart();
			await Promise.allSettled([
				clientA.close(), clientB.close(), clientFallback.close(),
				serverA.close(), serverB.close(), serverFallback.close(),
			]);
		}
	}, 15_000);
});
