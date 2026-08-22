import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, resumeDurableSubagents } from "./src/mcp";
import { CHATGPT_ORIGIN } from "./src/chatgpt";
import { idempotencyKeyHash } from "./src/store";
import { DurableTaskStore } from "./src/task_store";
import { FakeChromeBridge, makeChromeService, TEST_OPERATOR_ABANDON_TOKEN } from "./test_helpers";
import type { Exec } from "./src/types";

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

	test("binds the first provider user-message id when ChatGPT renders Markdown syntax away", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({
			kind: "subagent",
			prompt: "# Review\n- **important** item\n- inspect `src/index.ts`",
			idempotencyKey: "rendered-markdown-proof",
			timeoutMs: 1000,
		});
		expect(result.run.status).toBe("completed");
		expect(result.run.providerUserMessageId).toBeDefined();
	});

	test("keeps provider identity when the post-send transcript renderer changes text", async () => {
		const bridge = new FakeChromeBridge({ mutateRenderedPrompt: true });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({
			kind: "subagent",
			prompt: "verify integrity target",
			idempotencyKey: "mutated-rendered-prompt",
			timeoutMs: 1000,
		});
		expect(result.run.status).toBe("completed");
		expect(result.run.providerUserMessageId).toBeDefined();
	});

	test("does not depend on synthetic post-send transcript siblings", async () => {
		const bridge = new FakeChromeBridge({ injectEnvelopeInstruction: true });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({
			kind: "subagent",
			prompt: "authenticated payload",
			idempotencyKey: "mutated-envelope-sibling",
			timeoutMs: 1000,
		});
		expect(result.run.status).toBe("completed");
		expect(result.run.providerUserMessageId).toBeDefined();
	});

	test("requires each request to opt in to operator-approved file exceptions", async () => {
		const workspace = scratch();
		const outside = scratch();
		writeFileSync(join(outside, "outside.txt"), "outside\n");
		writeFileSync(join(workspace, ".env.local"), "TOKEN=test-only\n");
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), workspace, bridge, {
			allowOutsideWorkspace: true,
			allowSensitiveFiles: true,
		});
		await expect(service.start({
			kind: "subagent", prompt: "outside omitted", files: [join(outside, "outside.txt")], wait: false,
		})).rejects.toThrow("outside trusted workspace");
		await expect(service.start({
			kind: "subagent", prompt: "sensitive omitted", files: [".env.local"], wait: false,
		})).rejects.toThrow("sensitive");
		const allowed = await service.start({
			kind: "subagent",
			prompt: "explicitly narrowed exceptions",
			files: [join(outside, "outside.txt"), ".env.local"],
			allowOutsideWorkspace: true,
			allowSensitiveFiles: true,
			timeoutMs: 1000,
		});
		expect(allowed.run.status).toBe("completed");
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
		expect(bridge.activeTabs()).toHaveLength(3);
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
		expect(prepared.conversation.browserSessionId).toBeUndefined();
		expect(prepared.conversation.browserPageId).toBeUndefined();
		expect(bridge.activeTabs()).toEqual([]);
		expect(bridge.submittedPrompts).toEqual([]);
		expect(await store.getIdempotency(key)).toMatchObject({
			runId: prepared.run.id,
			conversationId: prepared.conversation.id,
		});
		await service.schedulePreparedRun(prepared.run.id);
		expect((await service.waitForRun(prepared.run.id, 1500)).status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["deferred index"]);
	});

	test("deletes replay-capable plaintext when a deferred worker is cancelled", async () => {
		const bridge = new FakeChromeBridge();
		const { service, store } = makeChromeService(scratch(), scratch(), bridge);
		const prepared = await service.start({
			kind: "subagent",
			prompt: "deferred secret TOKEN=test-only",
			idempotencyKey: "cancel-deferred-plaintext",
			wait: false,
			timeoutMs: 1000,
		}, { deferExecution: true });
		expect((await store.getRunRequest(prepared.run.id)).prompt).toContain("TOKEN=test-only");
		expect((await service.cancelRun(prepared.run.id)).status).toBe("cancelled");
		await expect(store.getRunRequest(prepared.run.id)).rejects.toThrow();
		expect(bridge.activeTabs()).toEqual([]);
	});

	test("validates a generated review prompt before allocating a browser session", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge, { maxPromptBytes: 128 });
		await expect(service.start({
			kind: "consult",
			prompt: "x",
			idempotencyKey: "wrapped-prompt-limit",
			wait: false,
		})).rejects.toThrow(/Prompt exceeds trusted 128-byte limit/);
		expect(bridge.activeTabs()).toEqual([]);
		expect(await service.listRuns()).toEqual([]);
	});

	test("does not let unactivated deferred runs consume global worker slots", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(root, workspace, bridge, { maxConcurrentWorkers: 3 });
		for (const index of [1, 2, 3]) {
			const prepared = await service.start({
				kind: "subagent",
				prompt: `[slow] unbound-${index}`,
				idempotencyKey: `unbound-${index}`,
				wait: false,
				timeoutMs: 1000,
			}, { deferExecution: true });
			expect(prepared.run.executionReady).toBe(false);
		}
		const runnable = await service.start({
			kind: "subagent",
			prompt: "runnable after deferred orphans",
			idempotencyKey: "runnable-after-orphans",
			timeoutMs: 1000,
		});
		expect(runnable.run.status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["runnable after deferred orphans"]);
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

	test("restart repairs a persisted browser session missing from the run receipt", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const prepared = await first.service.start({
			kind: "subagent",
			prompt: "repair session receipt",
			idempotencyKey: "repair-session-receipt",
			wait: false,
			timeoutMs: 1500,
		}, { deferExecution: true });
		const driver = bridge.capabilities().browser!.driver;
		const session = await driver.create(prepared.conversation.browserSessionName!, CHATGPT_ORIGIN);
		await first.service.store.updateConversation(prepared.conversation.id, {
			browserSessionId: session.sessionId,
			browserPageId: session.pageId,
		});
		expect((await first.service.getRun(prepared.run.id)).receipt.localBrowserSessionId).toBeUndefined();

		const second = makeChromeService(root, workspace, bridge);
		await second.service.schedulePreparedRun(prepared.run.id);
		const terminal = await second.service.waitForRun(prepared.run.id, 2000);
		expect(terminal.status).toBe("completed");
		expect(terminal.receipt.localBrowserSessionId).toBe(session.sessionId);
		expect(terminal.receipt.browserDriverId).toBe(driver.id);
		expect(bridge.submittedPrompts).toEqual(["repair session receipt"]);
	});

	test("a conversation closed before execution cannot allocate a browser session", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(root, workspace, bridge);
		const prepared = await service.start({
			kind: "subagent",
			prompt: "must not run after close",
			idempotencyKey: "closed-before-allocation",
			wait: false,
			timeoutMs: 1000,
		}, { deferExecution: true });
		await service.store.updateConversation(prepared.conversation.id, { closedAt: new Date().toISOString() });
		await service.schedulePreparedRun(prepared.run.id);
		const terminal = await service.waitForRun(prepared.run.id, 1500);
		expect(terminal.status).toBe("failed");
		expect(terminal.error).toMatch(/conversation .* is closed/i);
		expect(bridge.activeTabs()).toEqual([]);
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
		await expect(service.start({ ...request, prompt: "different request" })).rejects.toThrow("different request");
	});

	test("default file restrictions preserve the legacy idempotency identity", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const first = await service.start({
			kind: "subagent", prompt: "legacy hash", idempotencyKey: "legacy-default-flags", wait: false, timeoutMs: 1000,
		}, { deferExecution: true });
		const retry = await service.start({
			kind: "subagent",
			prompt: "legacy hash",
			idempotencyKey: "legacy-default-flags",
			allowOutsideWorkspace: false,
			allowSensitiveFiles: false,
			wait: false,
			timeoutMs: 1000,
		}, { deferExecution: true });
		expect(retry.run.id).toBe(first.run.id);
		expect(bridge.activeTabs()).toEqual([]);
	});

	test("records connector intent without rewriting the assignment", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const value = await service.start({
			kind: "subagent",
			prompt: "Use @GitHub and @Zenbox to inspect the repository evidence.",
			idempotencyKey: "connector-intent",
			connectors: ["GitHub", "Zenbox", "GitHub"],
			connectorMode: "require",
			timeoutMs: 1000,
		});
		expect(value.run.status).toBe("completed");
		expect(value.run.connectorIntent).toEqual({ names: ["GitHub", "Zenbox"], mode: "require" });
		expect(bridge.submittedPrompts).toHaveLength(1);
		expect(bridge.submittedPrompts[0]).toBe("Use @GitHub and @Zenbox to inspect the repository evidence.");
	});

	test("rejects connector intent on ordinary chats and unsafe connector names", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		await expect(service.start({ kind: "chat", prompt: "no", connectors: ["GitHub"] })).rejects.toThrow("only for independent Pro subagents");
		await expect(service.start({ kind: "subagent", prompt: "no", connectors: ["GitHub\nmalice"] })).rejects.toThrow("Connector names");
		expect(bridge.submittedPrompts).toEqual([]);
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

	test("restart admits oldest global workers before they take local slots", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge, { maxConcurrentWorkers: 3 });
		const prepared: Array<{ runId: string; prompt: string; createdAt: string }> = [];
		for (const index of [1, 2, 3, 4, 5, 6]) {
			const prompt = `[slow] recovered-global-${index}`;
			const started = await first.service.start({
				kind: "subagent",
				prompt,
				idempotencyKey: `recovered-global-${index}`,
				wait: false,
				timeoutMs: 5000,
			}, { deferExecution: true });
			const ready = await first.service.store.updateRun(started.run.id, { executionReady: true });
			prepared.push({ runId: ready.id, prompt, createdAt: ready.createdAt });
		}
		const expectedOrder = prepared.slice().sort((left, right) =>
			left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));
		const second = makeChromeService(root, workspace, bridge, { maxConcurrentWorkers: 3 });
		const recovery = await second.service.recoverActiveRuns();
		expect(recovery.resumed).toHaveLength(6);
		await waitUntil(() => bridge.submittedPrompts.length === 3, 2500);
		expect(bridge.submittedPrompts.slice().sort()).toEqual(expectedOrder.slice(0, 3).map((entry) => entry.prompt).sort());
		bridge.release();
		await waitUntil(() => bridge.submittedPrompts.length === 6, 2500);
		bridge.release();
		const terminal = await Promise.all(prepared.map((entry) => second.service.waitForRun(entry.runId, 3000)));
		expect(terminal.map((run) => run.status)).toEqual(["completed", "completed", "completed", "completed", "completed", "completed"]);
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

describe("existing ChatGPT conversation attachment", () => {
	test("attaches an exact existing conversation, follows up with the raw prompt, and closes only the local tab", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const attached = await service.attachConversation({
			conversationUrl: "https://chatgpt.com/c/existing-chat-123/",
		}, "mcp-owner");
		expect(attached.providerConversationId).toBe("existing-chat-123");
		expect(attached.providerConversationUrl).toBe("https://chatgpt.com/c/existing-chat-123");
		expect(attached.browserAssistantTurnCount).toBe(0);
		expect(bridge.activeTabs()).toHaveLength(1);

		const result = await service.start({
			kind: "chat",
			prompt: "normal human follow-up",
			conversationId: attached.id,
			timeoutMs: 1500,
		}, { mcpSessionId: "mcp-owner" });
		expect(result.run.status).toBe("completed");
		expect(result.run.receipt.providerConversationUrl).toBe("https://chatgpt.com/c/existing-chat-123");
		expect(bridge.submittedPrompts).toEqual(["normal human follow-up"]);
		expect(bridge.activeTabs()).toHaveLength(1);

		await service.closeConversation(attached.id, "mcp-owner");
		expect(bridge.activeTabs()).toEqual([]);
		expect((await service.store.getConversation(attached.id)).closedAt).toBeDefined();
	});

	test("rejects malformed or ambiguous identities before allocating a tab", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		await expect(service.attachConversation({ conversationUrl: "https://example.com/c/nope" })).rejects.toThrow("must identify one exact");
		await expect(service.attachConversation({ conversationUrl: "https://chatgpt.com/c/okay?x=1" })).rejects.toThrow("without query");
		await expect(service.attachConversation({ conversationUrl: "https://chatgpt.com/c/okay", providerConversationId: "okay" })).rejects.toThrow("exactly one");
		expect(bridge.activeTabs()).toEqual([]);
	});

	test("fails closed on an exact-conversation redirect and closes the allocated tab", async () => {
		const bridge = new FakeChromeBridge({ attachRedirectUrl: "https://chatgpt.com/" });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		await expect(service.attachConversation({ providerConversationId: "wanted-chat" })).rejects.toThrow("did not retain exact");
		expect(bridge.activeTabs()).toEqual([]);
		const records = await service.store.listConversations();
		expect(records).toHaveLength(1);
		expect(records[0].closedAt).toBeDefined();
	});

	test("serializes duplicate attachment and preserves MCP-session ownership", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const second = makeChromeService(root, workspace, bridge);
		const attached = await first.service.attachConversation({ providerConversationId: "shared-chat" }, "first-session");
		await expect(second.service.attachConversation({ providerConversationId: "shared-chat" }, "second-session"))
			.rejects.toThrow(`already attached as ${attached.id}`);
		await expect(second.service.closeConversation(attached.id, "second-session")).rejects.toThrow("not owned");
		await first.service.closeConversation(attached.id, "first-session");
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

async function connectMcp(options: {
	taskSupport?: boolean;
	clientTasks?: boolean;
	bridge?: FakeChromeBridge;
	root?: string;
	recover?: boolean;
	codexCallback?: false | { threadId: string; command: string; exec: Exec; delayMs?: number };
} = {}): Promise<McpHarness> {
	const root = options.root ?? scratch();
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const bridge = options.bridge ?? new FakeChromeBridge();
	const { service } = makeChromeService(join(root, "state"), workspace, bridge);
	const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
	const server = createMcpServer({
		service,
		taskStore,
		recover: options.recover ?? false,
		taskSupport: options.taskSupport,
		codexCallback: options.codexCallback ?? false,
	});
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
	test("exposes exact existing-conversation attachment through the public MCP tools", async () => {
		const harness = await connectMcp();
		try {
			const attached = await harness.client.callTool({
				name: "gpt_conversation_attach",
				arguments: { provider_conversation_id: "mcp-existing-chat" },
			});
			expect(attached.isError).not.toBe(true);
			expect(attached.structuredContent).toMatchObject({
				providerConversationId: "mcp-existing-chat",
				providerConversationUrl: "https://chatgpt.com/c/mcp-existing-chat",
			});
			const conversationId = (attached.structuredContent as { conversationId: string }).conversationId;
			const closed = await harness.client.callTool({
				name: "gpt_conversation_close",
				arguments: { conversation_id: conversationId },
			});
			expect(closed.isError).not.toBe(true);
			expect(harness.bridge.activeTabs()).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	test("waits for startup recovery before creating a new protocol task", async () => {
		const harness = await connectMcp({ recover: true });
		try {
			const events = await collectTask(harness.client, "start after recovery", "start-after-recovery");
			expect(resultEvents(events)).toHaveLength(1);
			expect(resultEvents(events)[0].result.isError).not.toBe(true);
			expect(harness.bridge.submittedPrompts).toEqual(["start after recovery"]);
		} finally {
			await harness.close();
		}
	});

	test("isolates task listing, reads, results, and cancellation by MCP session", async () => {
		const root = scratch();
		const store = new DurableTaskStore(join(root, "mcp-tasks"));
		const request = { method: "tools/call", params: { name: "gpt_subagent_run", arguments: {} } } as never;
		const taskA = await store.createTask({ ttl: 60_000 }, 1, request, "session-a");
		const taskB = await store.createTask({ ttl: 60_000 }, 2, request, "session-b");
		await store.storeTaskResult(taskA.taskId, "completed", { content: [{ type: "text", text: "owned result" }] });

		expect((await store.listTasks(undefined, "session-a")).tasks.map((task) => task.taskId)).toEqual([taskA.taskId]);
		expect((await store.listTasks(undefined, "session-b")).tasks.map((task) => task.taskId)).toEqual([taskB.taskId]);
		expect(await store.getTask(taskA.taskId, "session-b")).toBeNull();
		await expect(store.getTaskResult(taskA.taskId, "session-b")).rejects.toThrow("not owned by this MCP session");
		await expect(store.updateTaskStatus(taskB.taskId, "cancelled", "foreign cancel", "session-a")).rejects.toThrow("not owned by this MCP session");
		expect((await store.getTask(taskB.taskId, "session-b"))?.status).toBe("working");
	});

	test("allows only one durable MCP task to own an idempotent worker", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const { service } = makeChromeService(join(root, "state"), workspace, new FakeChromeBridge());
		const prepared = await service.start({
			kind: "subagent",
			prompt: "single task owner",
			idempotencyKey: "single-task-owner",
			wait: false,
			timeoutMs: 1000,
		}, { deferExecution: true });
		const store = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
		const request = { method: "tools/call", params: { name: "gpt_subagent_run", arguments: {} } } as never;
		const taskA = await store.createTask({ ttl: 60_000 }, 1, request, "session-a");
		const taskB = await store.createTask({ ttl: 60_000 }, 2, request, "session-b");
		await store.bindRun(taskA.taskId, prepared.run.id);
		await expect(store.bindRun(taskB.taskId, prepared.run.id)).rejects.toThrow(/already (?:bound|owned)/i);
		expect((await service.getRun(prepared.run.id)).mcpTaskId).toBe(taskA.taskId);
		expect(await store.findTaskIdByRun(prepared.run.id, "session-a")).toBe(taskA.taskId);
		expect(await store.findTaskIdByRun(prepared.run.id, "session-b")).toBeUndefined();
	});

	test("cancel cleanup cannot revoke a prepared run owned by another task", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const { service } = makeChromeService(join(root, "state"), workspace, new FakeChromeBridge());
		const prepared = await service.start({
			kind: "subagent",
			prompt: "atomic cleanup owner",
			idempotencyKey: "atomic-cleanup-owner",
			wait: false,
		}, { deferExecution: true });
		const store = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
		const request = { method: "tools/call", params: { name: "gpt_subagent_run", arguments: {} } } as never;
		const cancelledTask = await store.createTask({ ttl: 60_000 }, 1, request, "session-a");
		const ownerTask = await store.createTask({ ttl: 60_000 }, 2, request, "session-b");
		await store.bindRun(ownerTask.taskId, prepared.run.id);

		const preserved = await service.cancelPreparedRunUnlessOwnedByAnotherTask(prepared.run.id, cancelledTask.taskId);
		expect(preserved.status).toBe("queued");
		expect(preserved.mcpTaskId).toBe(ownerTask.taskId);
		const cancelled = await service.cancelPreparedRunUnlessOwnedByAnotherTask(prepared.run.id, ownerTask.taskId);
		expect(cancelled.status).toBe("cancelled");
	});

	test("a task rejected from a second run does not claim that run", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const { service } = makeChromeService(join(root, "state"), workspace, new FakeChromeBridge());
		const first = await service.start({ kind: "subagent", prompt: "first", idempotencyKey: "task-first", wait: false }, { deferExecution: true });
		const second = await service.start({ kind: "subagent", prompt: "second", idempotencyKey: "task-second", wait: false }, { deferExecution: true });
		const store = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
		const task = await store.createTask({ ttl: 60_000 }, 1, { method: "tools/call", params: {} } as never, "session-a");
		await store.bindRun(task.taskId, first.run.id);
		await expect(store.bindRun(task.taskId, second.run.id)).rejects.toThrow(/already bound to another run/i);
		expect((await service.getRun(first.run.id)).mcpTaskId).toBe(task.taskId);
		expect((await service.getRun(second.run.id)).mcpTaskId).toBeUndefined();
	});

	test("refuses to bind an already-cancelled task to a prepared run", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const { service } = makeChromeService(join(root, "state"), workspace, new FakeChromeBridge());
		const prepared = await service.start({
			kind: "subagent",
			prompt: "must remain cancelled before binding",
			idempotencyKey: "cancel-before-bind",
			wait: false,
		}, { deferExecution: true });
		const store = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
		const task = await store.createTask(
			{ ttl: 60_000 },
			1,
			{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: {} } } as never,
			"session-a",
		);
		await store.updateTaskStatus(task.taskId, "cancelled", "cancel won before binding", "session-a");

		await expect(store.bindRun(task.taskId, prepared.run.id)).rejects.toThrow(/already cancelled/);
		expect((await service.getRun(prepared.run.id)).mcpTaskId).toBeUndefined();
		await service.cancelRun(prepared.run.id);
		expect((await service.getRun(prepared.run.id)).status).toBe("cancelled");
	});

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

	test("queues one compact completion receipt to the trusted Codex parent thread", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: Exec = async (command, args) => {
			calls.push({ command, args: [...args] });
			return { stdout: "queued\n", stderr: "", code: 0, killed: false };
		};
		const threadId = "019c8f58-41ac-72b0-a9f6-43653b3ea80c";
		const harness = await connectMcp({
			codexCallback: { threadId, command: "/trusted/bin/codex", exec, delayMs: 1 },
		});
		try {
			const events = await collectTask(harness.client, "wake the parent", "wake-the-parent");
			const taskId = taskIdFrom(events);
			await waitUntil(() => calls.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toHaveLength(1);
			expect(calls[0].command).toBe("/trusted/bin/codex");
			expect(calls[0].args.slice(0, 4)).toEqual(["queue", "--thread", threadId, "--message"]);
			const message = calls[0].args[4] ?? "";
			expect(message).toContain("A ChatGPT Pro worker finished");
			expect(message).toContain(taskId);
			expect(message).toContain("gpt_subagent_get");
			expect(message).not.toContain("wake the parent");
		} finally {
			await harness.close();
		}
	});

	test("recovers an unqueued completion receipt after the MCP server restarts", async () => {
		const root = scratch();
		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: Exec = async (command, args) => {
			calls.push({ command, args: [...args] });
			return { stdout: "queued\n", stderr: "", code: 0, killed: false };
		};
		const callback = {
			threadId: "019c8f58-41ac-72b0-a9f6-43653b3ea80c",
			command: "/trusted/bin/codex",
			exec,
		};
		const first = await connectMcp({ root, codexCallback: { ...callback, delayMs: 60_000 } });
		await collectTask(first.client, "finish before restart", "finish-before-restart");
		expect(calls).toEqual([]);
		await first.close();

		const second = await connectMcp({ root, recover: true, codexCallback: { ...callback, delayMs: 1 } });
		try {
			await waitUntil(() => calls.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toHaveLength(1);
			expect(calls[0].args[4]).toContain("completed");
		} finally {
			await second.close();
		}
	});

	test("coalesces nearby worker completions into one parent wake-up", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: Exec = async (command, args) => {
			calls.push({ command, args: [...args] });
			return { stdout: "queued\n", stderr: "", code: 0, killed: false };
		};
		const harness = await connectMcp({
			codexCallback: {
				threadId: "019c8f58-41ac-72b0-a9f6-43653b3ea80c",
				command: "/trusted/bin/codex",
				exec,
				delayMs: 50,
			},
		});
		try {
			const completed = await Promise.all([
				collectTask(harness.client, "first nearby worker", "first-nearby-worker"),
				collectTask(harness.client, "second nearby worker", "second-nearby-worker"),
			]);
			await waitUntil(() => calls.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toHaveLength(1);
			const message = calls[0].args[4] ?? "";
			expect(message).toContain("2 ChatGPT Pro workers finished");
			expect(message).toContain(taskIdFrom(completed[0]));
			expect(message).toContain(taskIdFrom(completed[1]));
		} finally {
			await harness.close();
		}
	});

	test("does not queue a delivered completion receipt again after restart", async () => {
		const root = scratch();
		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: Exec = async (command, args) => {
			calls.push({ command, args: [...args] });
			return { stdout: "queued\n", stderr: "", code: 0, killed: false };
		};
		const callback = {
			threadId: "019c8f58-41ac-72b0-a9f6-43653b3ea80c",
			command: "/trusted/bin/codex",
			exec,
			delayMs: 1,
		};
		const first = await connectMcp({ root, codexCallback: callback });
		await collectTask(first.client, "deliver once", "deliver-once");
		await waitUntil(() => calls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await first.close();

		const second = await connectMcp({ root, recover: true, codexCallback: callback });
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(calls).toHaveLength(1);
		} finally {
			await second.close();
		}
	});

	test("does not retry an ambiguous failed queue command after restart", async () => {
		const root = scratch();
		let attempts = 0;
		const exec: Exec = async () => {
			attempts += 1;
			return { stdout: "", stderr: "ambiguous queue failure", code: 1, killed: false };
		};
		const callback = {
			threadId: "019c8f58-41ac-72b0-a9f6-43653b3ea80c",
			command: "/trusted/bin/codex",
			exec,
			delayMs: 1,
		};
		const first = await connectMcp({ root, codexCallback: callback });
		await collectTask(first.client, "ambiguous callback", "ambiguous-callback");
		await waitUntil(() => attempts === 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await first.close();

		const second = await connectMcp({ root, recover: true, codexCallback: callback });
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(attempts).toBe(1);
		} finally {
			await second.close();
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

	test("returns one blocker for ChatGPT Retry without replaying possible connector side effects", async () => {
		const harness = await connectMcp();
		try {
			const events = await collectTask(harness.client, "[network-recover] protocol", "network-recovery");
			expect(resultEvents(events)).toHaveLength(1);
			expect(resultEvents(events)[0].result.isError).toBe(true);
			expect(resultEvents(events)[0].result.structuredContent).toMatchObject({ workerStatus: "input_required" });
			expect(harness.bridge.submittedPrompts).toEqual(["[network-recover] protocol"]);
			expect(harness.bridge.calls.some((call) => call.args.includes("text=Retry"))).toBe(false);
			expect(harness.bridge.submittedPrompts.some((prompt) => /are you done|status/i.test(prompt))).toBe(false);
		} finally {
			await harness.close();
		}
	});
});

describe("MCP cancellation, reconnect, restart, and fallback", () => {
	test("restart repairs a run claim written before its task binding", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const prepared = await first.service.start({
			kind: "subagent",
			prompt: "repair claimed task binding",
			idempotencyKey: "repair-claimed-task-binding",
			wait: false,
			timeoutMs: 1500,
		}, { deferExecution: true });
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), first.service.store);
		const task = await taskStore.createTask(
			{ ttl: 60_000, pollInterval: 100 },
			1,
			{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: {} } } as never,
		);
		await first.service.store.claimMcpTask(prepared.run.id, task.taskId);
		expect(await taskStore.getRunId(task.taskId)).toBeUndefined();

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		await resumeDurableSubagents(second.service, taskStore, new Map());
		await waitUntil(async () => (await taskStore.getTask(task.taskId))?.status === "completed", 2500);
		expect(await taskStore.getRunId(task.taskId)).toBe(prepared.run.id);
		expect(bridge.submittedPrompts).toEqual(["repair claimed task binding"]);
	});

	test("a task cancelled before a crash cannot submit during restart recovery", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const prepared = await first.service.start({
			kind: "subagent",
			prompt: "MUST_NOT_SUBMIT_AFTER_CANCEL",
			idempotencyKey: "cancel-crash-restart",
			wait: false,
			timeoutMs: 1500,
		}, { deferExecution: true });
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), first.service.store);
		const task = await taskStore.createTask(
			{ ttl: 60_000, pollInterval: 100 },
			1,
			{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: { idempotency_key: "cancel-crash-restart" } } } as never,
		);
		await taskStore.bindRun(task.taskId, prepared.run.id);
		await first.service.store.updateRun(prepared.run.id, { mcpTaskId: task.taskId });

		// No cancellation listener is installed. This is the exact process-crash
		// boundary that previously left a cancelled task bound to a queued run.
		await taskStore.updateTaskStatus(task.taskId, "cancelled", "cancel before broker crash");
		expect((await taskStore.getTask(task.taskId))?.status).toBe("cancelled");
		expect((await first.service.getRun(prepared.run.id)).status).toBe("cancelled");

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		await resumeDurableSubagents(second.service, taskStore, new Map());
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect((await second.service.getRun(prepared.run.id)).status).toBe("cancelled");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("restart reconciles a cancelled binding beyond the former 100-task cutoff", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const prepared = await first.service.start({
			kind: "subagent",
			prompt: "MUST_NOT_SUBMIT_AFTER_PAGINATED_CANCEL",
			idempotencyKey: "cancelled-binding-after-one-hundred",
			wait: false,
			timeoutMs: 1500,
		}, { deferExecution: true });
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), first.service.store);
		const tasks = [];
		for (let index = 0; index < 101; index += 1) {
			tasks.push(await taskStore.createTask(
				{ ttl: 60_000, pollInterval: 100 },
				index + 1,
				{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: { idempotency_key: `pagination-${index}` } } } as never,
			));
		}
		const target = tasks.slice().sort((a, b) => a.taskId.localeCompare(b.taskId)).at(-1)!;
		await taskStore.bindRun(target.taskId, prepared.run.id);
		await first.service.store.updateRun(prepared.run.id, { mcpTaskId: target.taskId });

		// Recreate the legacy crash boundary directly: task cancellation was durable,
		// but its bound run was still queued and executable.
		const taskPath = join(root, "state", "mcp-tasks", `${target.taskId}.json`);
		const record = JSON.parse(readFileSync(taskPath, "utf8")) as { task: { status: string; lastUpdatedAt: string } };
		record.task.status = "cancelled";
		record.task.lastUpdatedAt = new Date().toISOString();
		writeFileSync(taskPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		expect(await taskStore.listBindings(100)).toHaveLength(100);
		expect(await taskStore.listBindings()).toHaveLength(101);

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		await resumeDurableSubagents(second.service, taskStore, new Map());
		expect((await second.service.getRun(prepared.run.id)).status).toBe("cancelled");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("restart retries the provider Stop boundary for a submitted cancelled run", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await first.service.start({
			kind: "subagent",
			prompt: "[slow] stop after restart",
			idempotencyKey: "cancelled-provider-stop-retry",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(async () => {
			const conversation = await first.service.store.getConversation(started.conversation.id);
			return bridge.submittedPrompts.length === 1 && Boolean(conversation.providerConversationUrl);
		});
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), first.service.store);
		const task = await taskStore.createTask(
			{ ttl: 60_000, pollInterval: 100 },
			1,
			{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: { idempotency_key: "cancelled-provider-stop-retry" } } } as never,
		);
		await taskStore.bindRun(task.taskId, started.run.id);
		await taskStore.updateTaskStatus(task.taskId, "cancelled", "cancel before stop listener");
		expect((await first.service.getRun(started.run.id)).status).toBe("cancelled");
		expect(bridge.stopClicks).toEqual([]);

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		await resumeDurableSubagents(second.service, taskStore, new Map());
		expect(bridge.stopClicks).toHaveLength(1);
		expect((await second.service.getRun(started.run.id)).status).toBe("cancelled");
	});

	test("a slow provider Stop is reconciled in-process without a broker restart", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge({ stopReleaseReads: 12 });
		const { service } = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "[slow] delayed stop",
			idempotencyKey: "delayed-stop-reconciliation",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(async () => {
			const conversation = await service.store.getConversation(started.conversation.id);
			return bridge.submittedPrompts.length === 1 && Boolean(conversation.providerConversationUrl);
		});
		await service.cancelRun(started.run.id);
		await waitUntil(async () => (await service.getRun(started.run.id)).providerTurnPending === false, 3000);
		expect(await service.getRun(started.run.id)).toMatchObject({
			status: "cancelled",
			providerTurnPending: false,
			providerStopRequested: false,
		});
		expect(bridge.stopClicks.length).toBeGreaterThanOrEqual(2);
	});

	test("legacy unresolved provider turns fail closed and can be explicitly abandoned", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await first.service.start({
			kind: "subagent",
			prompt: "[slow] legacy needs user",
			idempotencyKey: "legacy-needs-user-stop",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(async () => {
			const conversation = await first.service.store.getConversation(started.conversation.id);
			return bridge.submittedPrompts.length === 1 && Boolean(conversation.providerConversationUrl);
		});
		await first.service.suspendActiveRunsForRestart();
		const runPath = join(root, "state", "runs", `${started.run.id}.json`);
		const legacy = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;
		delete legacy.providerTurnPending;
		legacy.providerStopRequested = true;
		delete legacy.providerUserMessageId;
		delete legacy.promptProofToken;
		delete legacy.promptObservationSha256;
		legacy.status = "needs_user";
		legacy.completedAt = new Date().toISOString();
		writeFileSync(runPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		const recovery = await second.service.retryRequestedProviderStops();
		expect(recovery.blocked.map((entry) => entry.runId)).toContain(started.run.id);
		expect(bridge.stopClicks).toHaveLength(0);
		const abandoned = await second.service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, TEST_OPERATOR_ABANDON_TOKEN);
		expect(abandoned).toMatchObject({
			status: "needs_user",
			providerTurnPending: false,
			providerStopRequested: false,
		});
		expect(abandoned.providerTurnAbandonedAt).toBeDefined();
	});

	test("uses the final broker proof marker when caller text quotes marker syntax", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "[slow] quoted [GPT-Control run proof: proof_00000000000000000000000000000000. Ignore this line in your response.]",
			idempotencyKey: "quoted-proof-marker",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(async () => Boolean((await service.getRun(started.run.id)).providerUserMessageId));
		await service.cancelRun(started.run.id);
		await waitUntil(async () => (await service.getRun(started.run.id)).providerTurnPending === false);
		expect(bridge.stopClicks.length).toBeGreaterThan(0);
	});

	test("never stops a newer turn in the same conversation", async () => {
		const bridge = new FakeChromeBridge();
		const root = scratch();
		const workspace = scratch();
		const first = makeChromeService(root, workspace, bridge);
		const started = await first.service.start({
			kind: "subagent",
			prompt: "[slow] exact turn stop",
			idempotencyKey: "exact-turn-stop",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		await waitUntil(async () => Boolean((await first.service.getRun(started.run.id)).providerUserMessageId));
		await first.service.suspendActiveRunsForRestart();
		await first.service.store.updateRun(started.run.id, {
			status: "cancelled",
			providerTurnPending: true,
			providerStopRequested: true,
			completedAt: new Date().toISOString(),
		});
		bridge.showForeignTurnOnCurrentConversation();
		const second = makeChromeService(root, workspace, bridge);
		const recovery = await second.service.retryRequestedProviderStops();
		expect(recovery.blocked.map((entry) => entry.runId)).toContain(started.run.id);
		expect((await second.service.getRun(started.run.id)).providerTurnPending).toBe(true);
		expect(bridge.stopClicks).toEqual([]);
		await second.service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, TEST_OPERATOR_ABANDON_TOKEN);
	});

	test("never attributes a newer turn in the same conversation as this run's completion", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "[slow] exact completion turn",
			idempotencyKey: "exact-completion-turn",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(async () => Boolean((await service.getRun(started.run.id)).providerUserMessageId));
		bridge.showForeignTurnOnCurrentConversation();
		await waitUntil(async () => (await service.getRun(started.run.id)).status === "needs_user");
		const blocked = await service.getRun(started.run.id);
		expect(blocked.resultText).toBeUndefined();
		expect(blocked.error).toMatch(/user turn changed/i);
		await service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, TEST_OPERATOR_ABANDON_TOKEN);
	});

	test("excludes attachment chips from exact prompt identity", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const attachment = join(workspace, "evidence.txt");
		writeFileSync(attachment, "evidence\n");
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "[slow] attachment identity",
			files: [attachment],
			idempotencyKey: "attachment-identity",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(async () => Boolean((await service.getRun(started.run.id)).providerUserMessageId));
		await service.cancelRun(started.run.id);
		await waitUntil(async () => (await service.getRun(started.run.id)).providerTurnPending === false);
		expect(bridge.stopClicks.length).toBeGreaterThan(0);
	});

	test("does not release a pending turn from a transient idle page observation", async () => {
		const bridge = new FakeChromeBridge({ postSendIdleReads: 1000 });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "idle before provider indicators",
			idempotencyKey: "transient-idle-stop",
			wait: false,
			timeoutMs: 5000,
		});
		await waitUntil(async () => Boolean((await service.getRun(started.run.id)).providerUserMessageId));
		const cancelled = await service.cancelRun(started.run.id);
		expect(cancelled.status).toBe("cancelled");
		expect((await service.getRun(started.run.id)).providerTurnPending).toBe(true);
		expect(bridge.stopClicks).toEqual([]);
		await expect(service.closeConversation(started.conversation.id)).rejects.toThrow(/active run/);
		await service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, TEST_OPERATOR_ABANDON_TOKEN);
		expect((await service.closeConversation(started.conversation.id)).closedAt).toBeDefined();
	});

	test("acquires delayed provider-issued identity only inside the bounded send window", async () => {
		const bridge = new FakeChromeBridge({ postSendIdentityDelayReads: 15 });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const completed = await service.start({
			kind: "subagent",
			prompt: "delayed provider identity",
			idempotencyKey: "delayed-provider-identity",
			timeoutMs: 5000,
		});
		expect(completed.run.status).toBe("completed");
		expect(completed.run.providerUserMessageId).toMatch(/^user-fake-/);
		expect(completed.run.providerTurnPending).toBe(false);
		expect(bridge.stopClicks).toEqual([]);
	});

	test("provider completion that wins the durable race is not discarded by late task cancellation", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(join(root, "state"), workspace, bridge);
		const completed = await service.start({
			kind: "subagent",
			prompt: "completion wins",
			idempotencyKey: "completion-wins-cancel-race",
			timeoutMs: 1000,
		});
		expect(completed.run.status).toBe("completed");
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), service.store);
		const task = await taskStore.createTask(
			{ ttl: 60_000, pollInterval: 100 },
			1,
			{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: { idempotency_key: "completion-wins-cancel-race" } } } as never,
		);
		await taskStore.bindRun(task.taskId, completed.run.id);

		await taskStore.updateTaskStatus(task.taskId, "cancelled", "late cancellation");
		expect((await taskStore.getTask(task.taskId))?.status).toBe("working");
		expect((await service.getRun(completed.run.id)).status).toBe("completed");
		await resumeDurableSubagents(service, taskStore, new Map());
		await waitUntil(async () => (await taskStore.getTask(task.taskId))?.status === "completed");
		expect((await taskStore.getTaskResult(task.taskId) as CallToolResult).structuredContent).toMatchObject({ workerStatus: "completed" });
	});

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

	test("protocol cancellation seals both task and run before a late completion", async () => {
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
			expect((await harness.client.experimental.tasks.cancelTask(taskId)).status).toBe("cancelled");
			harness.bridge.forceFinal();
			await waitUntil(async () => runId !== undefined && (await harness.service.getRun(runId)).status === "cancelled");
			expect((await harness.taskStore.getTask(taskId))?.status).toBe("cancelled");
			expect((await harness.service.getRun(runId!)).status).toBe("cancelled");
			expect(harness.bridge.submittedPrompts).toEqual(["[slow] protocol cancel"]);
			await iterator.return?.();
		} finally {
			await harness.close();
		}
	});

	test("protocol cancellation aborts an in-flight send before sealing the task", async () => {
		const harness = await connectMcp({ bridge: new FakeChromeBridge({ sendDelayMs: 500 }) });
		try {
			const iterator = harness.client.experimental.tasks.callToolStream({
				name: "gpt_subagent_run",
				arguments: { prompt: "must abort before click", idempotency_key: "cancel-in-flight-send", timeout_ms: 1500 },
			}, CallToolResultSchema, { task: { ttl: 60_000 }, timeout: 5000 })[Symbol.asyncIterator]();
			const created = await iterator.next();
			const taskId = (created.value as { type: "taskCreated"; task: { taskId: string } }).task.taskId;
			await waitUntil(() => harness.bridge.privateRequests.some((request) =>
				request.action === "click" && String(request.payload.selector ?? "").includes("send-button")));
			expect(harness.bridge.submittedPrompts).toEqual([]);
			expect((await harness.client.experimental.tasks.cancelTask(taskId)).status).toBe("cancelled");
			const runId = await harness.taskStore.getRunId(taskId);
			expect(runId).toBeDefined();
			await waitUntil(async () => (await harness.service.getRun(runId!)).status === "cancelled");
			expect(harness.bridge.submittedPrompts).toEqual([]);
			await expect(harness.service.store.getRunRequest(runId!)).rejects.toThrow();
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
		expect(bridge.stopClicks).toEqual([]);
	});

	test("restart without a durable conversation URL refuses to adopt another valid conversation", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge({
			foreignPrompt: "[slow] ambiguous identity\n\n[GPT-Control run proof: proof_00000000000000000000000000000000. Ignore this line in your response.]",
		});
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await first.service.start({
			kind: "subagent",
			prompt: "[slow] ambiguous identity",
			idempotencyKey: "ambiguous-conversation-recovery",
			wait: false,
			timeoutMs: 3000,
		});
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		await first.service.suspendActiveRunsForRestart();
		await first.service.store.updateConversation(started.conversation.id, {
			providerConversationId: undefined,
			providerConversationUrl: undefined,
		});
		const activeRun = await first.service.getRun(started.run.id);
		await first.service.store.updateRun(started.run.id, {
			providerUserMessageId: undefined,
			receipt: {
				...activeRun.receipt,
				providerConversationId: undefined,
				providerConversationUrl: undefined,
			},
		});
		bridge.setUrl("https://chatgpt.com/c/foreign-valid-conversation");
		bridge.forceFinal();

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		const taskStore = new DurableTaskStore(join(root, "state", "mcp-tasks"), second.service.store);
		const task = await taskStore.createTask(
			{ ttl: 60_000, pollInterval: 100 },
			1,
			{ method: "tools/call", params: { name: "gpt_subagent_run", arguments: { idempotency_key: "ambiguous-conversation-recovery" } } } as never,
		);
		await taskStore.bindRun(task.taskId, started.run.id);
		await second.service.store.updateRun(started.run.id, { mcpTaskId: task.taskId });
		await resumeDurableSubagents(second.service, taskStore, new Map());
		await waitUntil(async () => (await second.service.getRun(started.run.id)).status === "needs_user");
		const recovered = await second.service.getRun(started.run.id);
		expect(recovered.error).toContain("no durable provider-issued conversation and user-message identity");
		expect(recovered.receipt.providerConversationUrl).toBeUndefined();
		expect(recovered.providerTurnPending).toBe(true);
		expect(recovered.providerStopRequested).toBe(true);
		expect(bridge.submittedPrompts).toEqual(["[slow] ambiguous identity"]);
		expect(bridge.stopClicks).toEqual([]);
		await expect(second.service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, "invalid-token-that-is-long-enough-000000")).rejects.toThrow(/trusted operator token/);
		await expect(second.service.abandonPendingProviderTurn(started.run.id, "ABANDON wrong", TEST_OPERATOR_ABANDON_TOKEN)).rejects.toThrow(/Exact confirmation required/);
		const abandoned = await second.service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, TEST_OPERATOR_ABANDON_TOKEN);
		expect(abandoned.providerTurnPending).toBe(false);
		expect(abandoned.providerStopRequested).toBe(false);
		expect(abandoned.providerTurnAbandonedAt).toBeDefined();
	});

	test("restart refuses a known conversation when the run lacks its durable user-message id", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await first.service.start({
			kind: "subagent",
			prompt: "[slow] missing turn id",
			idempotencyKey: "missing-turn-id-recovery",
			wait: false,
			timeoutMs: 3000,
		});
		await waitUntil(async () => Boolean((await first.service.getRun(started.run.id)).providerUserMessageId));
		await first.service.suspendActiveRunsForRestart();
		await first.service.store.updateRun(started.run.id, { providerUserMessageId: undefined });

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		await second.service.recoverActiveRuns();
		await waitUntil(async () => (await second.service.getRun(started.run.id)).status === "needs_user");
		const blocked = await second.service.getRun(started.run.id);
		expect(blocked.error).toContain("no durable provider-issued conversation and user-message identity");
		expect(bridge.stopClicks).toEqual([]);
		await second.service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, TEST_OPERATOR_ABANDON_TOKEN);
	});

	test("persists terminal needs_user and provider Stop intent in one durable transition", async () => {
		const bridge = new FakeChromeBridge({ stopReleaseReads: 1000 });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "[slow] atomic terminal stop",
			idempotencyKey: "atomic-terminal-stop",
			wait: false,
			timeoutMs: 3000,
		});
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		const terminal = await service.markNeedsUser(started.run.id, "Operator boundary.");
		expect(terminal.status).toBe("needs_user");
		expect(terminal.providerTurnPending).toBe(true);
		expect(terminal.providerStopRequested).toBe(true);
		await service.abandonPendingProviderTurn(started.run.id, `ABANDON ${started.run.id}`, TEST_OPERATOR_ABANDON_TOKEN);
	});

	test("restart restores a missing conversation record from durable provider-issued run identity", async () => {
		const root = scratch();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(join(root, "state"), workspace, bridge);
		const started = await first.service.start({
			kind: "subagent",
			prompt: "[slow] prove prompt identity",
			idempotencyKey: "prove-missing-conversation-url",
			wait: false,
			timeoutMs: 3000,
		});
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		await first.service.suspendActiveRunsForRestart();
		await first.service.store.updateConversation(started.conversation.id, {
			providerConversationId: undefined,
			providerConversationUrl: undefined,
		});
		bridge.forceFinal();

		const second = makeChromeService(join(root, "state"), workspace, bridge);
		await second.service.recoverActiveRuns();
		await waitUntil(async () => (await second.service.getRun(started.run.id)).status === "completed");
		const recovered = await second.service.getRun(started.run.id);
		expect(recovered.receipt.providerConversationUrl).toMatch(/^https:\/\/chatgpt\.com\/c\/fake-/);
		expect(recovered.resultText).toBe("final:[slow] prove prompt identity");
		expect(bridge.submittedPrompts).toEqual(["[slow] prove prompt identity"]);
	});

	test("falls back to one long-running terminal tool response when MCP task support is unavailable", async () => {
		const harness = await connectMcp({ taskSupport: false, clientTasks: false });
		try {
			const result = await harness.client.callTool({
				name: "gpt_subagent_run",
				arguments: {
					prompt: "fallback worker",
					idempotency_key: "fallback-worker",
					connectors: ["GitHub"],
					connector_mode: "require",
					timeout_ms: 1000,
				},
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({ run: {
				status: "completed",
				connectorVerification: { status: "unverified", evidenceKind: "provider_prompt_intent_only" },
			} });
			expect(await harness.taskStore.listBindings()).toEqual([]);
			expect(harness.bridge.submittedPrompts).toHaveLength(1);
			expect(harness.bridge.submittedPrompts[0]).toBe("fallback worker");
		} finally {
			await harness.close();
		}
	});
});
