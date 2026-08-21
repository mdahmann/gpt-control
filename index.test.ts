import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetCapabilityCache } from "./src/capability";
import gptControl from "./src/index";
import { createMcpServer } from "./src/mcp";
import { GptControlService } from "./src/service";
import { RunStore } from "./src/store";
import type { ExecResult, ExtensionAPI, ToolDefinition } from "./src/types";

const roots: string[] = [];
const savedEnv = { ...process.env };
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-core-"));
	roots.push(root);
	return root;
}

beforeEach(() => {
	resetCapabilityCache();
	process.env.GPT_CONTROL_BRIDGE = "bridge";
	process.env.GPT_CONTROL_POLL_MS = "1";
	delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
	process.env = { ...savedEnv };
	resetCapabilityCache();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function ok(result: unknown): ExecResult {
	return { stdout: JSON.stringify({ success: true, result }), stderr: "", code: 0, killed: false };
}

function browserExec(options: { foreign?: boolean } = {}) {
	let submitted = 0;
	const prompts: string[] = [];
	const calls: string[][] = [];
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		calls.push(args);
		if (args[0] === "ready") return { stdout: JSON.stringify({ endpointStatus: "reachable", extension: "connected", endpoint: "127.0.0.1:9223" }), stderr: "", code: 0, killed: false };
		if (args[0] === "taskSession" && args[1] === "create") return ok({ sessionId: "bridge-session" });
		if (args[0] === "taskSession" && args[1] === "navigate") return ok({ tabId: 77 });
		if (args[0] === "taskSession" && args[1] === "show") return ok({ sessionId: "bridge-session", name: options.foreign ? "other-tool" : "gpt-control:chat:conv", tabIds: [77], state: "working" });
		if (args[0] === "taskSession" && (args[1] === "state" || args[1] === "close")) return ok({ success: true });
		if (args[0] === "getTabs") return ok({ tabs: [{ id: 77, url: "https://chatgpt.com/c/test" }] });
		if (args[0] === "fill") {
			submitted += 1;
			prompts.push(args[3]);
			return ok({ success: true });
		}
		if (args[0] === "click" || args[0] === "uploadFile") return ok({ success: true });
		if (args[0] === "getHTML") {
			const turns = Array.from({ length: submitted }, (_, index) => `<div data-message-author-role="assistant"><p>answer ${index + 1}</p></div>`).join("");
			writeFileSync(args[2], turns);
			return ok({ success: true });
		}
		return ok({ success: true });
	};
	return { exec, calls, prompts };
}

describe("extension surface", () => {
	test("registers mutation and read tools with separate approvals", () => {
		const tools = new Map<string, ToolDefinition>();
		const pi: ExtensionAPI = { registerTool: (definition) => tools.set(definition.name, definition) };
		gptControl(pi);
		expect([...tools.keys()]).toEqual(["gpt_consult", "gpt_chat", "gpt_run", "gpt_run_cancel", "gpt_conversation_close", "gpt_image", "gpt_diagnose"]);
		expect(tools.get("gpt_run")?.approval).toBe("read");
		expect(tools.get("gpt_run_cancel")?.approval).toBe("write");
		expect(tools.get("gpt_conversation_close")?.approval).toBe("write");
	});
});

describe("conversation and run semantics", () => {
	test("assigns one conversation id and a distinct run id per submitted turn", async () => {
		const fake = browserExec();
		const service = new GptControlService(fake.exec, new RunStore(scratch()));
		const workspace = scratch();
		const first = await service.start({ kind: "chat", prompt: "first", transport: "browser", workspaceRoot: workspace, timeoutMs: 200 });
		const second = await service.start({ kind: "chat", prompt: "second", conversationId: first.conversation.id, workspaceRoot: workspace, timeoutMs: 200 });
		expect(second.conversation.id).toBe(first.conversation.id);
		expect(second.run.id).not.toBe(first.run.id);
		expect(first.run.providerRunId).toBe("assistant_turn_1");
		expect(second.run.providerRunId).toBe("assistant_turn_2");
		expect(second.run.resultText).toBe("answer 2");
		expect(fake.calls.filter((args) => args[0] === "taskSession" && args[1] === "navigate")).toHaveLength(1);
	});

	test("persists a structured report, manifest, and receipt for the exact run", async () => {
		const fake = browserExec();
		// The fake browser emits prose, so replace the first assistant body with a structured report.
		const original = fake.exec;
		let submitted = false;
		const exec = async (command: string, args: string[]) => {
			if (args[0] === "fill") submitted = true;
			if (args[0] === "getHTML" && submitted) {
				writeFileSync(args[2], '<div data-message-author-role="assistant"><p>{"verdict":"approve","summary":"clean","findings":[],"openQuestions":[]}</p></div>');
				return ok({ success: true });
			}
			return original(command, args);
		};
		const workspace = scratch();
		writeFileSync(join(workspace, "a.ts"), "export const a = 1;\n");
		const service = new GptControlService(exec, new RunStore(scratch()));
		const result = await service.start({ kind: "consult", prompt: "review", files: ["a.ts"], transport: "browser", workspaceRoot: workspace, timeoutMs: 200 });
		expect(result.run.result?.verdict).toBe("approve");
		expect(result.run.attachmentManifest.files[0].sha256).toHaveLength(64);
		expect(result.run.receipt.promptSha256).toHaveLength(64);
		expect(result.run.receipt.resultSha256).toHaveLength(64);
	});

	test("rejects foreign browser sessions before reading or closing", async () => {
		const fake = browserExec({ foreign: true });
		const store = new RunStore(scratch());
		const service = new GptControlService(fake.exec, store);
		const workspace = scratch();
		const first = await service.start({ kind: "chat", prompt: "first", transport: "browser", workspaceRoot: workspace, timeoutMs: 50 });
		expect(first.run.status).toBe("failed");
		expect(first.run.error).toContain("foreign browser session");
	});
});

describe("MCP adapter", () => {
	test("exports the same core read and write tools", async () => {
		const server = createMcpServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "1.0.0" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual(["gpt_consult", "gpt_chat", "gpt_run", "gpt_run_cancel", "gpt_conversation_close", "gpt_diagnose"]);
		await client.close();
		await server.close();
	});
});
