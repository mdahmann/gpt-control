import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { assertExactDriverSession } from "./browser-driver";
import { fetchArtifact, providerConversationIdentity } from "./chatgpt";
import { resolveCapabilities } from "./capability";
import type { RunRecord } from "./domain";
import { applyLabel, resolveExec, resolveType } from "./host";
import { GptControlService, type StartRequest } from "./service";
import { confinedPath, secureDirectory } from "./store";
import type { Exec, ExtensionAPI, ToolResult, TypeBuilder } from "./types";

export const GENERATED_ROOT = resolve(homedir(), ".gpt-control", "v3", "generated");

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
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
		: [];
}

function startRequest(
	params: Record<string, unknown>,
	kind: "consult" | "chat" | "image" | "subagent",
	wait = true,
): StartRequest {
	return {
		kind,
		prompt: String(kind === "consult" ? params.question ?? "" : params.prompt ?? ""),
		files: stringList(params.files),
		conversationId: kind === "subagent"
			? undefined
			: typeof params.conversation_id === "string" ? params.conversation_id : undefined,
		transport: "browser",
		chatgptModel: "pro",
		idempotencyKey: typeof params.idempotency_key === "string" ? params.idempotency_key : undefined,
		connectors: stringList(params.connectors),
		connectorMode: params.connector_mode === "require" ? "require" : params.connector_mode === "prefer" ? "prefer" : undefined,
		wait,
		timeoutMs: typeof params.timeout_ms === "number" ? params.timeout_ms : undefined,
	};
}

function runText(run: RunRecord): string {
	if (run.status === "completed") {
		if (run.result) return `${run.result.verdict}: ${run.result.summary}`;
		return run.resultText ?? "Completed without text.";
	}
	if (run.status === "failed" || run.status === "cancelled" || run.status === "needs_user") {
		return run.error ?? run.status;
	}
	return `Run ${run.id} is ${run.status}.`;
}

export default function gptControl(pi: ExtensionAPI): void {
	const exec = resolveExec(pi);
	const Type: TypeBuilder = resolveType(pi);
	const service = new GptControlService(exec);
	applyLabel(pi, "GPT-Control");
	const common = commonParameters(Type);

	registerStartTool(
		pi, Type, service,
		"gpt_consult", "GPT Consult", "consult", "question", common,
		"Request a bounded structured review. Attachment authority is fixed by trusted operator policy.",
	);
	registerStartTool(
		pi, Type, service,
		"gpt_chat", "GPT Chat", "chat", "prompt", common,
		"Start or continue one exact ChatGPT conversation with durable run identity and live model provenance.",
	);
	registerImageTool(pi, Type, exec, service);
	registerSubagentStart(pi, Type, service);
	registerRunTools(pi, Type, service);
	registerDiagnostics(pi, Type, service);
}

function registerStartTool(
	pi: ExtensionAPI,
	Type: TypeBuilder,
	service: GptControlService,
	name: "gpt_consult" | "gpt_chat",
	label: string,
	kind: "consult" | "chat",
	promptField: "question" | "prompt",
	common: Record<string, Record<string, unknown>>,
	description: string,
): void {
	pi.registerTool({
		name,
		label,
		description,
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({ [promptField]: Type.String(), ...common }),
		execute: async (_id, params) => {
			try {
				const value = await service.start(startRequest(params, kind));
				return textResult(
					runText(value.run),
					publicRun(value.run),
					value.run.status === "failed" || value.run.status === "needs_user",
				);
			} catch (error) {
				return describeError(error);
			}
		},
	});
}

function registerImageTool(pi: ExtensionAPI, Type: TypeBuilder, exec: Exec, service: GptControlService): void {
	pi.registerTool({
		name: "gpt_image",
		label: "GPT Image",
		description: "Generate or iterate on an image in an owned ChatGPT conversation. Local output is confined to the trusted broker output root.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({
			prompt: Type.String(),
			conversation_id: Type.Optional(Type.String()),
			files: Type.Optional(Type.Array(Type.String())),
			idempotency_key: Type.Optional(Type.String()),
			timeout_ms: Type.Optional(Type.Integer()),
			output_dir: Type.Optional(Type.String({ description: "Relative subdirectory inside the trusted output root." })),
		}),
		execute: async (_id, params) => {
			try {
				const value = await service.start(startRequest(params, "image"));
				if (value.run.status !== "completed") {
					return textResult(runText(value.run), publicRun(value.run), true);
				}
				return await imageResult(exec, service, value.run, params.output_dir);
			} catch (error) {
				return describeError(error);
			}
		},
	});
}

function registerSubagentStart(pi: ExtensionAPI, Type: TypeBuilder, service: GptControlService): void {
	pi.registerTool({
		name: "gpt_subagent_run",
		label: "GPT Pro Worker",
		description: "Run one independent bounded ChatGPT Pro worker. Codex remains the orchestrator and receives one terminal completion or blocker result.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({
			prompt: Type.String(),
			files: Type.Optional(Type.Array(Type.String())),
			idempotency_key: Type.String(),
			connectors: Type.Optional(Type.Array(Type.String({ description: "Connected-tool names requested for this worker; names do not grant permission." }))),
			connector_mode: Type.Optional(Type.Union([Type.Literal("prefer"), Type.Literal("require")])),
			timeout_ms: Type.Optional(Type.Integer()),
		}),
		execute: async (_id, params) => {
			try {
				const value = await service.start(startRequest(params, "subagent", true));
				return textResult(
					runText(value.run),
					publicRun(value.run),
					value.run.status !== "completed",
				);
			} catch (error) {
				return describeError(error);
			}
		},
	});
}
function registerRunTools(pi: ExtensionAPI, Type: TypeBuilder, service: GptControlService): void {
	pi.registerTool({
		name: "gpt_run",
		label: "GPT Run",
		description: "Read one durable run. Waiting observes existing state and never resubmits a prompt.",
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("result")]),
			run_id: Type.String(),
			timeout_ms: Type.Optional(Type.Integer()),
		}),
		execute: async (_id, params) => {
			try {
				const run = params.action === "wait"
					? await service.waitForRun(
						String(params.run_id),
						typeof params.timeout_ms === "number" ? params.timeout_ms : undefined,
					)
					: await service.getRun(String(params.run_id));
				return textResult(
					runText(run), publicRun(run),
					run.status === "failed" || run.status === "needs_user",
				);
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_run_cancel",
		label: "GPT Run Cancel",
		description: "Durably cancel one run. Terminal cancellation cannot be overwritten by a late provider completion.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({ run_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const run = await service.cancelRun(String(params.run_id));
				return textResult(runText(run), publicRun(run));
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_run_abandon_pending",
		label: "GPT Run Abandon Pending Provider Turn",
		description: "Operator-authenticated release of an unresolved provider-turn slot after manual review. This does not prove that provider work stopped.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({ run_id: Type.String(), confirmation: Type.String(), operator_token: Type.String() }),
		execute: async (_id, params) => {
			try {
				const runId = String(params.run_id);
				const run = await service.abandonPendingProviderTurn(runId, String(params.confirmation), String(params.operator_token));
				return textResult(runText(run), publicRun(run));
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_subagent_get",
		label: "GPT Pro Worker Get",
		description: "One durable recovery lookup for a Pro worker after reconnect or uncertainty.",
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		parameters: Type.Object({ run_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const run = await service.getRun(String(params.run_id));
				if (run.kind !== "subagent") throw new Error("Run is not a Pro worker.");
				return textResult(
					runText(run), publicRun(run),
					run.status === "failed" || run.status === "needs_user",
				);
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_subagent_cancel",
		label: "GPT Pro Worker Cancel",
		description: "Durably cancel one independent Pro worker by run id.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({ run_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const current = await service.getRun(String(params.run_id));
				if (current.kind !== "subagent") throw new Error("Run is not a Pro worker.");
				const run = await service.cancelRun(current.id);
				return textResult(runText(run), publicRun(run));
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_subagent_list",
		label: "GPT Pro Workers",
		description: "Bounded durable overview of Pro workers for reconnect recovery, not a polling protocol.",
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer()),
			include_terminal: Type.Optional(Type.Boolean()),
		}),
		execute: async (_id, params) => {
			try {
				const limit = Math.max(1, Math.min(
					typeof params.limit === "number" ? params.limit : 20,
					100,
				));
				const runs = (await service.listRuns(100))
					.filter((run) => run.kind === "subagent")
					.filter((run) => params.include_terminal === true || !isTerminal(run.status))
					.slice(0, limit)
					.map(publicRun);
				return textResult(`${runs.length} Pro worker${runs.length === 1 ? "" : "s"}.`, { workers: runs });
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_conversation_close",
		label: "GPT Conversation Close",
		description: "Close one exactly-owned browser conversation locally; provider-side history is not deleted.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({ conversation_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const value = await service.closeConversation(String(params.conversation_id));
				return textResult(`Closed ${value.id} locally. Provider-side history was not deleted.`, {
					conversationId: value.id,
					closedAt: value.closedAt,
				});
			} catch (error) {
				return describeError(error);
			}
		},
	});
}

function registerDiagnostics(pi: ExtensionAPI, Type: TypeBuilder, service: GptControlService): void {
	pi.registerTool({
		name: "gpt_diagnose",
		label: "GPT Diagnose",
		description: "Passively report adapter discovery and trusted policy without executing any discovered program.",
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		parameters: Type.Object({}),
		execute: async () => {
			try {
				return textResult("GPT-Control passive diagnosis.", await service.diagnose());
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_diagnose_active",
		label: "GPT Active Smoke",
		description: "Actively probe the configured secure driver only when trusted operator policy explicitly permits it.",
		loadMode: "discoverable",
		approval: "exec",
		strict: true,
		parameters: Type.Object({}),
		execute: async () => {
			try {
				return textResult("GPT-Control active smoke test.", await service.activeSmokeTest());
			} catch (error) {
				return describeError(error);
			}
		},
	});
}

function commonParameters(Type: TypeBuilder): Record<string, Record<string, unknown>> {
	return {
		conversation_id: Type.Optional(Type.String({ description: "Wrapper-owned exact conversation id for a follow-up." })),
		files: Type.Optional(Type.Array(Type.String({ description: "Attachment path; trusted operator policy decides scope." }))),
		chatgpt_model: Type.Optional(Type.Literal("pro")),
		idempotency_key: Type.Optional(Type.String()),
		wait: Type.Optional(Type.Boolean({ description: "Default true. False returns durable ids while local monitoring continues." })),
		timeout_ms: Type.Optional(Type.Integer()),
	};
}

export function resolveOutputDir(value: unknown, _legacyAllowExternal?: unknown, root = GENERATED_ROOT): string {
	const canonicalRoot = resolve(root);
	if (typeof value !== "string" || value === "") return canonicalRoot;
	const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
	const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(canonicalRoot, expanded);
	if (absolute === canonicalRoot || absolute.startsWith(`${canonicalRoot}${sep}`)) return absolute;
	throw new Error(`${absolute} is outside trusted output root ${canonicalRoot}. Tool input cannot widen this boundary.`);
}
async function imageResult(
	exec: Exec,
	service: GptControlService,
	run: RunRecord,
	outputValue: unknown,
): Promise<ToolResult> {
	const outputDir = resolveOutputDir(outputValue, undefined, service.policy.outputRoot);
	await secureDirectory(outputDir);
	const content: Array<Record<string, unknown>> = [];
	const paths: string[] = [];
	for (const url of (run.artifactUrls ?? []).slice(0, 4)) {
		const suffix = createHash("sha256").update(url).digest("hex").slice(0, 12);
		const path = confinedPath(outputDir, `${run.id}-${suffix}.png`);
		const saved = await fetchArtifact(url, path);
		if (!saved.path) continue;
		paths.push(saved.path);
		content.push({
			type: "image",
			data: (await readFile(saved.path)).toString("base64"),
			mimeType: "image/png",
		});
	}
	if (paths.length === 0) {
		const conversation = await service.store.getConversation(run.conversationId);
		const capabilities = await resolveCapabilities(exec);
		if (
			conversation.provider === "browser"
			&& capabilities.browser
			&& conversation.browserDriverId === capabilities.browser.driver.id
			&& conversation.browserSessionId
			&& conversation.browserSessionName
			&& conversation.browserPageId !== undefined
		) {
			const expected = {
				sessionId: conversation.browserSessionId,
				name: conversation.browserSessionName,
				pageId: conversation.browserPageId,
			};
			const session = await assertExactDriverSession(capabilities.browser.driver, expected);
			const recordedIdentity = conversation.providerConversationUrl
				? providerConversationIdentity(conversation.providerConversationUrl)
				: undefined;
			const currentIdentity = providerConversationIdentity(session.url);
			if (!recordedIdentity || (currentIdentity && currentIdentity.url === recordedIdentity.url)) {
				const path = confinedPath(outputDir, `${run.id}.screenshot.png`);
				const screenshot = await capabilities.browser.driver.screenshot(session, path);
				if (screenshot) {
					paths.push(screenshot);
					content.push({
						type: "image",
						data: (await readFile(screenshot)).toString("base64"),
						mimeType: "image/png",
					});
				}
			}
		}
	}
	if (paths.length === 0) {
		return textResult(
			"The run completed, but no verified image artifact could be recovered.",
			publicRun(run),
			true,
		);
	}
	const persisted = await service.store.addArtifactPaths(run.id, paths);
	content.push({ type: "text", text: run.resultText || "Image ready." });
	const details = { ...publicRun(persisted), artifacts: paths };
	return { content, details, structuredContent: details };
}

export function publicRun(run: RunRecord): Record<string, unknown> {
	const attachment = (file: { relativePath: string; size: number; sha256: string; lineCount?: number }) => ({
		relativePath: file.relativePath,
		size: file.size,
		sha256: file.sha256,
		lineCount: file.lineCount,
	});
	return {
		runId: run.id,
		conversationId: run.conversationId,
		kind: run.kind,
		connectorIntent: run.connectorIntent,
		status: run.status,
		providerTurnPending: run.providerTurnPending,
		providerStopRequested: run.providerStopRequested,
		providerTurnAbandonedAt: run.providerTurnAbandonedAt,
		submissionState: run.submissionState,
		resultText: run.resultText,
		report: run.result,
		error: run.error,
		artifacts: run.artifactPaths ?? run.artifactUrls,
		diagnostics: run.diagnostics,
		receipt: { ...run.receipt, attachments: run.receipt.attachments.map(attachment) },
		manifest: {
			files: run.attachmentManifest.files.map(attachment),
			totalBytes: run.attachmentManifest.totalBytes,
			sha256: run.attachmentManifest.sha256,
			snapshotId: run.attachmentManifest.snapshotId,
		},
		createdAt: run.createdAt,
		completedAt: run.completedAt,
	};
}

function isTerminal(status: RunRecord["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "needs_user";
}

export { buildAttachmentManifest, isSensitive } from "./files";
export { REVIEW_OUTPUT_SCHEMA } from "./domain";
export { parseReviewReport } from "./review";
export { GptControlService } from "./service";
export { fallbackExec, resolveExec, resolveType } from "./host";
