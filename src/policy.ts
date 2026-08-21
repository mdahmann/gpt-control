import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ChatGptModel, Provider, RunKind } from "./domain";

export const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_RESPONSES_MODEL = "gpt-5.6";

export interface PaidRequestContext {
	provider: "responses";
	conversationId: string;
	runId: string;
	kind: RunKind;
	followup: boolean;
	model?: string;
	endpoint: string;
}

export type PaidRequestConfirmer = (context: PaidRequestContext) => Promise<boolean>;

/**
 * Trusted authority established by the embedding operator, never from a model
 * tool call. Requests may choose only values already allowed here.
 */
export interface OperatorPolicy {
	workspaceRoot: string;
	storageRoot: string;
	snapshotRoot: string;
	outputRoot: string;
	allowOutsideWorkspace: boolean;
	allowSensitiveFiles: boolean;
	allowedTransports: readonly Provider[];
	allowedProviderModels?: readonly string[];
	defaultProviderModel?: string;
	defaultChatGptModel: ChatGptModel;
	openAIBaseUrl: string;
	allowAlternateOpenAIEndpoint: boolean;
	confirmPaidRequest?: PaidRequestConfirmer;
	maxAttachmentFiles?: number;
	maxAttachmentBytes?: number;
	maxConcurrentWorkers: number;
	allowActiveDiagnostics: boolean;
	fingerprint: string;
}

export interface OperatorPolicyInput {
	workspaceRoot?: string;
	storageRoot?: string;
	snapshotRoot?: string;
	outputRoot?: string;
	allowOutsideWorkspace?: boolean;
	allowSensitiveFiles?: boolean;
	allowedTransports?: readonly Provider[];
	allowedProviderModels?: readonly string[];
	defaultProviderModel?: string;
	defaultChatGptModel?: ChatGptModel;
	openAIBaseUrl?: string;
	allowAlternateOpenAIEndpoint?: boolean;
	confirmPaidRequest?: PaidRequestConfirmer;
	maxAttachmentFiles?: number;
	maxAttachmentBytes?: number;
	maxConcurrentWorkers?: number;
	allowActiveDiagnostics?: boolean;
}

export function operatorPolicyFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	overrides: OperatorPolicyInput = {},
): OperatorPolicy {
	const storageRoot = resolve(overrides.storageRoot ?? env.GPT_CONTROL_HOME ?? resolve(homedir(), ".gpt-control"));
	const allowedTransports = overrides.allowedTransports ?? parseTransports(env.GPT_CONTROL_ALLOWED_TRANSPORTS) ?? ["chrome_bridge", "codex"];
	const allowedProviderModels = overrides.allowedProviderModels ?? parseList(env.GPT_CONTROL_ALLOWED_MODELS);
	const defaultProviderModel = cleanOptional(overrides.defaultProviderModel ?? env.GPT_CONTROL_PROVIDER_MODEL);
	const endpoint = normalizeEndpoint(overrides.openAIBaseUrl ?? env.GPT_CONTROL_OPENAI_BASE_URL ?? OFFICIAL_OPENAI_BASE_URL);
	const allowAlternateOpenAIEndpoint = overrides.allowAlternateOpenAIEndpoint
		?? env.GPT_CONTROL_ALLOW_ALTERNATE_OPENAI_ENDPOINT === "1";
	if (endpoint !== OFFICIAL_OPENAI_BASE_URL && !allowAlternateOpenAIEndpoint) {
		throw new Error(
			`Refused alternate OpenAI endpoint ${endpoint}. Configure it through trusted operator policy and set allowAlternateOpenAIEndpoint=true.`,
		);
	}
	for (const provider of allowedTransports) {
		if (provider === "oracle_browser" || provider === "oracle_api") {
			throw new Error(
				"Oracle transport is disabled in the hardened broker because its legacy CLI exposes prompt or attachment data through child-process argv.",
			);
		}
	}
	const workspaceRoot = resolve(overrides.workspaceRoot ?? env.GPT_CONTROL_WORKSPACE_ROOT ?? process.cwd());
	const value = {
		workspaceRoot,
		storageRoot,
		snapshotRoot: resolve(overrides.snapshotRoot ?? env.GPT_CONTROL_SNAPSHOT_ROOT ?? resolve(storageRoot, "snapshots")),
		outputRoot: resolve(overrides.outputRoot ?? env.GPT_CONTROL_OUTPUT_ROOT ?? resolve(storageRoot, "generated")),
		allowOutsideWorkspace: overrides.allowOutsideWorkspace ?? env.GPT_CONTROL_ALLOW_OUTSIDE_WORKSPACE === "1",
		allowSensitiveFiles: overrides.allowSensitiveFiles ?? env.GPT_CONTROL_ALLOW_SENSITIVE_FILES === "1",
		allowedTransports: [...new Set(allowedTransports)],
		allowedProviderModels: allowedProviderModels ? [...new Set(allowedProviderModels)] : undefined,
		defaultProviderModel,
		defaultChatGptModel: overrides.defaultChatGptModel ?? "pro",
		openAIBaseUrl: endpoint,
		allowAlternateOpenAIEndpoint,
		confirmPaidRequest: overrides.confirmPaidRequest,
		maxAttachmentFiles: overrides.maxAttachmentFiles,
		maxAttachmentBytes: overrides.maxAttachmentBytes,
		maxConcurrentWorkers: boundedWorkers(overrides.maxConcurrentWorkers ?? Number(env.GPT_CONTROL_MAX_PRO_WORKERS || 3)),
		allowActiveDiagnostics: overrides.allowActiveDiagnostics ?? env.GPT_CONTROL_ALLOW_ACTIVE_DIAGNOSTICS === "1",
	};
	return { ...value, fingerprint: policyFingerprint(value) };
}

export function assertTransportAllowed(policy: OperatorPolicy, provider: Provider): void {
	if (!policy.allowedTransports.includes(provider)) {
		throw new Error(`Transport ${provider} is not enabled by trusted operator policy.`);
	}
}

export function resolveTrustedProviderModel(
	policy: OperatorPolicy,
	provider: Provider,
	requestedModel: string | undefined,
): string | undefined {
	const implicitTrustedDefault = provider === "responses" ? DEFAULT_RESPONSES_MODEL : undefined;
	const effective = requestedModel ?? policy.defaultProviderModel ?? implicitTrustedDefault;
	if (requestedModel !== undefined) {
		const trusted = requestedModel === policy.defaultProviderModel
			|| requestedModel === implicitTrustedDefault
			|| policy.allowedProviderModels?.includes(requestedModel) === true;
		if (!trusted) {
			throw new Error(
				`Model ${requestedModel} is not in trusted operator policy. Tool requests may narrow authority, but cannot authorize a new provider model.`,
			);
		}
	}
	if (effective === undefined && policy.allowedProviderModels && policy.allowedProviderModels.length > 0) {
		throw new Error(
			"Trusted operator policy restricts provider models, but no trusted default or requested allowlisted model was selected.",
		);
	}
	if (effective !== undefined && policy.defaultProviderModel !== effective && effective !== implicitTrustedDefault
		&& policy.allowedProviderModels?.includes(effective) !== true) {
		throw new Error(`Effective model ${effective} is outside trusted operator policy.`);
	}
	if (implicitTrustedDefault !== undefined && effective === implicitTrustedDefault && policy.allowedProviderModels
		&& !policy.allowedProviderModels.includes(implicitTrustedDefault) && policy.defaultProviderModel !== effective) {
		throw new Error(
			`The trusted model allowlist excludes the broker default ${effective}; select an allowlisted model through trusted policy or request input.`,
		);
	}
	return effective;
}

/** @deprecated Use resolveTrustedProviderModel so defaults are authorized and pinned. */
export function assertProviderModelAllowed(policy: OperatorPolicy, model: string | undefined): void {
	void resolveTrustedProviderModel(policy, "codex", model);
}

function normalizeEndpoint(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid OpenAI base URL in trusted operator policy: ${raw}`);
	}
	if (url.protocol !== "https:") throw new Error("OpenAI base URL must use HTTPS.");
	return url.href.replace(/\/$/, "");
}

function cleanOptional(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	return value ? value : undefined;
}

function parseList(raw: string | undefined): string[] | undefined {
	const values = raw?.split(",").map((value) => value.trim()).filter(Boolean);
	return values && values.length > 0 ? values : undefined;
}

function parseTransports(raw: string | undefined): Provider[] | undefined {
	const values = parseList(raw);
	if (!values) return undefined;
	const valid = new Set<Provider>(["chrome_bridge", "codex", "responses", "oracle_browser", "oracle_api"]);
	for (const value of values) {
		if (!valid.has(value as Provider)) throw new Error(`Unknown transport in GPT_CONTROL_ALLOWED_TRANSPORTS: ${value}`);
	}
	return values as Provider[];
}

function boundedWorkers(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 3) throw new Error("Trusted maxConcurrentWorkers must be an integer from 1 to 3.");
	return value;
}

function policyFingerprint(value: Omit<OperatorPolicy, "fingerprint">): string {
	const stable = {
		workspaceRoot: value.workspaceRoot,
		storageRoot: value.storageRoot,
		snapshotRoot: value.snapshotRoot,
		outputRoot: value.outputRoot,
		allowOutsideWorkspace: value.allowOutsideWorkspace,
		allowSensitiveFiles: value.allowSensitiveFiles,
		allowedTransports: [...value.allowedTransports].sort(),
		allowedProviderModels: value.allowedProviderModels ? [...value.allowedProviderModels].sort() : null,
		defaultProviderModel: value.defaultProviderModel ?? null,
		defaultChatGptModel: value.defaultChatGptModel,
		openAIBaseUrl: value.openAIBaseUrl,
		allowAlternateOpenAIEndpoint: value.allowAlternateOpenAIEndpoint,
		paidConfirmationConfigured: typeof value.confirmPaidRequest === "function",
		maxAttachmentFiles: value.maxAttachmentFiles ?? null,
		maxAttachmentBytes: value.maxAttachmentBytes ?? null,
		maxConcurrentWorkers: value.maxConcurrentWorkers,
		allowActiveDiagnostics: value.allowActiveDiagnostics,
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
