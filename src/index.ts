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
		chatgptModel: typeof params.chatgpt_model === "string" ? params.chatgpt_model : "pro",
		chatgptEffort: typeof params.chatgpt_effort === "string" ? params.chatgpt_effort : undefined,
		pinChat: params.pin_chat === true,
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
	registerCatalogTools(pi, Type, service);

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
	registerWorkerStart(pi, Type, service);
	registerRunTools(pi, Type, service);
	registerDiagnostics(pi, Type, service);
}

function registerCatalogTools(pi: ExtensionAPI, Type: TypeBuilder, service: GptControlService): void {
	pi.registerTool({
		name: "gpt_models",
		label: "GPT Models",
		description: "Read the live ChatGPT model and effort choices. No prompt is sent and the temporary owned tab is closed.",
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		parameters: Type.Object({}),
		execute: async () => {
			try {
				const catalog = await service.listModels();
				return textResult("Live ChatGPT model catalog.", catalog);
			} catch (error) {
				return describeError(error);
			}
		},
	});
	pi.registerTool({
		name: "gpt_projects",
		label: "GPT Projects",
		description: "Read the live ChatGPT project names. No prompt is sent and the temporary owned tab is closed.",
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		parameters: Type.Object({}),
		execute: async () => {
			try {
				const catalog = await service.listProjects();
				return textResult("Live ChatGPT project catalog.", catalog);
			} catch (error) {
				return describeError(error);
			}
		},
	});
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

function registerWorkerStart(pi: ExtensionAPI, Type: TypeBuilder, service: GptControlService): void {
	pi.registerTool({
		name: "gpt_worker_run",
		label: "GPT Worker",
		description: "Run one independent bounded ChatGPT worker in the background. The live model and effort can be selected for each worker.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({
			prompt: Type.String(),
			files: Type.Optional(Type.Array(Type.String())),
			idempotency_key: Type.String(),
			chatgpt_model: Type.Optional(Type.String({ description: "Exact label from gpt_models, such as GPT-5.6 Sol." })),
			chatgpt_effort: Type.Optional(Type.String({ description: "Exact effort label from gpt_models, such as High or Pro." })),
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
		name: "gpt_worker_get",
		label: "GPT Worker Get",
		description: "One durable recovery lookup for a GPT Worker after reconnect or uncertainty.",
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		parameters: Type.Object({ run_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const run = await service.getRun(String(params.run_id));
				if (run.kind !== "subagent") throw new Error("Run is not a GPT Worker.");
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
		name: "gpt_worker_cancel",
		label: "GPT Worker Cancel",
		description: "Durably cancel one independent GPT Worker by run id.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({ run_id: Type.String() }),
		execute: async (_id, params) => {
			try {
				const current = await service.getRun(String(params.run_id));
				if (current.kind !== "subagent") throw new Error("Run is not a GPT Worker.");
				const run = await service.cancelRun(current.id);
				return textResult(runText(run), publicRun(run));
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_worker_list",
		label: "GPT Workers",
		description: "Bounded durable overview of GPT Workers for reconnect recovery, not a polling protocol.",
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
				return textResult(`${runs.length} GPT Worker${runs.length === 1 ? "" : "s"}.`, { workers: runs });
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "gpt_conversation_attach",
		label: "GPT Conversation Attach",
		description: "Attach an exact existing ChatGPT conversation in a new GPT-Control-owned background tab. This does not send a message or adopt a foreground tab.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({
			conversation_url: Type.Optional(Type.String()),
			provider_conversation_id: Type.Optional(Type.String()),
			timeout_ms: Type.Optional(Type.Integer()),
		}),
		execute: async (_id, params) => {
			try {
				const value = await service.attachConversation({
					conversationUrl: typeof params.conversation_url === "string" ? params.conversation_url : undefined,
					providerConversationId: typeof params.provider_conversation_id === "string" ? params.provider_conversation_id : undefined,
					timeoutMs: typeof params.timeout_ms === "number" ? params.timeout_ms : undefined,
				});
				return textResult(`Attached existing ChatGPT conversation ${value.providerConversationId}.`, {
					conversationId: value.id,
					providerConversationId: value.providerConversationId,
					providerConversationUrl: value.providerConversationUrl,
					localAssistantTurnCount: value.browserAssistantTurnCount,
				});
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

	pi.registerTool({
		name: "gpt_conversation_manage",
		label: "GPT Conversation Manage",
		description: "Pin, unpin, rename, move, or archive one exact GPT-Control-owned ChatGPT conversation with live read-back.",
		loadMode: "discoverable",
		approval: "write",
		strict: true,
		parameters: Type.Object({
			conversation_id: Type.String(),
			action: Type.Union([Type.Literal("pin"), Type.Literal("unpin"), Type.Literal("rename"), Type.Literal("move"), Type.Literal("archive")]),
			title: Type.Optional(Type.String()),
			project: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			try {
				const action = String(params.action);
				const operation = action === "rename"
					? { action: "rename" as const, title: String(params.title ?? "") }
					: action === "move"
						? { action: "move" as const, project: String(params.project ?? "") }
						: { action: action as "pin" | "unpin" | "archive" };
				const result = await service.manageConversation(String(params.conversation_id), operation);
				return textResult(`ChatGPT conversation ${params.conversation_id} ${action} verified.`, {
					conversationId: params.conversation_id,
					action,
					...result,
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
		chatgpt_model: Type.Optional(Type.String({ description: "Exact live model label. Call gpt_models to discover current choices. Legacy value pro selects the Pro preset." })),
		chatgpt_effort: Type.Optional(Type.String({ description: "Exact live effort label, such as High. Call gpt_models to discover current choices." })),
		pin_chat: Type.Optional(Type.Boolean({ description: "Pin the exact provider conversation after its first message is submitted and identified." })),
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
