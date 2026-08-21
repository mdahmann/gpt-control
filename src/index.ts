import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { captureScreenshot, fetchArtifact } from "./chatgpt";
import { resolveExec, resolveType, applyLabel } from "./host";
import { GptControlService, type StartRequest } from "./service";
import { resolveCapabilities } from "./capability";
import type { RunRecord } from "./domain";
import type { Exec, ExtensionAPI, ToolResult, TypeBuilder } from "./types";

export const GENERATED_ROOT = resolve(homedir(), ".gpt-control", "generated");

function textResult(text: string, details?: unknown, isError = false): ToolResult {
	return {
		content: [{ type: "text", text }],
		...(details === undefined ? {} : { details, structuredContent: details }),
		...(isError ? { isError: true } : {}),
	};
}

function describeError(error: unknown): ToolResult {
	return textResult(error instanceof Error ? error.message : String(error), undefined, true);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
}

function startRequest(params: Record<string, unknown>, kind: "consult" | "chat" | "image"): StartRequest {
	return {
		kind,
		prompt: String(kind === "consult" ? params.question ?? "" : params.prompt ?? ""),
		files: stringList(params.files),
		conversationId: typeof params.conversation_id === "string" ? params.conversation_id : undefined,
		transport: isTransport(params.transport) ? params.transport : undefined,
		model: typeof params.model === "string" ? params.model : undefined,
		workspaceRoot: typeof params.workspace_root === "string" ? params.workspace_root : undefined,
		allowOutsideWorkspace: params.allow_outside_workspace === true,
		allowSensitiveFiles: params.allow_sensitive_files === true,
		apiConfirmed: params.api_confirmed === true,
		allowFocusSteal: params.allow_focus_steal === true,
		wait: params.wait !== false,
		timeoutMs: typeof params.timeout_ms === "number" ? params.timeout_ms : undefined,
	};
}

function isTransport(value: unknown): value is StartRequest["transport"] {
	return value === "chrome_bridge" || value === "oracle_browser" || value === "oracle_api";
}

function runText(run: RunRecord): string {
	if (run.status === "completed") {
		if (run.result) return `${run.result.verdict}: ${run.result.summary}`;
		return run.resultText ?? "Completed without text.";
	}
	if (run.status === "failed" || run.status === "cancelled" || run.status === "needs_user") return run.error ?? run.status;
	return `Run ${run.id} is ${run.status}.`;
}

export default function gptControl(pi: ExtensionAPI): void {
	const exec = resolveExec(pi);
	const Type: TypeBuilder = resolveType(pi);
	const service = new GptControlService(exec);
	applyLabel(pi, "GPT-Control");
	const common = commonParameters(Type);

	pi.registerTool({
		name: "gpt_consult",
		label: "GPT Consult",
		description: "Request an independent structured review. Returns separate conversation_id and run_id values plus a file manifest and provenance receipt.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({
			question: Type.String(),
			...common,
		}),
		execute: async (_id, params) => {
			try {
				const result = await service.start(startRequest(params, "consult"));
				return textResult(runText(result.run), { conversationId: result.conversation.id, runId: result.run.id, status: result.run.status, report: result.run.result, receipt: result.run.receipt, manifest: result.run.attachmentManifest }, result.run.status === "failed");
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_chat",
		label: "GPT Chat",
		description: "Start or continue a provider conversation. Pass conversation_id for follow-ups; each submission receives a new run_id.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({
			prompt: Type.String(),
			...common,
		}),
		execute: async (_id, params) => {
			try {
				const result = await service.start(startRequest(params, "chat"));
				return textResult(runText(result.run), { conversationId: result.conversation.id, runId: result.run.id, status: result.run.status, receipt: result.run.receipt, manifest: result.run.attachmentManifest }, result.run.status === "failed");
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_run",
		label: "GPT Run",
		description: "Read one exact run: status, wait, or result. A run identifies one submission, not a whole conversation.",
		loadMode: "discoverable",
		approval: "read",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("result")]),
			run_id: Type.String(),
			timeout_ms: Type.Optional(Type.Integer()),
		}),
		execute: async (_id, params) => {
			try {
				const runId = String(params.run_id);
				const run = params.action === "wait"
					? await service.waitForRun(runId, typeof params.timeout_ms === "number" ? params.timeout_ms : undefined)
					: await service.getRun(runId);
				return textResult(runText(run), { runId: run.id, conversationId: run.conversationId, status: run.status, report: run.result, receipt: run.receipt, manifest: run.attachmentManifest, artifacts: run.artifactPaths }, run.status === "failed");
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_run_cancel",
		label: "GPT Run Cancel",
		description: "Cancel one in-process run. Kept separate from gpt_run so read-only inspection cannot mutate state.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({ run_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const run = await service.cancelRun(String(params.run_id));
				return textResult(`Run ${run.id}: ${run.status}.`, { runId: run.id, status: run.status });
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_conversation_close",
		label: "GPT Conversation Close",
		description: "Close a GPT-Control conversation locally. For Chrome Bridge this closes only the wrapper-owned tabs; it does not delete provider-side history or uploaded files.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({ conversation_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const conversation = await service.closeConversation(String(params.conversation_id));
				return textResult(`Closed ${conversation.id} locally. Provider-side data was not deleted.`, { conversationId: conversation.id, closedAt: conversation.closedAt });
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_image",
		label: "GPT Image",
		description: "Generate or iterate on an image through an explicitly selected Chrome Bridge conversation, with each iteration receiving a new run_id.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({
			prompt: Type.String(),
			...common,
			output_dir: Type.Optional(Type.String()),
			allow_external_output: Type.Optional(Type.Boolean()),
		}),
		execute: async (_id, params) => {
			try {
				const request = startRequest({ ...params, transport: params.transport ?? "chrome_bridge" }, "image");
				const result = await service.start(request);
				if (result.run.status !== "completed") return textResult(runText(result.run), { conversationId: result.conversation.id, runId: result.run.id, status: result.run.status }, true);
				return await imageResult(exec, service, result.run, params.output_dir, params.allow_external_output);
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_diagnose",
		label: "GPT Diagnose",
		description: "Report available transports and focus-safety behavior without starting any model or browser.",
		loadMode: "discoverable",
		approval: "read",
		parameters: Type.Object({}),
		execute: async () => {
			try {
				const details = await service.diagnose();
				return textResult("GPT-Control transport diagnosis.", details);
			} catch (error) {
				return describeError(error);
			}
		},
	});
}

function commonParameters(Type: TypeBuilder): Record<string, Record<string, unknown>> {
	return {
		conversation_id: Type.Optional(Type.String({ description: "Wrapper-owned conversation id for a follow-up." })),
		files: Type.Optional(Type.Array(Type.String())),
		transport: Type.Optional(Type.Union([Type.Literal("chrome_bridge"), Type.Literal("oracle_browser"), Type.Literal("oracle_api")])),
		model: Type.Optional(Type.String()),
		workspace_root: Type.Optional(Type.String({ description: "Boundary for attachments; defaults to the process working directory." })),
		allow_outside_workspace: Type.Optional(Type.Boolean()),
		allow_sensitive_files: Type.Optional(Type.Boolean()),
		api_confirmed: Type.Optional(Type.Boolean()),
		allow_focus_steal: Type.Optional(Type.Boolean({ description: "Required only for explicit Oracle browser mode." })),
		wait: Type.Optional(Type.Boolean({ description: "Default true. False returns identifiers while the run continues in-process." })),
		timeout_ms: Type.Optional(Type.Integer()),
	};
}

export function resolveOutputDir(value: unknown, allowExternal: unknown): string {
	if (typeof value !== "string" || value === "") return GENERATED_ROOT;
	const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
	const absolute = isAbsolute(expanded) ? expanded : resolve(GENERATED_ROOT, expanded);
	if (allowExternal === true) return absolute;
	if (absolute === GENERATED_ROOT || absolute.startsWith(`${GENERATED_ROOT}${sep}`)) return absolute;
	throw new Error(`${absolute} is outside ${GENERATED_ROOT}. Pass allow_external_output=true to write there.`);
}

async function imageResult(exec: Exec, service: GptControlService, run: RunRecord, outputValue: unknown, allowExternal: unknown): Promise<ToolResult> {
	const outputDir = resolveOutputDir(outputValue, allowExternal);
	await mkdir(outputDir, { recursive: true });
	const content: Array<Record<string, unknown>> = [];
	const paths: string[] = [];
	for (const url of (run.artifactUrls ?? []).slice(0, 4)) {
		const suffix = createHash("sha256").update(url).digest("hex").slice(0, 12);
		const path = resolve(outputDir, `${run.id}-${suffix}.png`);
		const saved = await fetchArtifact(url, path);
		if (!saved.path) continue;
		paths.push(saved.path);
		content.push({ type: "image", data: (await readFile(saved.path)).toString("base64"), mimeType: "image/png" });
	}
	if (paths.length === 0) {
		const conversation = await service.store.getConversation(run.conversationId);
		const capabilities = await resolveCapabilities(exec);
		if (conversation.provider === "chrome_bridge" && capabilities.bridge && conversation.bridgeTabId !== undefined) {
			const path = resolve(outputDir, `${run.id}.screenshot.png`);
			const screenshot = await captureScreenshot(exec, capabilities.bridge.launcher, conversation.bridgeTabId, path);
			if (screenshot) {
				paths.push(screenshot);
				content.push({ type: "image", data: (await readFile(screenshot)).toString("base64"), mimeType: "image/png" });
			}
		}
	}
	if (paths.length === 0) return textResult("The run completed, but no image artifact could be recovered.", { runId: run.id, conversationId: run.conversationId }, true);
	await service.store.updateRun(run.id, { artifactPaths: paths });
	content.push({ type: "text", text: run.resultText || "Image ready." });
	return { content, details: { runId: run.id, conversationId: run.conversationId, artifacts: paths, receipt: run.receipt }, structuredContent: { runId: run.id, conversationId: run.conversationId, artifacts: paths, receipt: run.receipt } };
}

export { buildAttachmentManifest, isSensitive } from "./files";
export { REVIEW_OUTPUT_SCHEMA } from "./domain";
export { parseReviewReport } from "./review";
export { GptControlService } from "./service";
export { fallbackExec, resolveExec, resolveType } from "./host";
