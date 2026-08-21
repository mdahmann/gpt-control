#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fallbackExec } from "./host";
import { GptControlService } from "./service";

const TransportSchema = z.enum(["chrome_bridge", "codex", "responses", "oracle_browser", "oracle_api"]);
const CommonSchema = {
	conversation_id: z.string().optional(),
	files: z.array(z.string()).optional(),
	transport: TransportSchema.optional(),
	model: z.string().optional(),
	workspace_root: z.string().optional(),
	allow_outside_workspace: z.boolean().optional(),
	allow_sensitive_files: z.boolean().optional(),
	api_confirmed: z.boolean().optional(),
	allow_focus_steal: z.boolean().optional(),
	wait: z.boolean().optional(),
	timeout_ms: z.number().int().positive().optional(),
};

export function createMcpServer(service = new GptControlService(fallbackExec)): McpServer {
	const server = new McpServer({ name: "gpt-control", version: "0.2.0" });

	server.registerTool("gpt_consult", {
		description: "Request a structured independent review with a run receipt.",
		inputSchema: { question: z.string(), ...CommonSchema },
	}, async (params) => result(await service.start(toRequest(params, "consult", params.question))));

	server.registerTool("gpt_chat", {
		description: "Start or continue a provider conversation; each submission gets a run id.",
		inputSchema: { prompt: z.string(), ...CommonSchema },
	}, async (params) => result(await service.start(toRequest(params, "chat", params.prompt))));

	server.registerTool("gpt_run", {
		description: "Read one exact run: status, wait, or result.",
		inputSchema: { action: z.enum(["status", "wait", "result"]), run_id: z.string(), timeout_ms: z.number().int().positive().optional() },
	}, async (params) => {
		const run = params.action === "wait" ? await service.waitForRun(params.run_id, params.timeout_ms) : await service.getRun(params.run_id);
		return toolPayload(run.resultText ?? run.error ?? `Run ${run.id}: ${run.status}`, run);
	});

	server.registerTool("gpt_run_cancel", {
		description: "Cancel one in-process run.",
		inputSchema: { run_id: z.string() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params) => {
		const run = await service.cancelRun(params.run_id);
		return toolPayload(`Run ${run.id}: ${run.status}`, run);
	});

	server.registerTool("gpt_conversation_close", {
		description: "Close one GPT-Control conversation locally. Provider-side data is not deleted.",
		inputSchema: { conversation_id: z.string() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params) => {
		const conversation = await service.closeConversation(params.conversation_id);
		return toolPayload(`Closed ${conversation.id} locally. Provider-side data was not deleted.`, conversation);
	});

	server.registerTool("gpt_diagnose", {
		description: "Report transport readiness and focus-safety behavior.",
		inputSchema: {},
		annotations: { readOnlyHint: true },
	}, async () => toolPayload("GPT-Control transport diagnosis.", await service.diagnose()));

	return server;
}

function toRequest(params: Record<string, unknown>, kind: "consult" | "chat", prompt: string) {
	return {
		kind,
		prompt,
		files: params.files as string[] | undefined,
		conversationId: params.conversation_id as string | undefined,
		transport: params.transport as "chrome_bridge" | "codex" | "responses" | "oracle_browser" | "oracle_api" | undefined,
		model: params.model as string | undefined,
		workspaceRoot: params.workspace_root as string | undefined,
		allowOutsideWorkspace: params.allow_outside_workspace === true,
		allowSensitiveFiles: params.allow_sensitive_files === true,
		apiConfirmed: params.api_confirmed === true,
		allowFocusSteal: params.allow_focus_steal === true,
		wait: params.wait !== false,
		timeoutMs: params.timeout_ms as number | undefined,
	};
}

function result(value: Awaited<ReturnType<GptControlService["start"]>>) {
	return toolPayload(value.run.resultText ?? value.run.error ?? `Run ${value.run.id}: ${value.run.status}`, {
		conversationId: value.conversation.id,
		runId: value.run.id,
		status: value.run.status,
		report: value.run.result,
		receipt: value.run.receipt,
		manifest: value.run.attachmentManifest,
	});
}

function toolPayload(text: string, structured: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: structured as Record<string, unknown>,
	};
}

if (import.meta.main) {
	await createMcpServer().connect(new StdioServerTransport());
}
