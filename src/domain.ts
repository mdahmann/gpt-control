import { randomUUID } from "node:crypto";

export const PACKAGE_NAME = "gpt-control";
export const PACKAGE_VERSION = "0.4.3";
export const STORAGE_VERSION = 3;

export type Provider = "browser";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "needs_user";
export type RunKind = "consult" | "chat" | "image" | "subagent";
export type SubmissionState = "not_submitted" | "submitting" | "submitted" | "not_applicable";
export type Verdict = "approve" | "request_changes" | "inconclusive";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
/** Exact live picker label. The legacy value `pro` means the Pro effort preset. */
export type ChatGptModel = string;
export type ChatGptEffort = string;
export type ModelEvidenceKind = "composer_selector" | "provider_response" | "provider_sdk";
export type BrowserPageId = string | number;

export interface ConnectorIntent {
	names: string[];
	mode: "prefer" | "require";
}

export interface ConnectorToolCardReceipt {
	label: string;
	sha256: string;
}

export interface ConnectorPreflightReceipt {
	status: "required" | "submitting" | "submitted" | "passed" | "failed";
	baselineMessageCount?: number;
	providerUserMessageId?: string;
	responseSha256?: string;
	evidenceKind?: "assistant_reported_preflight" | "browser_tool_card";
	toolCards?: ConnectorToolCardReceipt[];
	verifiedAt?: string;
	error?: string;
}

export interface AttachmentReceipt {
	/** Immutable broker-owned snapshot transmitted to the provider. */
	path: string;
	/** Stable display name used in prompts and structured findings. */
	relativePath: string;
	size: number;
	sha256: string;
	/** Byte-derived physical line count used to validate structured evidence. */
	lineCount?: number;
}

export interface AttachmentManifest {
	workspaceRoot: string;
	files: AttachmentReceipt[];
	totalBytes: number;
	sha256: string;
	/** Private broker-owned directory containing only immutable snapshots. */
	snapshotRoot?: string;
	snapshotId?: string;
}

export interface FindingLocation {
	file: string;
	lineStart: number;
	lineEnd: number;
}

export interface ReviewFinding {
	severity: Severity;
	claim: string;
	evidence: FindingLocation;
	confidence: number;
	remediation: string;
}

export interface ReviewReport {
	verdict: Verdict;
	summary: string;
	findings: ReviewFinding[];
	openQuestions: string[];
}

export interface RecoveryAttempt {
	at: string;
	action: "reobserve" | "reload" | "restore_conversation_url" | "dismiss_rate_limit" | "retry" | "continue" | "stop";
	reason: string;
	outcome: "recovered" | "still_active" | "failed" | "not_applicable";
	detail?: string;
}

export interface RunDiagnostics {
	recoveryAttempts?: RecoveryAttempt[];
	terminalReason?: string;
	localAssistantTurnCount?: number;
	lastObservedUrl?: string;
	lastObservedUiState?: string;
	organizationWarnings?: string[];
	rateLimitEvents?: number;
	lastRateLimitAt?: string;
	providerCooldownUntil?: string;
	providerConcurrencyLimit?: number;
}

export interface ReviewReceipt {
	provider: Provider;
	/** Legacy-compatible observed model field. Never populated from a request alone. */
	model?: string;
	requestedModel?: string;
	observedModel?: string;
	requestedEffort?: string;
	observedEffort?: string;
	modelVerified?: boolean;
	modelEvidenceKind?: ModelEvidenceKind;
	modelVerifiedAt?: string;
	requestedTitle?: string;
	observedTitle?: string;
	titleVerified?: boolean;
	titleVerifiedAt?: string;
	browserDriverId?: string;
	transportVersion?: string;
	providerEndpoint?: string;
	promptSha256: string;
	attachments: AttachmentReceipt[];
	resultSha256?: string;
	startedAt: string;
	completedAt?: string;
	conversationId: string;
	runId: string;
	/** Real provider identity only; local driver/session ids have separate fields. */
	providerConversationId?: string;
	providerConversationUrl?: string;
	providerRunId?: string;
	localBrowserSessionId?: string;
	localAssistantTurnCount?: number;
	recoveryAttempts?: RecoveryAttempt[];
}

export interface ConversationRecord {
	version: typeof STORAGE_VERSION;
	id: string;
	provider: Provider;
	providerConversationId?: string;
	providerConversationUrl?: string;
	/** Exact local browser-driver identity and ownership tuple. */
	browserDriverId?: string;
	browserSessionId?: string;
	browserSessionName?: string;
	browserPageId?: BrowserPageId;
	browserAssistantTurnCount?: number;
	providerPinned?: boolean;
	providerTitle?: string;
	providerProject?: string;
	providerArchivedAt?: string;
	workspaceRoot: string;
	policyFingerprint?: string;
	/** Durable owner for resources created through a multiplexed MCP session. */
	mcpSessionId?: string;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
}

export interface RunRecord {
	version: typeof STORAGE_VERSION;
	id: string;
	conversationId: string;
	kind: RunKind;
	connectorIntent?: ConnectorIntent;
	connectorPreflight?: ConnectorPreflightReceipt;
	status: RunStatus;
	executionReady: boolean;
	/** True until the exact submitted provider turn is final or proved stopped. */
	providerTurnPending?: boolean;
	/** Durable intent to stop a pending exact provider turn. */
	providerStopRequested?: boolean;
	providerTurnAbandonedAt?: string;
	providerUserMessageId?: string;
	promptSha256: string;
	promptObservationSha256?: string;
	promptProofToken?: string;
	attachmentManifest: AttachmentManifest;
	baselineMessageCount?: number;
	submissionState?: SubmissionState;
	requestedChatGptModel?: ChatGptModel;
	requestedChatGptEffort?: ChatGptEffort;
	requestedProviderTitle?: string;
	pinChatRequested?: boolean;
	timeoutMs?: number;
	deadlineAt?: string;
	idempotencyKeyHash?: string;
	idempotencyRequestHash?: string;
	mcpTaskId?: string;
	cancellationRequestedAt?: string;
	providerRunId?: string;
	resultMessageId?: string;
	resultText?: string;
	result?: ReviewReport;
	artifactUrls?: string[];
	artifactPaths?: string[];
	diagnostics?: RunDiagnostics;
	receipt: ReviewReceipt;
	error?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export const REVIEW_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["verdict", "summary", "findings", "openQuestions"],
	properties: {
		verdict: { type: "string", enum: ["approve", "request_changes", "inconclusive"] },
		summary: { type: "string", minLength: 1 },
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["severity", "claim", "evidence", "confidence", "remediation"],
				properties: {
					severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
					claim: { type: "string", minLength: 1 },
					evidence: {
						type: "object",
						additionalProperties: false,
						required: ["file", "lineStart", "lineEnd"],
						properties: {
							file: { type: "string", minLength: 1 },
							lineStart: { type: "integer", minimum: 1 },
							lineEnd: { type: "integer", minimum: 1 },
						},
					},
					confidence: { type: "number", minimum: 0, maximum: 1 },
					remediation: { type: "string", minLength: 1 },
				},
			},
		},
		openQuestions: { type: "array", items: { type: "string" } },
	},
} as const;

export const CONVERSATION_ID_PATTERN = /^conv_[a-f0-9]{32}$/;
export const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;
export const TASK_ID_PATTERN = /^task_[a-f0-9]{32}$/;

export function opaqueId(prefix: "conv" | "run" | "task" | "proof"): string {
	return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}
