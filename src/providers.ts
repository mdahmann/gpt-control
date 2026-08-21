import { Codex } from "@openai/codex-sdk";
import OpenAI from "openai";
import { REVIEW_OUTPUT_SCHEMA, nowIso, type AttachmentManifest, type ModelEvidenceKind, type Provider, type RecoveryAttempt, type RunKind } from "./domain";
import { renderAttachments } from "./files";
import { DEFAULT_RESPONSES_MODEL, OFFICIAL_OPENAI_BASE_URL } from "./policy";

export interface ProviderTurnRequest {
	kind: RunKind;
	prompt: string;
	manifest: AttachmentManifest;
	providerConversationId?: string;
	model?: string;
	providerEndpoint?: string;
	signal?: AbortSignal;
}

export interface ProviderTurnResult {
	provider: Provider;
	terminalStatus?: "completed" | "needs_user";
	terminalReason?: string;
	text: string;
	providerConversationId?: string;
	providerConversationUrl?: string;
	providerRunId?: string;
	observedModel?: string;
	modelVerified?: boolean;
	modelEvidenceKind?: ModelEvidenceKind;
	modelVerifiedAt?: string;
	transportVersion?: string;
	providerEndpoint?: string;
	usage?: unknown;
	imageUrls?: string[];
	localAssistantTurnCount?: number;
	recoveryAttempts?: RecoveryAttempt[];
	lastObservedUrl?: string;
	lastObservedUiState?: string;
}

export interface CodexThreadLike {
	readonly id: string | null;
	run(input: string, options?: { outputSchema?: unknown; signal?: AbortSignal }): Promise<{
		items: Array<{ id: string; type: string }>;
		finalResponse: string;
		usage: unknown;
	}>;
}

export interface CodexLike {
	startThread(options?: Record<string, unknown>): CodexThreadLike;
	resumeThread(id: string, options?: Record<string, unknown>): CodexThreadLike;
}

export interface CodexFactory {
	create(): CodexLike;
}

const defaultCodexFactory: CodexFactory = {
	create: () => new Codex(),
};

export async function runCodexTurn(
	request: ProviderTurnRequest,
	factory: CodexFactory = defaultCodexFactory,
): Promise<ProviderTurnResult> {
	const snapshotRoot = request.manifest.snapshotRoot;
	if (!snapshotRoot) throw new Error("Codex requires a broker-owned attachment snapshot root.");
	const codex = factory.create();
	const options = {
		workingDirectory: snapshotRoot,
		sandboxMode: "read-only" as const,
		approvalPolicy: "never" as const,
		skipGitRepoCheck: true,
		model: request.model,
	};
	const thread = request.providerConversationId
		? codex.resumeThread(request.providerConversationId, options)
		: codex.startThread(options);
	const fileInstruction = request.manifest.files.length === 0
		? ""
		: [
			"",
			"The current working directory is an immutable broker-owned snapshot containing only the approved request files.",
			"Read only these relative snapshot filenames:",
			...request.manifest.files.map((file) => `- ${file.relativePath}`),
		].join("\n");
	const result = await thread.run(`${request.prompt}${fileInstruction}`, {
		signal: request.signal,
		outputSchema: request.kind === "consult" ? REVIEW_OUTPUT_SCHEMA : undefined,
	});
	if (!thread.id) throw new Error("Codex completed without returning a thread id.");
	if (result.finalResponse.trim() === "") throw new Error("Codex returned an empty response.");
	const agentMessages = result.items.filter((item) => item.type === "agent_message");
	const providerRunId = agentMessages.length === 0 ? undefined : agentMessages[agentMessages.length - 1].id;
	return {
		provider: "codex",
		terminalStatus: "completed",
		text: result.finalResponse,
		providerConversationId: thread.id,
		providerRunId,
		// The SDK does not currently return an observed model on this path.
		modelVerified: false,
		transportVersion: "@openai/codex-sdk@0.149.0",
		usage: result.usage,
	};
}

export interface ResponsesClient {
	responses: {
		create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{
			id: string;
			model?: string;
			output_text: string;
			usage?: unknown;
		}>;
	};
}

export async function runResponsesTurn(
	request: ProviderTurnRequest,
	client?: ResponsesClient,
): Promise<ProviderTurnResult> {
	const model = request.model ?? DEFAULT_RESPONSES_MODEL;
	const providerEndpoint = normalizeEndpoint(request.providerEndpoint ?? OFFICIAL_OPENAI_BASE_URL);
	const actualClient = client ?? new OpenAI({ baseURL: providerEndpoint }) as unknown as ResponsesClient;
	const attachments = await renderAttachments(request.manifest);
	const body: Record<string, unknown> = {
		model,
		input: `${request.prompt}${attachments}`,
		store: true,
		...(request.providerConversationId ? { previous_response_id: request.providerConversationId } : {}),
	};
	if (request.kind === "consult") {
		body.text = {
			format: {
				type: "json_schema",
				name: "gpt_control_review",
				description: "Structured independent code review findings",
				schema: REVIEW_OUTPUT_SCHEMA,
				strict: true,
			},
		};
	}
	const response = await actualClient.responses.create(body, { signal: request.signal });
	if (response.output_text.trim() === "") throw new Error("Responses API returned an empty response.");
	const observedModel = response.model;
	return {
		provider: "responses",
		terminalStatus: "completed",
		text: response.output_text,
		providerConversationId: response.id,
		providerRunId: response.id,
		observedModel,
		modelVerified: Boolean(observedModel),
		modelEvidenceKind: observedModel ? "provider_response" : undefined,
		modelVerifiedAt: observedModel ? nowIso() : undefined,
		transportVersion: "openai@7.5.0",
		providerEndpoint,
		usage: response.usage,
	};
}

function normalizeEndpoint(raw: string): string {
	const url = new URL(raw);
	if (url.protocol !== "https:") throw new Error("Responses endpoint must use HTTPS.");
	return url.href.replace(/\/$/, "");
}
