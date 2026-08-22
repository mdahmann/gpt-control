import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ChatGptModel, Provider } from "./domain";

/**
 * Trusted authority established by the embedding operator, never by a model tool
 * call. Request fields may narrow this authority but cannot expand it.
 */
export interface OperatorPolicy {
	workspaceRoot: string;
	storageRoot: string;
	snapshotRoot: string;
	outputRoot: string;
	allowOutsideWorkspace: boolean;
	allowSensitiveFiles: boolean;
	allowedTransports: readonly Provider[];
	defaultChatGptModel: ChatGptModel;
	requireSecureBrowserInput: boolean;
	maxAttachmentFiles?: number;
	maxAttachmentBytes?: number;
	maxPromptBytes: number;
	maxConcurrentWorkers: number;
	allowActiveDiagnostics: boolean;
	providerTurnAbandonmentTokenHash?: string;
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
	defaultChatGptModel?: ChatGptModel;
	requireSecureBrowserInput?: boolean;
	maxAttachmentFiles?: number;
	maxAttachmentBytes?: number;
	maxPromptBytes?: number;
	maxConcurrentWorkers?: number;
	allowActiveDiagnostics?: boolean;
	providerTurnAbandonmentToken?: string;
}

export function operatorPolicyFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	overrides: OperatorPolicyInput = {},
): OperatorPolicy {
	const storageRoot = resolve(overrides.storageRoot ?? env.GPT_CONTROL_HOME ?? resolve(homedir(), ".gpt-control"));
	const allowedTransports = overrides.allowedTransports ?? parseTransports(env.GPT_CONTROL_ALLOWED_TRANSPORTS) ?? ["browser"];
	const workspaceRoot = resolve(overrides.workspaceRoot ?? env.GPT_CONTROL_WORKSPACE_ROOT ?? process.cwd());
	const abandonmentToken = overrides.providerTurnAbandonmentToken ?? env.GPT_CONTROL_PROVIDER_ABANDON_TOKEN;
	if (abandonmentToken !== undefined && abandonmentToken.length < 32) {
		throw new Error("GPT_CONTROL_PROVIDER_ABANDON_TOKEN must contain at least 32 characters.");
	}
	const value = {
		workspaceRoot,
		storageRoot,
		snapshotRoot: resolve(overrides.snapshotRoot ?? env.GPT_CONTROL_SNAPSHOT_ROOT ?? resolve(storageRoot, "snapshots")),
		outputRoot: resolve(overrides.outputRoot ?? env.GPT_CONTROL_OUTPUT_ROOT ?? resolve(storageRoot, "generated")),
		allowOutsideWorkspace: overrides.allowOutsideWorkspace ?? env.GPT_CONTROL_ALLOW_OUTSIDE_WORKSPACE === "1",
		allowSensitiveFiles: overrides.allowSensitiveFiles ?? env.GPT_CONTROL_ALLOW_SENSITIVE_FILES === "1",
		allowedTransports: [...new Set(allowedTransports)],
		defaultChatGptModel: overrides.defaultChatGptModel ?? "pro",
		requireSecureBrowserInput: overrides.requireSecureBrowserInput ?? env.GPT_CONTROL_REQUIRE_SECURE_BROWSER_INPUT !== "0",
		maxAttachmentFiles: boundedOptionalInteger(overrides.maxAttachmentFiles ?? numberFromEnv(env.GPT_CONTROL_MAX_ATTACHMENT_FILES), 1, 100, "maxAttachmentFiles"),
		maxAttachmentBytes: boundedOptionalInteger(overrides.maxAttachmentBytes ?? numberFromEnv(env.GPT_CONTROL_MAX_ATTACHMENT_BYTES), 1, 100 * 1024 * 1024, "maxAttachmentBytes"),
		maxPromptBytes: boundedInteger(overrides.maxPromptBytes ?? numberFromEnv(env.GPT_CONTROL_MAX_PROMPT_BYTES) ?? 1024 * 1024, 1, 8 * 1024 * 1024, "maxPromptBytes"),
		maxConcurrentWorkers: boundedInteger(overrides.maxConcurrentWorkers ?? numberFromEnv(env.GPT_CONTROL_MAX_PRO_WORKERS) ?? 6, 1, 10, "maxConcurrentWorkers"),
		allowActiveDiagnostics: overrides.allowActiveDiagnostics ?? env.GPT_CONTROL_ALLOW_ACTIVE_DIAGNOSTICS === "1",
		providerTurnAbandonmentTokenHash: abandonmentToken
			? createHash("sha256").update(abandonmentToken).digest("hex")
			: undefined,
	};
	return { ...value, fingerprint: policyFingerprint(value) };
}

export function assertTransportAllowed(policy: OperatorPolicy, provider: Provider): void {
	if (!policy.allowedTransports.includes(provider)) {
		throw new Error(`Transport ${provider} is not enabled by trusted operator policy.`);
	}
}

export function assertRequestedAuthority(
	policy: OperatorPolicy,
	request: { allowOutsideWorkspace?: boolean; allowSensitiveFiles?: boolean },
): void {
	if (request.allowOutsideWorkspace === true && !policy.allowOutsideWorkspace) {
		throw new Error("allow_outside_workspace cannot grant authority. Set trusted GPT_CONTROL_ALLOW_OUTSIDE_WORKSPACE=1 first.");
	}
	if (request.allowSensitiveFiles === true && !policy.allowSensitiveFiles) {
		throw new Error("allow_sensitive_files cannot grant authority. Set trusted GPT_CONTROL_ALLOW_SENSITIVE_FILES=1 first.");
	}
}

function numberFromEnv(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`Invalid numeric GPT-Control policy value: ${raw}`);
	return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`Trusted ${name} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value;
}

function boundedOptionalInteger(value: number | undefined, minimum: number, maximum: number, name: string): number | undefined {
	return value === undefined ? undefined : boundedInteger(value, minimum, maximum, name);
}

function parseTransports(raw: string | undefined): Provider[] | undefined {
	const values = raw?.split(",").map((value) => value.trim()).filter(Boolean);
	if (!values || values.length === 0) return undefined;
	for (const value of values) {
		if (value !== "browser") {
			throw new Error(
				`Transport ${value} is not supported. The hardened broker accepts only a protocol-v2 browser driver with secure stdin transport.`,
			);
		}
	}
	return ["browser"];
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
		defaultChatGptModel: value.defaultChatGptModel,
		requireSecureBrowserInput: value.requireSecureBrowserInput,
		maxAttachmentFiles: value.maxAttachmentFiles ?? null,
		maxAttachmentBytes: value.maxAttachmentBytes ?? null,
		maxPromptBytes: value.maxPromptBytes,
		maxConcurrentWorkers: value.maxConcurrentWorkers,
		allowActiveDiagnostics: value.allowActiveDiagnostics,
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
