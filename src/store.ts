import { constants } from "node:fs";
import { hostname, homedir, platform } from "node:os";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	CONVERSATION_ID_PATTERN,
	RUN_ID_PATTERN,
	TASK_ID_PATTERN,
	STORAGE_VERSION,
	nowIso,
	type ConversationRecord,
	type RunRecord,
	type RunStatus,
	type ChatGptModel,
	type RunKind,
} from "./domain";

const ProviderSchema = z.literal("browser");
const McpSessionIdSchema = z.string().min(1).max(512);
const RunStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "needs_user"]);
const RecoverySchema = z.object({
	at: z.string(),
	action: z.enum(["reobserve", "reload", "restore_conversation_url", "dismiss_rate_limit", "retry", "continue", "stop"]),
	reason: z.string(),
	outcome: z.enum(["recovered", "still_active", "failed", "not_applicable"]),
	detail: z.string().optional(),
});
const AttachmentSchema = z.object({
	path: z.string(),
	relativePath: z.string(),
	size: z.number(),
	sha256: z.string(),
	lineCount: z.number().int().nonnegative().optional(),
});
const ManifestSchema = z.object({
	workspaceRoot: z.string(),
	files: z.array(AttachmentSchema),
	totalBytes: z.number(),
	sha256: z.string(),
	snapshotRoot: z.string().optional(),
	snapshotId: z.string().optional(),
});
const ReceiptSchema = z.object({
	provider: ProviderSchema,
	model: z.string().optional(),
	requestedModel: z.string().optional(),
	observedModel: z.string().optional(),
	requestedEffort: z.string().optional(),
	observedEffort: z.string().optional(),
	modelVerified: z.boolean().optional(),
	modelEvidenceKind: z.enum(["composer_selector", "provider_response", "provider_sdk"]).optional(),
	modelVerifiedAt: z.string().optional(),
	requestedTitle: z.string().min(1).max(128).optional(),
	observedTitle: z.string().min(1).max(128).optional(),
	titleVerified: z.boolean().optional(),
	titleVerifiedAt: z.string().optional(),
	transportVersion: z.string().optional(),
	providerEndpoint: z.string().optional(),
	browserDriverId: z.string().optional(),
	promptSha256: z.string(),
	attachments: z.array(AttachmentSchema),
	resultSha256: z.string().optional(),
	startedAt: z.string(),
	completedAt: z.string().optional(),
	conversationId: z.string(),
	runId: z.string(),
	providerConversationId: z.string().optional(),
	providerConversationUrl: z.string().optional(),
	providerRunId: z.string().optional(),
	localBrowserSessionId: z.string().optional(),
	localAssistantTurnCount: z.number().int().nonnegative().optional(),
	recoveryAttempts: z.array(RecoverySchema).optional(),
});
const ConversationSchema = z.object({
	version: z.literal(STORAGE_VERSION),
	id: z.string().regex(CONVERSATION_ID_PATTERN),
	provider: ProviderSchema,
	providerConversationId: z.string().optional(),
	providerConversationUrl: z.string().optional(),
	browserDriverId: z.string().optional(),
	browserSessionId: z.string().optional(),
	browserSessionName: z.string().optional(),
	browserPageId: z.union([z.string(), z.number()]).optional(),
	browserAssistantTurnCount: z.number().int().nonnegative().optional(),
	providerPinned: z.boolean().optional(),
	providerTitle: z.string().optional(),
	providerProject: z.string().optional(),
	providerArchivedAt: z.string().optional(),
	workspaceRoot: z.string(),
	policyFingerprint: z.string().optional(),
	mcpSessionId: McpSessionIdSchema.optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	closedAt: z.string().optional(),
});
const RunSchema = z.object({
	version: z.literal(STORAGE_VERSION),
	id: z.string().regex(RUN_ID_PATTERN),
	conversationId: z.string().regex(CONVERSATION_ID_PATTERN),
	kind: z.enum(["consult", "chat", "image", "subagent"]),
	connectorIntent: z.object({ names: z.array(z.string()), mode: z.enum(["prefer", "require"]) }).optional(),
	connectorPreflight: z.object({
		status: z.enum(["required", "submitting", "submitted", "passed", "failed"]),
		baselineMessageCount: z.number().int().nonnegative().optional(),
		providerUserMessageId: z.string().min(1).max(512).optional(),
		responseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
		evidenceKind: z.enum(["assistant_reported_preflight", "browser_tool_card"]).optional(),
		toolCards: z.array(z.object({ label: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(32).optional(),
		verifiedAt: z.string().optional(),
		error: z.string().optional(),
	}).optional(),
	status: RunStatusSchema,
	executionReady: z.boolean(),
	providerTurnPending: z.boolean().optional(),
	providerStopRequested: z.boolean().optional(),
	providerTurnAbandonedAt: z.string().optional(),
	providerUserMessageId: z.string().min(1).max(512).optional(),
	promptSha256: z.string(),
	promptObservationSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	promptProofToken: z.string().regex(/^proof_[a-f0-9]{32}$/).optional(),
	attachmentManifest: ManifestSchema,
	baselineMessageCount: z.number().optional(),
	submissionState: z.enum(["not_submitted", "submitting", "submitted", "not_applicable"]).optional(),
	requestedChatGptModel: z.string().min(1).max(128).optional(),
	requestedChatGptEffort: z.string().min(1).max(64).optional(),
	requestedProviderTitle: z.string().min(1).max(128).optional(),
	pinChatRequested: z.boolean().optional(),
	timeoutMs: z.number().int().positive().optional(),
	deadlineAt: z.string().optional(),
	idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	idempotencyRequestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	mcpTaskId: z.string().optional(),
	cancellationRequestedAt: z.string().optional(),
	providerRunId: z.string().optional(),
	resultMessageId: z.string().optional(),
	resultText: z.string().optional(),
	result: z.unknown().optional(),
	artifactUrls: z.array(z.string()).optional(),
	artifactPaths: z.array(z.string()).optional(),
	diagnostics: z.object({
		recoveryAttempts: z.array(RecoverySchema).optional(),
		terminalReason: z.string().optional(),
		localAssistantTurnCount: z.number().int().nonnegative().optional(),
		lastObservedUrl: z.string().optional(),
		lastObservedUiState: z.string().optional(),
		organizationWarnings: z.array(z.string()).optional(),
		rateLimitEvents: z.number().int().nonnegative().optional(),
		lastRateLimitAt: z.string().optional(),
		providerCooldownUntil: z.string().optional(),
		providerConcurrencyLimit: z.number().int().positive().max(10).optional(),
	}).optional(),
	receipt: ReceiptSchema,
	error: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	completedAt: z.string().optional(),
});

const DurableRunRequestSchema = z.object({
	version: z.literal(STORAGE_VERSION),
	runId: z.string().regex(RUN_ID_PATTERN),
	kind: z.enum(["consult", "chat", "image", "subagent"]),
	prompt: z.string().min(1),
	requestedChatGptModel: z.string().min(1).max(128).optional(),
	requestedChatGptEffort: z.string().min(1).max(64).optional(),
	timeoutMs: z.number().int().positive(),
	createdAt: z.string(),
});

const IdempotencyRecordSchema = z.object({
	version: z.literal(STORAGE_VERSION),
	keyHash: z.string().regex(/^[a-f0-9]{64}$/),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	runId: z.string().regex(RUN_ID_PATTERN),
	conversationId: z.string().regex(CONVERSATION_ID_PATTERN),
	createdAt: z.string(),
});

const ProviderThrottleSchema = z.object({
	version: z.literal(1),
	reason: z.literal("chatgpt_rate_limit"),
	firstSeenAt: z.string(),
	lastSeenAt: z.string(),
	nextRetryAt: z.string(),
	consecutiveEvents: z.number().int().positive(),
	activeLimit: z.number().int().positive().max(10),
	recoverySuccesses: z.number().int().nonnegative(),
	messageSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface ProviderThrottleState {
	version: 1;
	reason: "chatgpt_rate_limit";
	firstSeenAt: string;
	lastSeenAt: string;
	nextRetryAt: string;
	consecutiveEvents: number;
	activeLimit: number;
	recoverySuccesses: number;
	messageSha256: string;
}

export interface DurableRunRequest {
	version: typeof STORAGE_VERSION;
	runId: string;
	kind: RunKind;
	prompt: string;
	requestedChatGptModel?: ChatGptModel;
	requestedChatGptEffort?: string;
	timeoutMs: number;
	createdAt: string;
}

export interface IdempotencyRecord {
	version: typeof STORAGE_VERSION;
	keyHash: string;
	requestHash: string;
	runId: string;
	conversationId: string;
	createdAt: string;
}

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled", "needs_user"]);
const TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
	queued: new Set(["queued", "running", "failed", "cancelled", "needs_user"]),
	running: new Set(["running", "completed", "failed", "cancelled", "needs_user"]),
	completed: new Set(["completed"]),
	failed: new Set(["failed"]),
	cancelled: new Set(["cancelled"]),
	needs_user: new Set(["needs_user"]),
};

interface LockOwner {
	token: string;
	pid: number;
	hostname: string;
	processStart?: string;
	createdAt: string;
	heartbeatAt: string;
}

export interface LockOptions {
	timeoutMs?: number;
	staleMs?: number;
	heartbeatMs?: number;
	pollMs?: number;
}

export function storageRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.GPT_CONTROL_HOME ?? resolve(homedir(), ".gpt-control", "v3"));
}

export function assertConversationId(id: string): void {
	if (!CONVERSATION_ID_PATTERN.test(id)) throw new Error(`Invalid conversation id: ${id}`);
}

export function assertRunId(id: string): void {
	if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid run id: ${id}`);
}

export function assertTaskId(id: string): void {
	if (!TASK_ID_PATTERN.test(id)) throw new Error(`Invalid task id: ${id}`);
}

export function confinedPath(root: string, ...parts: string[]): string {
	const canonicalRoot = resolve(root);
	const path = resolve(canonicalRoot, ...parts);
	if (path !== canonicalRoot && !path.startsWith(`${canonicalRoot}${sep}`)) {
		throw new Error(`Resolved path escaped configured root ${canonicalRoot}.`);
	}
	return path;
}

export async function secureDirectory(path: string): Promise<string> {
	const absolute = resolve(path);
	const validationPath = await canonicalSecurityPath(absolute);
	const root = parse(validationPath).root;
	let current = root;
	for (const component of relative(root, validationPath).split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new Error(`Refused symlink in security-sensitive directory: ${current}`);
			if (!info.isDirectory()) throw new Error(`Expected a directory: ${current}`);
		} catch (error) {
			if (!isMissing(error)) throw error;
			try {
				await mkdir(current, { mode: 0o700 });
			} catch (mkdirError) {
				if (!isAlreadyExists(mkdirError)) throw mkdirError;
				const raced = await lstat(current);
				if (raced.isSymbolicLink()) throw new Error(`Refused symlink in security-sensitive directory: ${current}`);
				if (!raced.isDirectory()) throw new Error(`Expected a directory: ${current}`);
			}
		}
	}
	await chmod(validationPath, 0o700);
	return absolute;
}

export async function canonicalSecurityPath(path: string): Promise<string> {
	if (platform() !== "darwin") return path;
	const root = parse(path).root;
	const components = relative(root, path).split(sep).filter(Boolean);
	const first = components[0];
	if (!first || !new Set(["var", "tmp", "etc"]).has(first)) return path;
	const alias = join(root, first);
	try {
		const info = await lstat(alias);
		if (!info.isSymbolicLink()) return path;
		const canonical = await realpath(alias);
		if (canonical !== join(root, "private", first)) return path;
		return join(canonical, ...components.slice(1));
	} catch {
		return path;
	}
}

export class RunStore {
	readonly root: string;
	private legacyStateChecked = false;

	constructor(root = storageRoot()) {
		this.root = resolve(root);
	}

	private conversationPath(id: string): string {
		assertConversationId(id);
		return confinedPath(this.root, "conversations", `${id}.json`);
	}

	private runPath(id: string): string {
		assertRunId(id);
		return confinedPath(this.root, "runs", `${id}.json`);
	}

	private requestPath(id: string): string {
		assertRunId(id);
		return confinedPath(this.root, "requests", `${id}.json`);
	}

	private idempotencyPath(keyHash: string): string {
		if (!/^[a-f0-9]{64}$/.test(keyHash)) throw new Error("Invalid idempotency key hash.");
		return confinedPath(this.root, "idempotency", `${keyHash}.json`);
	}

	private providerThrottlePath(): string {
		return confinedPath(this.root, "provider-throttle.json");
	}

	private catalogPath(kind: "models" | "projects"): string {
		return confinedPath(this.root, "catalogs", `${kind}.json`);
	}

	async init(): Promise<void> {
		if (!this.legacyStateChecked) {
			await assertNoLegacySchemaV2State(this.root);
			this.legacyStateChecked = true;
		}
		await secureDirectory(this.root);
		await Promise.all([
			secureDirectory(confinedPath(this.root, "conversations")),
			secureDirectory(confinedPath(this.root, "runs")),
			secureDirectory(confinedPath(this.root, "locks")),
			secureDirectory(confinedPath(this.root, "requests")),
			secureDirectory(confinedPath(this.root, "idempotency")),
			secureDirectory(confinedPath(this.root, "catalogs")),
		]);
	}

	async getCatalogCache(kind: "models" | "projects"): Promise<unknown | undefined> {
		await this.init();
		try {
			return JSON.parse(await safeRead(this.catalogPath(kind))) as unknown;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	async putCatalogCache(kind: "models" | "projects", record: unknown): Promise<void> {
		await this.init();
		await atomicWrite(this.catalogPath(kind), record);
	}

	async withCatalogRefreshLock<T>(kind: "models" | "projects", work: () => Promise<T>): Promise<T> {
		return this.withNamedLock(`catalog-refresh-${kind}`, work, { timeoutMs: 90_000 });
	}

	async getConversation(id: string): Promise<ConversationRecord> {
		await this.init();
		return ConversationSchema.parse(JSON.parse(await safeRead(this.conversationPath(id)))) as ConversationRecord;
	}

	async putConversation(record: ConversationRecord): Promise<void> {
		await this.init();
		ConversationSchema.parse(record);
		await this.withNamedLock(`record-${record.id}`, () => atomicWrite(this.conversationPath(record.id), record), { timeoutMs: 10_000 });
	}

	async listConversations(): Promise<ConversationRecord[]> {
		await this.init();
		const names = (await readdir(confinedPath(this.root, "conversations")))
			.filter((name) => /^conv_[a-f0-9]{32}\.json$/.test(name));
		const conversations: ConversationRecord[] = [];
		for (const name of names) conversations.push(await this.getConversation(name.slice(0, -5)));
		return conversations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async deleteConversationIfUnreferenced(id: string): Promise<void> {
		assertConversationId(id);
		await this.init();
		await this.withNamedLock(`record-${id}`, async () => {
			const names = (await readdir(confinedPath(this.root, "runs")))
				.filter((name) => /^run_[a-f0-9]{32}\.json$/.test(name));
			for (const name of names) {
				const run = RunSchema.parse(JSON.parse(await safeRead(confinedPath(this.root, "runs", name)))) as RunRecord;
				if (run.conversationId === id) throw new Error(`Conversation ${id} is still referenced by run ${run.id}.`);
			}
			try { await unlink(this.conversationPath(id)); } catch (error) { if (!isMissing(error)) throw error; }
		}, { timeoutMs: 10_000 });
	}

	async updateConversation(id: string, update: Partial<ConversationRecord>): Promise<ConversationRecord> {
		assertConversationId(id);
		return this.withNamedLock(`record-${id}`, async () => {
			const next = { ...(ConversationSchema.parse(JSON.parse(await safeRead(this.conversationPath(id)))) as ConversationRecord), ...update, id, updatedAt: nowIso() };
			ConversationSchema.parse(next);
			await atomicWrite(this.conversationPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async getRun(id: string): Promise<RunRecord> {
		await this.init();
		return RunSchema.parse(JSON.parse(await safeRead(this.runPath(id)))) as RunRecord;
	}

	async putRun(record: RunRecord): Promise<void> {
		await this.init();
		RunSchema.parse(record);
		await this.withNamedLock(`record-${record.id}`, () => atomicWrite(this.runPath(record.id), record), { timeoutMs: 10_000 });
	}

	/**
	 * Serializes record mutation and enforces monotonic terminal state. A late
	 * provider completion cannot overwrite cancellation, timeout, or needs_user.
	 */
	async updateRun(id: string, update: Partial<RunRecord>): Promise<RunRecord> {
		assertRunId(id);
		await this.init();
		return this.withNamedLock(`record-${id}`, async () => {
			const current = RunSchema.parse(JSON.parse(await safeRead(this.runPath(id)))) as RunRecord;
			// Terminal records are immutable. This is the cross-process guard that keeps
			// a late browser result from overwriting cancellation or needs_user.
			if (TERMINAL.has(current.status)) return current;
			const requestedStatus = update.status;
			if (requestedStatus && !TRANSITIONS[current.status].has(requestedStatus)) return current;
			const next = { ...current, ...update, id, updatedAt: nowIso() };
			RunSchema.parse(next);
			await atomicWrite(this.runPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async claimMcpTask(id: string, taskId: string): Promise<RunRecord> {
		assertRunId(id);
		assertTaskId(taskId);
		await this.init();
		return this.withNamedLock(`record-${id}`, async () => {
			const current = RunSchema.parse(JSON.parse(await safeRead(this.runPath(id)))) as RunRecord;
			if (current.mcpTaskId && current.mcpTaskId !== taskId) {
				throw new Error("This GPT Worker is already owned by another durable MCP task.");
			}
			if (current.mcpTaskId === taskId) return current;
			const next = { ...current, mcpTaskId: taskId, id, updatedAt: nowIso() };
			RunSchema.parse(next);
			await atomicWrite(this.runPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async claimConversationMcpSession(id: string, sessionId: string, allowTransfer = false): Promise<ConversationRecord> {
		assertConversationId(id);
		McpSessionIdSchema.parse(sessionId);
		await this.init();
		return this.withNamedLock(`record-${id}`, async () => {
			const current = ConversationSchema.parse(JSON.parse(await safeRead(this.conversationPath(id)))) as ConversationRecord;
			if (current.mcpSessionId && current.mcpSessionId !== sessionId && !allowTransfer) {
				throw new Error("This durable conversation is already claimed by another MCP session.");
			}
			if (current.mcpSessionId === sessionId) return current;
			const next = { ...current, mcpSessionId: sessionId, id, updatedAt: nowIso() };
			ConversationSchema.parse(next);
			await atomicWrite(this.conversationPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async requestProviderStop(id: string): Promise<RunRecord> {
		assertRunId(id);
		await this.init();
		return this.withNamedLock(`record-${id}`, async () => {
			const current = RunSchema.parse(JSON.parse(await safeRead(this.runPath(id)))) as RunRecord;
			const legacyUnresolved = current.providerTurnPending === undefined
				&& (current.status === "cancelled" || current.status === "needs_user")
				&& (current.submissionState === "submitting" || current.submissionState === "submitted");
			if (current.providerStopRequested && !legacyUnresolved) return current;
			const next = {
				...current,
				providerTurnPending: legacyUnresolved ? true : current.providerTurnPending,
				providerStopRequested: true,
				id,
				updatedAt: nowIso(),
			};
			RunSchema.parse(next);
			await atomicWrite(this.runPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async clearProviderTurnState(id: string): Promise<RunRecord> {
		assertRunId(id);
		await this.init();
		return this.withNamedLock(`record-${id}`, async () => {
			const current = RunSchema.parse(JSON.parse(await safeRead(this.runPath(id)))) as RunRecord;
			if (current.providerTurnPending === false && current.providerStopRequested === false) return current;
			const next = { ...current, providerTurnPending: false, providerStopRequested: false, id, updatedAt: nowIso() };
			RunSchema.parse(next);
			await atomicWrite(this.runPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async abandonProviderTurn(id: string): Promise<RunRecord> {
		assertRunId(id);
		await this.init();
		return this.withNamedLock(`record-${id}`, async () => {
			const current = RunSchema.parse(JSON.parse(await safeRead(this.runPath(id)))) as RunRecord;
			if (!TERMINAL.has(current.status)) throw new Error("Only a terminal run can abandon unresolved provider work.");
			const legacyUnresolved = current.providerTurnPending === undefined
				&& (current.status === "cancelled" || current.status === "needs_user")
				&& (current.submissionState === "submitting" || current.submissionState === "submitted");
			if (!current.providerTurnPending && !legacyUnresolved) throw new Error("This run has no unresolved provider turn to abandon.");
			const next = {
				...current,
				providerTurnPending: false,
				providerStopRequested: false,
				providerTurnAbandonedAt: nowIso(),
				id,
				updatedAt: nowIso(),
			};
			RunSchema.parse(next);
			await atomicWrite(this.runPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async listRuns(options: { statuses?: readonly RunStatus[]; limit?: number | null } = {}): Promise<RunRecord[]> {
		await this.init();
		const names = (await readdir(confinedPath(this.root, "runs"))).filter((name) => /^run_[a-f0-9]{32}\.json$/.test(name)).sort().reverse();
		const allowed = options.statuses ? new Set(options.statuses) : undefined;
		const limit = options.limit === null ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(options.limit ?? 100, 10_000));
		const runs: RunRecord[] = [];
		for (const name of names) {
			const id = name.slice(0, -5);
			const run = await this.getRun(id);
			if (!allowed || allowed.has(run.status)) runs.push(run);
		}
		return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
	}

	async putRunRequest(request: DurableRunRequest): Promise<void> {
		await this.init();
		DurableRunRequestSchema.parse(request);
		await this.withNamedLock(`request-${request.runId}`, () => atomicWrite(this.requestPath(request.runId), request), { timeoutMs: 10_000 });
	}

	/** Adds immutable local artifact paths after a completed image run. */
	async addArtifactPaths(id: string, paths: readonly string[]): Promise<RunRecord> {
		assertRunId(id);
		const normalized = [...new Set(paths)];
		if (normalized.length === 0 || normalized.some((path) => typeof path !== "string" || path === "")) {
			throw new Error("Artifact paths must be a non-empty list of absolute trusted paths.");
		}
		return this.withNamedLock(`record-${id}`, async () => {
			const current = RunSchema.parse(JSON.parse(await safeRead(this.runPath(id)))) as RunRecord;
			if (current.status !== "completed") throw new Error("Artifact paths can only be attached to a completed run.");
			if (current.artifactPaths) {
				if (JSON.stringify(current.artifactPaths) !== JSON.stringify(normalized)) {
					throw new Error("Completed run already has a different immutable artifact-path receipt.");
				}
				return current;
			}
			const next: RunRecord = { ...current, artifactPaths: normalized, updatedAt: nowIso() };
			RunSchema.parse(next);
			await atomicWrite(this.runPath(id), next);
			return next;
		}, { timeoutMs: 10_000 });
	}

	async getRunRequest(runId: string): Promise<DurableRunRequest> {
		await this.init();
		return DurableRunRequestSchema.parse(JSON.parse(await safeRead(this.requestPath(runId)))) as DurableRunRequest;
	}

	async deleteRunRequest(runId: string): Promise<void> {
		await this.init();
		await this.withNamedLock(`request-${runId}`, async () => {
			try { await unlink(this.requestPath(runId)); } catch (error) { if (!isMissing(error)) throw error; }
		}, { timeoutMs: 10_000 });
	}

	async getIdempotency(key: string): Promise<IdempotencyRecord | undefined> {
		return this.getIdempotencyByHash(idempotencyKeyHash(key));
	}

	async getIdempotencyByHash(keyHash: string): Promise<IdempotencyRecord | undefined> {
		assertHash(keyHash, "idempotency key hash");
		await this.init();
		try {
			return IdempotencyRecordSchema.parse(JSON.parse(await safeRead(this.idempotencyPath(keyHash)))) as IdempotencyRecord;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	async findRunsByIdempotencyKeyHash(keyHash: string): Promise<RunRecord[]> {
		assertHash(keyHash, "idempotency key hash");
		await this.init();
		const names = (await readdir(confinedPath(this.root, "runs"))).filter((name) => /^run_[a-f0-9]{32}\.json$/.test(name));
		const matches: RunRecord[] = [];
		for (const name of names) {
			const run = await this.getRun(name.slice(0, -5));
			if (run.idempotencyKeyHash === keyHash) matches.push(run);
		}
		return matches.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
	}

	async putIdempotency(record: IdempotencyRecord): Promise<void> {
		await this.init();
		IdempotencyRecordSchema.parse(record);
		const existing = await this.getIdempotencyByHash(record.keyHash);
		if (existing) {
			if (existing.requestHash !== record.requestHash || existing.runId !== record.runId || existing.conversationId !== record.conversationId) {
				throw new Error("Idempotency index already binds this key to a different durable request.");
			}
			return;
		}
		await atomicWrite(this.idempotencyPath(record.keyHash), record);
	}

	async getProviderThrottle(): Promise<ProviderThrottleState | undefined> {
		await this.init();
		try {
			return ProviderThrottleSchema.parse(JSON.parse(await safeRead(this.providerThrottlePath()))) as ProviderThrottleState;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	async noteProviderRateLimit(options: {
		maxConcurrentWorkers: number;
		baseDelayMs: number;
		maxDelayMs: number;
		message: string;
	}): Promise<ProviderThrottleState> {
		return this.withNamedLock("provider-throttle", async () => {
			const current = await this.getProviderThrottle();
			const now = Date.now();
			const timestamp = new Date(now).toISOString();
			const consecutiveEvents = (current?.consecutiveEvents ?? 0) + 1;
			const delayMs = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** Math.min(consecutiveEvents - 1, 16));
			const firstLimit = Math.max(1, Math.floor(options.maxConcurrentWorkers / 2));
			const activeLimit = current
				? Math.max(1, Math.min(options.maxConcurrentWorkers, current.activeLimit - 1))
				: firstLimit;
			const next: ProviderThrottleState = {
				version: 1,
				reason: "chatgpt_rate_limit",
				firstSeenAt: current?.firstSeenAt ?? timestamp,
				lastSeenAt: timestamp,
				nextRetryAt: new Date(now + delayMs).toISOString(),
				consecutiveEvents,
				activeLimit,
				recoverySuccesses: 0,
				messageSha256: createHash("sha256").update(options.message, "utf8").digest("hex"),
			};
			ProviderThrottleSchema.parse(next);
			await atomicWrite(this.providerThrottlePath(), next);
			return next;
		}, { timeoutMs: 30_000 });
	}

	async noteProviderSuccess(maxConcurrentWorkers: number): Promise<ProviderThrottleState | undefined> {
		return this.withNamedLock("provider-throttle", async () => {
			const current = await this.getProviderThrottle();
			if (!current || Date.now() < Date.parse(current.nextRetryAt)) return current;
			if (current.activeLimit >= maxConcurrentWorkers) {
				try { await unlink(this.providerThrottlePath()); } catch (error) { if (!isMissing(error)) throw error; }
				return undefined;
			}
			const activeLimit = Math.min(maxConcurrentWorkers, current.activeLimit + 1);
			if (activeLimit >= maxConcurrentWorkers) {
				try { await unlink(this.providerThrottlePath()); } catch (error) { if (!isMissing(error)) throw error; }
				return undefined;
			}
			const next: ProviderThrottleState = {
				...current,
				activeLimit,
				recoverySuccesses: current.recoverySuccesses + 1,
			};
			ProviderThrottleSchema.parse(next);
			await atomicWrite(this.providerThrottlePath(), next);
			return next;
		}, { timeoutMs: 30_000 });
	}

	async withIdempotencyLock<T>(key: string, work: (keyHash: string) => Promise<T>): Promise<T> {
		return this.withIdempotencyHashLock(idempotencyKeyHash(key), work);
	}

	async withIdempotencyHashLock<T>(keyHash: string, work: (keyHash: string) => Promise<T>): Promise<T> {
		assertHash(keyHash, "idempotency key hash");
		return this.withNamedLock(`idempotency-${keyHash}`, () => work(keyHash), { timeoutMs: 30_000 });
	}

	async withTaskLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
		assertTaskId(taskId);
		return this.withNamedLock(`mcp-${taskId}`, work, { timeoutMs: 30_000 });
	}

	async withRunTaskBindingLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
		assertRunId(runId);
		return this.withNamedLock(`mcp-run-${runId}`, work, { timeoutMs: 30_000 });
	}

	async withCodexCallbackLock<T>(threadId: string, work: () => Promise<T>): Promise<T> {
		if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(threadId)) {
			throw new Error("Invalid Codex parent thread id.");
		}
		const identityHash = createHash("sha256").update(threadId.toLowerCase(), "utf8").digest("hex");
		return this.withNamedLock(`codex-callback-${identityHash}`, work, { timeoutMs: 30_000 });
	}

	async withConversationLock<T>(
		conversationId: string,
		work: () => Promise<T>,
		options: number | LockOptions = {},
	): Promise<T> {
		assertConversationId(conversationId);
		const normalized = typeof options === "number" ? { timeoutMs: options } : options;
		return this.withNamedLock(`conversation-${conversationId}`, work, normalized);
	}

	async withConversationOwnershipLock<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
		assertConversationId(conversationId);
		return this.withNamedLock(`mcp-owner-${conversationId}`, work, { timeoutMs: 30_000 });
	}

	async withProviderConversationLock<T>(providerConversationId: string, work: () => Promise<T>): Promise<T> {
		if (!/^[A-Za-z0-9_-]{1,256}$/.test(providerConversationId)) {
			throw new Error("Invalid provider conversation id.");
		}
		const identityHash = createHash("sha256").update(providerConversationId, "utf8").digest("hex");
		return this.withNamedLock(`provider-conversation-${identityHash}`, work, { timeoutMs: 30_000 });
	}

	private async withNamedLock<T>(name: string, work: () => Promise<T>, options: LockOptions): Promise<T> {
		await this.init();
		if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid lock name: ${name}`);
		const lock = confinedPath(this.root, "locks", `${name}.lock`);
		const timeoutMs = options.timeoutMs ?? 30_000;
		const staleMs = options.staleMs ?? 10 * 60_000;
		const heartbeatMs = options.heartbeatMs ?? Math.max(1000, Math.min(30_000, Math.floor(staleMs / 3)));
		const pollMs = options.pollMs ?? 100;
		const deadline = Date.now() + timeoutMs;
		const owner: LockOwner = {
			token: randomUUID(),
			pid: process.pid,
			hostname: hostname(),
			processStart: await processStart(process.pid),
			createdAt: nowIso(),
			heartbeatAt: nowIso(),
		};

		for (;;) {
			try {
				await mkdir(lock, { mode: 0o700 });
				await writeOwner(lock, owner);
				break;
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				const recovered = await recoverDeadOwner(lock, staleMs);
				if (recovered) continue;
				if (Date.now() >= deadline) throw new Error(`Lock ${name} is held by a live owner.`);
				await sleep(pollMs);
			}
		}

		const heartbeat = setInterval(() => {
			void heartbeatOwner(lock, owner).catch(() => undefined);
		}, heartbeatMs);
		heartbeat.unref?.();
		try {
			return await work();
		} finally {
			clearInterval(heartbeat);
			await releaseOwnedLock(lock, owner.token);
		}
	}
}

async function safeRead(path: string): Promise<string> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe record path: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
	const parent = await secureDirectory(dirname(path));
	if (!path.startsWith(`${parent}${sep}`)) throw new Error(`Unsafe record destination: ${path}`);
	try {
		const current = await lstat(path);
		if (current.isSymbolicLink()) throw new Error(`Refused to overwrite symlink: ${path}`);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const scratch = confinedPath(parent, `.${randomUUID()}.tmp`);
	const handle = await open(scratch, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
	} finally {
		await handle.close();
	}
	await rename(scratch, path);
}

async function writeOwner(lock: string, owner: LockOwner): Promise<void> {
	const path = confinedPath(lock, "owner.json");
	await writeFile(path, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
}

async function heartbeatOwner(lock: string, owner: LockOwner): Promise<void> {
	const current = await readOwner(lock);
	if (!current || current.token !== owner.token) return;
	owner.heartbeatAt = nowIso();
	const path = confinedPath(lock, "owner.json");
	const scratch = confinedPath(lock, `.owner-${owner.token}.tmp`);
	await writeFile(scratch, `${JSON.stringify(owner)}\n`, { flag: "w", mode: 0o600 });
	await rename(scratch, path);
}

async function readOwner(lock: string): Promise<LockOwner | undefined> {
	try {
		const value: unknown = JSON.parse(await safeRead(confinedPath(lock, "owner.json")));
		if (!value || typeof value !== "object") return undefined;
		const record = value as Record<string, unknown>;
		if (typeof record.token !== "string" || typeof record.pid !== "number" || typeof record.hostname !== "string") return undefined;
		if (typeof record.createdAt !== "string" || typeof record.heartbeatAt !== "string") return undefined;
		return record as unknown as LockOwner;
	} catch {
		return undefined;
	}
}

async function recoverDeadOwner(lock: string, staleMs: number): Promise<boolean> {
	let info;
	try {
		info = await lstat(lock);
	} catch (error) {
		return isMissing(error);
	}
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refused unsafe lock path: ${lock}`);
	const first = await readOwner(lock);
	const heartbeatAt = first ? Date.parse(first.heartbeatAt) : info.mtimeMs;
	if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt <= staleMs) return false;
	if (first && await ownerIsAlive(first)) return false;
	const second = await readOwner(lock);
	if ((first?.token ?? "") !== (second?.token ?? "")) return false;
	if (second && await ownerIsAlive(second)) return false;
	const stale = `${lock}.stale-${randomUUID()}`;
	try {
		await rename(lock, stale);
		await rm(stale, { recursive: true, force: true });
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function ownerIsAlive(owner: LockOwner): Promise<boolean> {
	if (owner.hostname !== hostname()) return true;
	try {
		process.kill(owner.pid, 0);
	} catch {
		return false;
	}
	if (!owner.processStart) return true;
	return (await processStart(owner.pid)) === owner.processStart;
}

async function processStart(pid: number): Promise<string | undefined> {
	try {
		const value = await readFile(`/proc/${pid}/stat`, "utf8");
		const close = value.lastIndexOf(")");
		if (close < 0) return undefined;
		return value.slice(close + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

async function releaseOwnedLock(lock: string, token: string): Promise<void> {
	const owner = await readOwner(lock);
	if (!owner || owner.token !== token) return;
	await rm(lock, { recursive: true, force: true });
}

function assertHash(value: string, label: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}.`);
}

export function idempotencyKeyHash(key: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new Error("Invalid idempotency key. Use 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen.");
	return createHash("sha256").update(key).digest("hex");
}

async function assertNoLegacySchemaV2State(root: string): Promise<void> {
	const candidates = [root];
	if (basename(root) === "v3") candidates.push(dirname(root));
	for (const candidate of [...new Set(candidates)]) {
		for (const directory of ["runs", "conversations"]) {
			const path = confinedPath(candidate, directory);
			let names: string[];
			try {
				const info = await lstat(path);
				if (info.isSymbolicLink() || !info.isDirectory()) {
					throw new Error(`Refused unsafe legacy-state path: ${path}`);
				}
				names = await readdir(path);
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			for (const name of names.filter((value) => value.endsWith(".json"))) {
				const recordPath = confinedPath(path, name);
				const info = await lstat(recordPath);
				if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe legacy-state record: ${recordPath}`);
				let version: unknown;
				try {
					version = (JSON.parse(await readFile(recordPath, "utf8")) as { version?: unknown }).version;
				} catch {
					version = undefined;
				}
				const legacy = candidate !== root || version !== STORAGE_VERSION;
				if (legacy) {
					throw new Error(
						`Legacy or unknown GPT-Control durable state was detected at ${candidate}. `
						+ "Startup is blocked because an older browser turn may still be active. Follow docs/UPGRADE_V2.md before using schema v3.",
					);
				}
			}
		}
	}
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}
