import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, resumeDurableSubagents } from "./src/mcp";
import { idempotencyKeyHash } from "./src/store";
import { DurableTaskStore } from "./src/task_store";
import { FakeChromeBridge, makeChromeService } from "./test_helpers";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-subagent-"));
	roots.push(root);
	return root;
}
const oldPoll = process.env.GPT_CONTROL_POLL_MS;
beforeEach(() => { process.env.GPT_CONTROL_POLL_MS = "1"; });
afterEach(() => {
	if (oldPoll === undefined) delete process.env.GPT_CONTROL_POLL_MS;
	else process.env.GPT_CONTROL_POLL_MS = oldPoll;
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("condition did not become true before timeout");
}

describe("bounded Pro worker scheduler", () => {
	test("runs one successful worker in one independently owned tab", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "single worker", idempotencyKey: "single-worker", timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(bridge.activeTabs()).toHaveLength(1);
		expect(bridge.submittedPrompts).toEqual(["single worker"]);
		expect(result.run.receipt).toMatchObject({ observedModel: "Pro", modelVerified: true });
	});

	test("supports three concurrent workers and fairly queues a fourth", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const starts = [];
		for (const index of [1, 2, 3, 4]) {
			starts.push(await service.start({
				kind: "subagent",
				prompt: `[slow] worker-${index}`,
				idempotencyKey: `worker-${index}`,
				wait: false,
				timeoutMs: 2000,
			}));
		}
		await waitUntil(() => bridge.submittedPrompts.length === 3);
		expect(bridge.submittedPrompts).toEqual(["[slow] worker-1", "[slow] worker-2", "[slow] worker-3"]);
		bridge.release();
		await waitUntil(() => bridge.submittedPrompts.length === 4);
		bridge.release();
		const terminal = await Promise.all(starts.map((value) => service.waitForRun(value.run.id, 2500)));
		expect(terminal.map((run) => run.status)).toEqual(["completed", "completed", "completed", "completed"]);
		expect(new Set(terminal.map((run) => run.conversationId)).size).toBe(4);
	});

	test("one worker can fail while two independent workers continue", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const results = await Promise.all([
			service.start({ kind: "subagent", prompt: "worker-a", timeoutMs: 1000 }),
			service.start({ kind: "subagent", prompt: "[fail-start] worker-b", timeoutMs: 1000 }),
			service.start({ kind: "subagent", prompt: "worker-c", timeoutMs: 1000 }),
		]);
		expect(results.map((value) => value.run.status)).toEqual(["completed", "failed", "completed"]);
		expect(bridge.submittedPrompts.slice().sort()).toEqual(["worker-a", "worker-c"]);
	});

	test("persists idempotency before a deferred worker can execute", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const { service, store } = makeChromeService(root, workspace, bridge);
		const key = "deferred-index-before-execution";
		const prepared = await service.start({
			kind: "subagent",
			prompt: "deferred index",
			idempotencyKey: key,
			wait: false,
			timeoutMs: 1000,
		}, { deferExecution: true });
		expect(prepared.run.executionReady).toBe(false);
		expect(bridge.submittedPrompts).toEqual([]);
		expect(await store.getIdempotency(key)).toMatchObject({
			runId: prepared.run.id,
			conversationId: prepared.conversation.id,
		});
		await service.schedulePreparedRun(prepared.run.id);
		expect((await service.waitForRun(prepared.run.id, 1500)).status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["deferred index"]);
	});

	test("repairs a crash-orphaned idempotency index without creating or submitting a duplicate run", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const key = "repair-orphan-index";
		const request = {
			kind: "subagent" as const,
			prompt: "orphan repair",
			idempotencyKey: key,
			wait: false,
			timeoutMs: 1000,
		};
		const prepared = await first.service.start(request, { deferExecution: true });
		rmSync(join(root, "idempotency", `${idempotencyKeyHash(key)}.json`));
		const second = makeChromeService(root, workspace, bridge);
		const repaired = await second.service.start(request, { deferExecution: true });
		expect(repaired.run.id).toBe(prepared.run.id);
		expect(repaired.conversation.id).toBe(prepared.conversation.id);
		expect(bridge.submittedPrompts).toEqual([]);
		expect(await second.store.getIdempotency(key)).toMatchObject({ runId: prepared.run.id });
		await second.service.schedulePreparedRun(prepared.run.id);
		expect((await second.service.waitForRun(prepared.run.id, 1500)).status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["orphan repair"]);
	});

	test("does not auto-execute an unbound deferred worker during restart recovery", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const prepared = await service.start({
			kind: "subagent",
			prompt: "unbound deferred",
			idempotencyKey: "unbound-deferred",
			wait: false,
			timeoutMs: 1000,
		}, { deferExecution: true });
		const recovered = await service.recoverActiveRuns();
		expect(recovered).toMatchObject({ resumed: [], blocked: [], deferred: [prepared.run.id] });
		expect((await service.getRun(prepared.run.id)).status).toBe("queued");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("refuses deferred execution after the trusted operator policy fingerprint changes", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const prepared = await first.service.start({
			kind: "subagent",
			prompt: "changed policy",
			idempotencyKey: "changed-policy",
			wait: false,
			timeoutMs: 1000,
		}, { deferExecution: true });
		const second = makeChromeService(root, workspace, bridge, { maxConcurrentWorkers: 2 });
		const refused = await second.service.schedulePreparedRun(prepared.run.id);
		expect(refused.status).toBe("needs_user");
		expect(refused.error).toContain("policy changed");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("duplicate starts are idempotent and submit the prompt once", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const request = { kind: "subagent" as const, prompt: "same request", idempotencyKey: "same-idempotency", wait: false, timeoutMs: 1000 };
		const [one, two] = await Promise.all([service.start(request), service.start(request)]);
		expect(two.run.id).toBe(one.run.id);
		expect(two.conversation.id).toBe(one.conversation.id);
		const terminal = await service.waitForRun(one.run.id, 1500);
		expect(terminal.status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["same request"]);
		await expect(service.start({ ...request, prompt: "different request" })).rejects.toThrow("different GPT-Control request");
	});

	test("cancellation racing a final answer remains cancelled", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({ kind: "subagent", prompt: "[slow] cancellation", wait: false, timeoutMs: 1000 });
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		const cancellation = service.cancelRun(started.run.id);
		bridge.forceFinal();
		expect((await cancellation).status).toBe("cancelled");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect((await service.getRun(started.run.id)).status).toBe("cancelled");
	});

	test("enforces the fair three-worker ceiling across broker processes sharing durable state", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const second = makeChromeService(root, workspace, bridge);
		const owners = [first.service, second.service, first.service, second.service];
		const starts: Array<{ service: typeof first.service; runId: string }> = [];
		for (const index of [1, 2, 3, 4]) {
			const service = owners[index - 1];
			const value = await service.start({
				kind: "subagent",
				prompt: `[slow] global-${index}`,
				idempotencyKey: `global-${index}`,
				wait: false,
				timeoutMs: 2500,
			});
			starts.push({ service, runId: value.run.id });
		}
		await waitUntil(() => bridge.submittedPrompts.length === 3);
		expect(bridge.submittedPrompts).toEqual(["[slow] global-1", "[slow] global-2", "[slow] global-3"]);
		bridge.release();
		await waitUntil(() => bridge.submittedPrompts.length === 4);
		bridge.release();
		const terminal = await Promise.all(starts.map(({ service, runId }) => service.waitForRun(runId, 3000)));
		expect(terminal.map((run) => run.status)).toEqual(["completed", "completed", "completed", "completed"]);
	});

	test("cancels a locally queued worker without waiting for a slot", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge, { maxConcurrentWorkers: 1 });
		const first = await service.start({ kind: "subagent", prompt: "[slow] holder", wait: false, timeoutMs: 1500 });
		const queued = await service.start({ kind: "subagent", prompt: "[slow] queued-cancel", wait: false, timeoutMs: 1500 });
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		const cancelled = await service.cancelRun(queued.run.id);
		expect(cancelled.status).toBe("cancelled");
		expect(bridge.submittedPrompts).toEqual(["[slow] holder"]);
		bridge.release();
		expect((await service.waitForRun(first.run.id, 2000)).status).toBe("completed");
		expect((await service.waitForRun(queued.run.id, 100)).status).toBe("cancelled");
	});
});

interface McpHarness {
	client: Client;
	server: ReturnType<typeof createMcpServer>;
	service: ReturnType<typeof makeChromeService>["service"];
	taskStore: DurableTaskStore;
	bridge: FakeChromeBridge;
	close: () => Promise<void>;
}

async function connectMcp(options: { taskSupport?: boolean; clientTasks?: boolean; bridge?: FakeChromeBridge; root?: string } = {}): Promise<McpHarness> {
	const root = options.root ?? scratch();
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const bridge = options.bridge ?? new FakeChromeBridge();
	const { service } = makeChromeService(join(root, "state"), workspace, bridge);
	const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
	const server = createMcpServer({ service, taskStore, recover: false, taskSupport: options.taskSupport });
	const client = new Client({ name: "codex-fixture", version: "1" }, options.clientTasks === false ? {} : {
		capabilities: { tasks: { requests: { tools: { call: {} } } } },
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		server,
		service,
		taskStore,
		bridge,
		close: async () => {
			await client.close().catch(() => undefined);
			await server.close().catch(() => undefined);
		},
	};
}

async function collectTask(client: Client, prompt: string, key: string): Promise<Array<Record<string, unknown>>> {
	const events: Array<Record<string, unknown>> = [];
	const stream = client.experimental.tasks.callToolStream({
		name: "gpt_subagent_run",
		arguments: { prompt, idempotency_key: key, timeout_ms: 1500 },
	}, CallToolResultSchema, { task: { ttl: 60_000 }, timeout: 5000 });
	for await (const event of stream) events.push(event as unknown as Record<string, unknown>);
	return events;
}

function resultEvents(events: Array<Record<string, unknown>>): Array<{ type: string; result: CallToolResult }> {
	return events.filter((event) => event.type === "result") as unknown as Array<{ type: string; result: CallToolResult }>;
}

function taskIdFrom(events: Array<Record<string, unknown>>): string {
	const created = events.find((event) => event.type === "taskCreated") as { task?: { taskId?: string } } | undefined;
	if (!created?.task?.taskId) throw new Error("task creation event missing");
	return created.task.taskId;
}

describe("MCP task delivery", () => {
	test("delivers one successful terminal result exactly once with durable truthful provenance", async () => {
		const harness = await connectMcp();
		try {
			const events = await collectTask(harness.client, "mcp success", "mcp-success");
			expect(events[0]?.type).toBe("taskCreated");
			expect(resultEvents(events)).toHaveLength(1);
			const result = resultEvents(events)[0].result;
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({ workerStatus: "completed" });
			const taskId = taskIdFrom(events);
			const durable = await harness.client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
			expect(durable).toEqual(result);
			const history = await harness.taskStore.statusHistory(taskId);
			expect(history.filter((entry) => entry.status === "completed")).toHaveLength(1);
			expect(harness.bridge.submittedPrompts).toEqual(["mcp success"]);
			const run = (result.structuredContent as { run: { receipt: { observedModel: string; modelVerified: boolean } } }).run;
			expect(run.receipt).toMatchObject({ observedModel: "Pro", modelVerified: true });
		} finally {
			await harness.close();
		}
	});

	test("three task calls complete independently with one terminal result each", async () => {
		const harness = await connectMcp();
		try {
			const all = await Promise.all([1, 2, 3].map((index) => collectTask(harness.client, `protocol-${index}`, `protocol-${index}`)));
			expect(all.map((events) => resultEvents(events).length)).toEqual([1, 1, 1]);
			expect(new Set(all.map(taskIdFrom)).size).toBe(3);
			expect(harness.bridge.submittedPrompts.slice().sort()).toEqual(["protocol-1", "protocol-2", "protocol-3"]);
		} finally {
			await harness.close();
		}
	});

	test("publishes input_required before one terminal blocker result", async () => {
		const harness = await connectMcp();
		try {
			const events = await collectTask(harness.client, "[input-required] protocol", "input-required");
			const statuses = events
				.filter((event) => event.type === "taskStatus")
				.map((event) => (event.task as { status: string }).status);
			expect(statuses).toContain("input_required");
			expect(resultEvents(events)).toHaveLength(1);
			expect(resultEvents(events)[0].result).toMatchObject({ isError: true });
			expect(resultEvents(events)[0].result.structuredContent).toMatchObject({ workerStatus: "input_required" });
		} finally {
			await harness.close();
		}
	});

	test("recovers a ChatGPT network error without model-visible status prompts", async () => {
		const harness = await connectMcp();
		try {
			const events = await collectTask(harness.client, "[network-recover] protocol", "network-recovery");
			expect(resultEvents(events)).toHaveLength(1);
			expect(resultEvents(events)[0].result.isError).not.toBe(true);
			expect(harness.bridge.submittedPrompts).toEqual(["[network-recover] protocol"]);
			expect(harness.bridge.submittedPrompts.some((prompt) => /are you done|status/i.test(prompt))).toBe(false);
		} finally {
			await harness.close();
		}
	});
});

describe("MCP cancellation, reconnect, restart, and fallback", () => {
	test("immediate task cancellation after creation prevents prompt submission", async () => {
		const harness = await connectMcp({ bridge: new FakeChromeBridge({ firstTabRaceReads: 20 }) });
		try {
			const iterator = harness.client.experimental.tasks.callToolStream({
				name: "gpt_subagent_run",
				arguments: { prompt: "must never submit", idempotency_key: "cancel-before-submit", timeout_ms: 1500 },
			}, CallToolResultSchema, { task: { ttl: 60_000 }, timeout: 5000 })[Symbol.asyncIterator]();
			const created = await iterator.next();
			expect(created.value?.type).toBe("taskCreated");
			const taskId = (created.value as { type: "taskCreated"; task: { taskId: string } }).task.taskId;
			expect((await harness.client.experimental.tasks.cancelTask(taskId)).status).toBe("cancelled");
			await waitUntil(async () => {
				const runId = await harness.taskStore.getRunId(taskId);
				return runId !== undefined && (await harness.service.getRun(runId)).status === "cancelled";
			});
			expect(harness.bridge.submittedPrompts).toEqual([]);
			await iterator.return?.();
		} finally {
			await harness.close();
		}
	});

	test("protocol cancellation racing completion seals both task and run as cancelled", async () => {
		const harness = await connectMcp();
		try {
			const iterator = harness.client.experimental.tasks.callToolStream({
				name: "gpt_subagent_run",
				arguments: { prompt: "[slow] protocol cancel", idempotency_key: "protocol-cancel", timeout_ms: 1500 },
			}, CallToolResultSchema, { task: { ttl: 60_000 }, timeout: 5000 })[Symbol.asyncIterator]();
			const created = await iterator.next();
			expect(created.value?.type).toBe("taskCreated");
			const taskId = (created.value as { type: "taskCreated"; task: { taskId: string } }).task.taskId;
			await waitUntil(() => harness.bridge.submittedPrompts.length === 1);
			const runId = await harness.taskStore.getRunId(taskId);
			const cancellation = harness.client.experimental.tasks.cancelTask(taskId);
			harness.bridge.forceFinal();
			expect((await cancellation).status).toBe("cancelled");
			await waitUntil(async () => runId !== undefined && (await harness.service.getRun(runId)).status === "cancelled");
			expect((await harness.taskStore.getTask(taskId))?.status).toBe("cancelled");
			expect((await harness.service.getRun(runId!)).status).toBe("cancelled");
			expect(harness.bridge.submittedPrompts).toEqual(["[slow] protocol cancel"]);
			await iterator.return?.();
		} finally {
			await harness.close();
		}
	});

	test("client disconnect does not cancel the worker; a new client retrieves one durable result", async () => {
		const root = scratch();
		const harness = await connectMcp({ root });
		const iterator = harness.client.experimental.tasks.callToolStream({
			name: "gpt_subagent_run",
			arguments: { prompt: "[slow] reconnect", idempotency_key: "reconnect", timeout_ms: 2000 },
		}, CallToolResultSchema, { task: { ttl: 60_000 }, timeout: 5000 })[Symbol.asyncIterator]();
		const created = await iterator.next();
		expect(created.value?.type).toBe("taskCreated");
		const taskId = (created.value as { type: "taskCreated"; task: { taskId: string } }).task.taskId;
		await waitUntil(() => harness.bridge.submittedPrompts.length === 1);
		await harness.close();
		harness.bridge.release();
		await waitUntil(async () => (await harness.taskStore.getTask(taskId))?.status === "completed", 2500);

		const server2 = createMcpServer({ service: harness.service, taskStore: harness.taskStore, recover: false });
		const client2 = new Client({ name: "codex-reconnected", version: "1" }, {
			capabilities: { tasks: { requests: { tools: { call: {} } } } },
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server2.connect(serverTransport), client2.connect(clientTransport)]);
		try {
			expect((await client2.experimental.tasks.getTask(taskId)).status).toBe("completed");
			const result = await client2.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
			expect(result.structuredContent).toMatchObject({ workerStatus: "completed" });
			expect((await harness.taskStore.statusHistory(taskId)).filter((entry) => entry.status === "completed")).toHaveLength(1);
			expect(harness.bridge.submittedPrompts).toEqual(["[slow] reconnect"]);
		} finally {
			await client2.close();
			await server2.close();
		}
	});

	test("server restart resumes a submitted worker in the same tab without replaying the prompt", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await first.service.start({
			kind: "subagent",
			prompt: "[slow] restart",
			idempotencyKey: "restart-worker",
			wait: false,
			timeoutMs: 2000,
		});
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), first.service.store);
		const task = await taskStore.createTask(
			{ ttl: 60_000, pollInterval: 100 },
			1,
			{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: { idempotency_key: "restart-worker" } } } as never,
		);
		await taskStore.bindRun(task.taskId, started.run.id);
		await first.service.store.updateRun(started.run.id, { mcpTaskId: task.taskId });
		await first.service.suspendActiveRunsForRestart();
		expect((await first.service.getRun(started.run.id)).status).toBe("running");

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		await resumeDurableSubagents(second.service, taskStore, new Map());
		bridge.release();
		await waitUntil(async () => (await taskStore.getTask(task.taskId))?.status === "completed", 2500);
		const result = await taskStore.getTaskResult(task.taskId) as CallToolResult;
		expect(result.structuredContent).toMatchObject({ workerStatus: "completed" });
		expect((await second.service.getRun(started.run.id)).status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["[slow] restart"]);
	});

	test("falls back to one long-running terminal tool response when MCP task support is unavailable", async () => {
		const harness = await connectMcp({ taskSupport: false, clientTasks: false });
		try {
			const result = await harness.client.callTool({
				name: "gpt_subagent_run",
				arguments: { prompt: "fallback worker", idempotency_key: "fallback-worker", timeout_ms: 1000 },
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({ run: { status: "completed" } });
			expect(await harness.taskStore.listBindings()).toEqual([]);
			expect(harness.bridge.submittedPrompts).toEqual(["fallback worker"]);
		} finally {
			await harness.close();
		}
	});
});
