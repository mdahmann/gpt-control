import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import gptControl, { resolveOutputDir } from "./src/index";
import { createMcpServer } from "./src/mcp";
import { secureDirectory } from "./src/store";
import { DurableTaskStore } from "./src/task_store";
import type { ExtensionAPI, SchemaNode, ToolDefinition, TypeBuilder } from "./src/types";
import { FakeChromeBridge, makeChromeService } from "./test_helpers";

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
	test("registers image, bounded Pro worker, durable recovery, and split diagnostics", () => {
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
			"gpt_consult", "gpt_chat", "gpt_image", "gpt_subagent_run", "gpt_subagent_get", "gpt_subagent_cancel", "gpt_subagent_list",
			"gpt_run", "gpt_run_cancel", "gpt_conversation_close", "gpt_diagnose", "gpt_diagnose_active",
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
		const subagent = tools.find((tool) => tool.name === "gpt_subagent_run")!;
		const subagentProperties = (subagent.parameters as { properties: Record<string, SchemaNode> }).properties;
		expect(subagentProperties).toHaveProperty("idempotency_key");
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
	test("advertises optional task execution and omits authority-expanding schemas", async () => {
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
			const subagent = listed.tools.find((tool) => tool.name === "gpt_subagent_run");
			expect(subagent?.execution?.taskSupport).toBe("optional");
			expect(subagent?.inputSchema.required).toContain("idempotency_key");
			expect(subagent?.inputSchema.properties).toHaveProperty("connectors");
			expect(subagent?.inputSchema.properties).toHaveProperty("connector_mode");
			const properties = subagent?.inputSchema.properties ?? {};
			for (const field of ["workspace_root", "allow_sensitive_files", "api_confirmed", "allow_focus_steal", "conversation_id", "transport"]) {
				expect(properties).not.toHaveProperty(field);
			}
			expect(listed.tools.map((tool) => tool.name)).toContain("gpt_image");
		} finally {
			await client.close();
			await server.close();
		}
	});
});
