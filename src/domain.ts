import { randomUUID } from "node:crypto";

export const PACKAGE_NAME = "gpt-control";
export const PACKAGE_VERSION = "0.3.0";
export const STORAGE_VERSION = 2;

export type Provider = "browser" | "oracle_browser" | "oracle_api";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "needs_user";
export type RunKind = "consult" | "chat" | "image";
export type Verdict = "approve" | "request_changes" | "inconclusive";
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface AttachmentReceipt {
	path: string;
	relativePath: string;
	size: number;
	sha256: string;
}

export interface AttachmentManifest {
	workspaceRoot: string;
	files: AttachmentReceipt[];
	totalBytes: number;
	sha256: string;
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

export interface ReviewReceipt {
	provider: Provider;
	model?: string;
	transportVersion?: string;
	promptSha256: string;
	attachments: AttachmentReceipt[];
	resultSha256?: string;
	startedAt: string;
	completedAt?: string;
	conversationId: string;
	runId: string;
	providerConversationId?: string;
	providerRunId?: string;
}

export interface ConversationRecord {
	version: typeof STORAGE_VERSION;
	id: string;
	provider: Provider;
	providerConversationId?: string;
	browserDriverId?: string;
	browserSessionId?: string;
	browserPageId?: string | number;
	workspaceRoot: string;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
}

export interface RunRecord {
	version: typeof STORAGE_VERSION;
	id: string;
	conversationId: string;
	kind: RunKind;
	status: RunStatus;
	promptSha256: string;
	attachmentManifest: AttachmentManifest;
	baselineMessageCount?: number;
	providerRunId?: string;
	resultMessageId?: string;
	resultText?: string;
	result?: ReviewReport;
	artifactUrls?: string[];
	artifactPaths?: string[];
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

export function opaqueId(prefix: "conv" | "run"): string {
	return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}
