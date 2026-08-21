import { Codex } from "@openai/codex-sdk";
import OpenAI from "openai";
import { dirname } from "node:path";
import { REVIEW_OUTPUT_SCHEMA, type AttachmentManifest, type Provider, type RunKind } from "./domain";
import { renderAttachments } from "./files";

export interface ProviderTurnRequest {
	kind: RunKind;
	prompt: string;
	manifest: AttachmentManifest;
	providerConversationId?: string;
	model?: string;
	signal?: AbortSignal;
}

export interface ProviderTurnResult {
	provider: Provider;
	text: string;
	providerConversationId?: string;
	providerRunId?: string;
	model?: string;
	transportVersion?: string;
	usage?: unknown;
	imageUrls?: string[];
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
	const codex = factory.create();
	const outsideDirectories = [...new Set(request.manifest.files
		.filter((file) => !file.path.startsWith(`${request.manifest.workspaceRoot}/`))
		.map((file) => dirname(file.path)))];
	const options = {
		workingDirectory: request.manifest.workspaceRoot,
		sandboxMode: "read-only" as const,
		approvalPolicy: "never" as const,
		skipGitRepoCheck: true,
		model: request.model,
		additionalDirectories: outsideDirectories.length === 0 ? undefined : outsideDirectories,
	};
	const thread = request.providerConversationId
		? codex.resumeThread(request.providerConversationId, options)
		: codex.startThread(options);
	const fileInstruction = request.manifest.files.length === 0
		? ""
		: `\n\nRead only these attachment paths for this request:\n${request.manifest.files.map((file) => `- ${file.path}`).join("\n")}`;
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
		text: result.finalResponse,
		providerConversationId: thread.id,
		providerRunId,
		model: request.model,
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
	client: ResponsesClient = new OpenAI() as unknown as ResponsesClient,
): Promise<ProviderTurnResult> {
	const model = request.model ?? process.env.GPT_CONTROL_RESPONSES_MODEL ?? "gpt-5.6";
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
	const response = await client.responses.create(body, { signal: request.signal });
	if (response.output_text.trim() === "") throw new Error("Responses API returned an empty response.");
	return {
		provider: "responses",
		text: response.output_text,
		providerConversationId: response.id,
		providerRunId: response.id,
		model: response.model ?? model,
		transportVersion: "openai@7.5.0",
		usage: response.usage,
	};
}
