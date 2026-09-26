import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	describeCapabilities,
	resetCapabilityCache,
	resolveCapabilities,
	selectRoute,
	type Capabilities,
	type TransportChoice,
} from "./capability";
import {
	assertExactDriverSession,
	waitForCompletedDriverTurn,
	waitForDriverReady,
	type DriverCompletionOutcome,
	type ExpectedDriverSession,
	type ChatGptConversationCatalog,
	type ChatGptConversationFindRequest,
	type DriverSession,
	type WebChatDriver,
} from "./browser-driver";
import {
	CHATGPT_ORIGIN,
	ChatGptProviderSafetyError,
	ChatGptRateLimitError,
	providerConversationIdentity,
	type ChatGptModelCatalog,
	type ChatGptProjectCatalog,
	type ChatGptConversationAction,
	type ChatGptConversationActionResult,
	type ChatGptConversationTurn,
	type ChatPageObservation,
} from "./chatgpt";
import {
	PACKAGE_VERSION,
	STORAGE_VERSION,
	nowIso,
	opaqueId,
	type AttachmentManifest,
	type ChatGptModel,
	type ConversationRecord,
	type Provider,
	type RecoveryAttempt,
	type ReviewReceipt,
	type RunKind,
	type RunRecord,
	type RunStatus,
} from "./domain";
import { buildAttachmentManifest } from "./files";
import {
	assertRequestedAuthority,
	assertTransportAllowed,
	operatorPolicyFromEnv,
	type OperatorPolicy,
} from "./policy";
import { buildReviewPrompt, parseReviewReport } from "./review";
import {
	idempotencyKeyHash,
	LiveLockOwnerError,
	RunStore,
	type DurableRunRequest,
	type MaintenanceReceipt,
	type NamedLease,
} from "./store";
import { passiveTransportDiscovery } from "./transport";
import type { Exec } from "./types";

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled", "needs_user"]);
const catalogRefreshes = new Map<string, Promise<unknown>>();

function isDefinitivePreSendFailure(run: RunRecord): boolean {
	return !run.providerUserMessageId
		&& Boolean(run.error?.includes("Could not click the ChatGPT send button"))
		&& Boolean(run.error?.includes("No element found for selector"));
}

function terminalProviderTurnIsPastExplicitCancelGrace(run: RunRecord, graceMs: number, now = Date.now()): boolean {
	if (!TERMINAL.has(run.status) || !run.providerTurnPending || !run.providerStopRequested) return false;
	const completedAt = Date.parse(run.completedAt ?? "");
	if (!Number.isFinite(completedAt)) return false;
	const providerDeadline = Date.parse(run.providerActiveDeadlineAt ?? "");
	const safeFrom = Number.isFinite(providerDeadline) ? Math.max(completedAt, providerDeadline) : completedAt;
	return now - safeFrom >= graceMs;
}

function ownedBrowserPageIsMissing(error: unknown): boolean {
	return /session not found|owns no page|no longer owns the recorded page|no such tab|tab not found|target closed/i.test(errorMessage(error));
}

class RestartSuspension extends Error {
	constructor() { super("GPT-Control monitoring suspended for process restart."); }
}

class RetainedCreatedSessionError extends Error {}

class ProviderSafetyPauseError extends Error {
	constructor(
		readonly reason: "chatgpt_rate_limit" | "suspicious_activity" | "human_verification",
		message: string,
	) {
		super(message);
		this.name = "ProviderSafetyPauseError";
	}
}

export interface StartRequest {
	kind: RunKind;
	prompt: string;
	/** Optional GPT Worker title. */
	title?: string;
	/** Optional short project identifier to prefix to a GPT Worker title. */
	projectId?: string;
	files?: string[];
	conversationId?: string;
	transport?: TransportChoice;
	chatgptModel?: ChatGptModel;
	chatgptEffort?: string;
	pinChat?: boolean;
	/** Retained only to reject false browser provenance from older clients. */
	providerModel?: string;
	/** Legacy aliases retained only for safe compatibility checks. */
	model?: string;
	workspaceRoot?: string;
	idempotencyKey?: string;
	connectors?: string[];
	connectorMode?: "prefer" | "require";
	wait?: boolean;
	timeoutMs?: number;
	/** Legacy request booleans may narrow, never grant, trusted policy authority. */
	allowOutsideWorkspace?: boolean;
	allowSensitiveFiles?: boolean;
	apiConfirmed?: boolean;
	allowFocusSteal?: boolean;
}

export interface ModelCatalogResult {
	currentModel?: string;
	currentEffort?: string;
	models: ChatGptModelCatalog["models"];
	efforts: ChatGptModelCatalog["efforts"];
	discoveredAt?: string;
	browserDriverId: string;
	cacheStatus: "hit" | "miss" | "refreshed";
	refreshRequired: boolean;
	cachedAt?: string;
	message?: string;
}

export interface ProjectCatalogResult {
	projects: ChatGptProjectCatalog["projects"];
	discoveredAt?: string;
	browserDriverId: string;
	cacheStatus: "hit" | "miss" | "refreshed";
	refreshRequired: boolean;
	cachedAt?: string;
	message?: string;
}

interface CatalogCacheRecord<T> {
	version: 1;
	kind: "models" | "projects";
	cachedAt: string;
	browserDriverId: string;
	catalog: T;
}

export interface StartResult {
	conversation: ConversationRecord;
	run: RunRecord;
}

export interface StartOptions {
	/** Trusted internal control used to bind an MCP task before provider execution. */
	deferExecution?: boolean;
	/** Trusted transport identity; never accepted from model-controlled tool input. */
	mcpSessionId?: string;
}

export interface AttachConversationRequest {
	conversationUrl?: string;
	providerConversationId?: string;
	timeoutMs?: number;
}

export interface ConversationStatusResult {
	conversationId: string;
	providerConversationId?: string;
	providerConversationUrl?: string;
	title?: string;
	pinned?: boolean;
	project?: string;
	projectId?: string;
	state: "idle" | "generating" | "rate_limited" | "error" | "needs_user" | "interrupted";
	stateSummary: string;
	assistantTurnCount: number;
	requestedModel?: string;
	observedModel?: string;
	requestedEffort?: string;
	observedEffort?: string;
	latestTurnAt?: string;
	visibleToolCards: Array<{ label: string; sha256: string }>;
	rateLimitMessage?: string;
	interruptionReason?: "provider" | "user";
	interruptionMessage?: string;
	errorMessage?: string;
}

export interface ServiceDependencies {
	resolveCapabilities?: (exec: Exec, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<Capabilities>;
}

interface ActiveRun {
	controller: AbortController;
	promise: Promise<RunRecord>;
}

interface ProviderTurnResult {
	provider: Provider;
	terminalStatus: "completed" | "needs_user";
	terminalReason?: string;
	text: string;
	providerConversationId?: string;
	providerConversationUrl?: string;
	providerRunId?: string;
	observedModel?: string;
	observedEffort?: string;
	modelVerified?: boolean;
	modelEvidenceKind?: "composer_selector";
	modelVerifiedAt?: string;
	transportVersion?: string;
	imageUrls?: string[];
	localAssistantTurnCount?: number;
	recoveryAttempts?: RecoveryAttempt[];
	lastObservedUrl?: string;
	lastObservedUiState?: string;
}

class FairSemaphore {
	private active = 0;
	private readonly queue: Array<{
		resolve: () => void;
		reject: (error: unknown) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(private readonly limit: number) {}

	async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire(signal);
		try { return await work(); } finally { this.release(); }
	}

	private acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Worker admission was cancelled."));
		if (this.active < this.limit) {
			this.active += 1;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, signal } as {
				resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void;
			};
			if (signal) {
				waiter.onAbort = () => {
					const index = this.queue.indexOf(waiter);
					if (index >= 0) this.queue.splice(index, 1);
					reject(signal.reason ?? new Error("Worker admission was cancelled."));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.queue.push(waiter);
		});
	}

	private release(): void {
		this.active -= 1;
		while (this.queue.length > 0) {
			const waiter = this.queue.shift()!;
			if (waiter.signal?.aborted) continue;
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			this.active += 1;
			waiter.resolve();
			break;
		}
	}
}

/**
 * A recorded provider user-message id matches the observed latest user turn when it
 * equals the preferred id or any alias the same turn exposes (for example a run
 * recorded before ChatGPT exposed provider ids on current turn markup).
 */
function observationHasUserMessage(observation: ChatPageObservation, id: string | undefined): boolean {
	if (!id) return false;
	return observation.latestUserMessageId === id || (observation.latestUserMessageAliases ?? []).includes(id);
}

export class GptControlService {
	readonly store: RunStore;
	readonly policy: OperatorPolicy;
	private readonly exec: Exec;
	private readonly dependencies: Required<ServiceDependencies>;
	private readonly activeRuns = new Map<string, ActiveRun>();
	private readonly activeStopReconciliations = new Map<string, Promise<void>>();
	private readonly runOwnerLeases = new Map<string, Promise<NamedLease>>();
	private readonly runRecoveryScopes = new Map<string, number>();
	private readonly pendingOwnerReleases = new Set<string>();
	private readonly cancellationIntents = new Set<string>();
	private readonly providerSlots: FairSemaphore;

	constructor(
		exec: Exec,
		store = new RunStore(),
		policy?: OperatorPolicy,
		dependencies: ServiceDependencies = {},
	) {
		this.exec = exec;
		this.store = store;
		this.policy = policy ?? operatorPolicyFromEnv(process.env, {
			storageRoot: store.root,
			snapshotRoot: join(store.root, "snapshots"),
			outputRoot: join(store.root, "generated"),
		});
		this.dependencies = { resolveCapabilities: dependencies.resolveCapabilities ?? resolveCapabilities };
		this.providerSlots = new FairSemaphore(this.policy.maxActiveGenerations);
	}

	async listModels(options: { refresh?: boolean } = {}): Promise<ModelCatalogResult> {
		const before = parseModelCatalogCache(await this.store.getCatalogCache("models"));
		if (!options.refresh) return before ? modelCatalogResult(before, "hit") : missingModelCatalog();
		return catalogSingleFlight(`${this.store.root}:models`, () => this.store.withCatalogRefreshLock("models", async () => {
			const after = parseModelCatalogCache(await this.store.getCatalogCache("models"));
			if (after && after.cachedAt !== before?.cachedAt) return modelCatalogResult(after, "hit");
			const capabilities = await this.dependencies.resolveCapabilities(this.exec);
			const route = selectRoute(capabilities, { transport: "browser" });
			assertTransportAllowed(this.policy, route.kind);
			const name = `gpt-control:catalog:${opaqueId("task")}`;
			const discoveryUrl = await this.modelCatalogDiscoveryUrl(route.driver);
			return this.withMaintenanceSession("model_catalog", route.driver, name, discoveryUrl, async (session, expected) => {
				const ready = await waitForDriverReady(route.driver, expected, { timeoutMs: 60_000 });
				const catalog = await route.driver.discoverModels(ready.session);
				const record: CatalogCacheRecord<ChatGptModelCatalog> = {
					version: 1,
					kind: "models",
					cachedAt: nowIso(),
					browserDriverId: route.driver.id,
					catalog,
				};
				await this.store.putCatalogCache("models", record);
				return modelCatalogResult(record, "refreshed");
			});
		}));
	}

	async listProjects(options: { refresh?: boolean } = {}): Promise<ProjectCatalogResult> {
		const before = parseProjectCatalogCache(await this.store.getCatalogCache("projects"));
		if (!options.refresh) return before ? projectCatalogResult(before, "hit") : missingProjectCatalog();
		return catalogSingleFlight(`${this.store.root}:projects`, () => this.store.withCatalogRefreshLock("projects", async () => {
			const after = parseProjectCatalogCache(await this.store.getCatalogCache("projects"));
			if (after && after.cachedAt !== before?.cachedAt) return projectCatalogResult(after, "hit");
			const capabilities = await this.dependencies.resolveCapabilities(this.exec);
			const route = selectRoute(capabilities, { transport: "browser" });
			assertTransportAllowed(this.policy, route.kind);
			const name = `gpt-control:projects:${opaqueId("task")}`;
			return this.withMaintenanceSession("project_catalog", route.driver, name, CHATGPT_ORIGIN, async (session, expected) => {
				const ready = await waitForDriverReady(route.driver, expected, { timeoutMs: 60_000 });
				const catalog = await route.driver.discoverProjects(ready.session);
				const record: CatalogCacheRecord<ChatGptProjectCatalog> = {
					version: 1,
					kind: "projects",
					cachedAt: nowIso(),
					browserDriverId: route.driver.id,
					catalog,
				};
				await this.store.putCatalogCache("projects", record);
				return projectCatalogResult(record, "refreshed");
			});
		}));
	}

	private async modelCatalogDiscoveryUrl(driver: WebChatDriver): Promise<string> {
		const runs = await this.store.listRuns({ limit: null });
		const activeConversationIds = new Set(runs.filter((run) =>
			run.status === "queued" || run.status === "running" || run.providerTurnPending === true)
			.map((run) => run.conversationId));
		const conversations = (await this.store.listConversations()).filter((conversation) =>
			conversation.provider === "browser"
				&& !conversation.providerArchivedAt
				&& conversation.providerConversationUrl
				&& providerConversationIdentity(conversation.providerConversationUrl));
		const local = conversations.find((conversation) =>
			!conversation.closedAt && !activeConversationIds.has(conversation.id))
			?? conversations.find((conversation) => !activeConversationIds.has(conversation.id));
		if (local?.providerConversationUrl) return providerConversationIdentity(local.providerConversationUrl)!.url;
		if (driver.findConversations) {
			const live = await driver.findConversations({ limit: 1 });
			const first = live.conversations[0];
			if (first) return providerConversationIdentity(first.providerConversationUrl)?.url ?? CHATGPT_ORIGIN;
		}
		return CHATGPT_ORIGIN;
	}

	private async withMaintenanceSession<T>(
		kind: "model_catalog" | "project_catalog",
		driver: WebChatDriver,
		name: string,
		url: string,
		work: (session: DriverSession, expected: ExpectedDriverSession) => Promise<T>,
	): Promise<T> {
			const session = await driver.create(name, url);
			const expected: ExpectedDriverSession = { sessionId: session.sessionId, pageId: session.pageId, name };
		let retainedHandled = false;
		try {
			await this.validateCreatedSession(driver, session, expected, async () => {
				const timestamp = nowIso();
				const receipt: MaintenanceReceipt = {
					version: 1,
					id: `maint_${randomUUID().replaceAll("-", "")}`,
					kind,
						browserDriverId: driver.id,
						browserSessionId: session.sessionId,
						browserPageId: session.pageId,
						browserSessionName: session.name,
					browserUrl: session.url,
					desktopPoolLane: session.desktopPoolLane,
					desktopPoolLeaseState: "release_unproved",
					status: "retained",
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				await this.store.putMaintenanceReceipt(receipt);
				return {
					label: receipt.id,
					markClosed: async () => this.store.putMaintenanceReceipt({ ...receipt, status: "closed", updatedAt: nowIso() }),
				};
			});
			return await work(session, expected);
		} catch (error) {
			if (error instanceof RetainedCreatedSessionError) retainedHandled = true;
			throw error;
		} finally {
			if (!retainedHandled) await driver.close(session.sessionId, undefined, session.pageId);
		}
	}

	private async validateCreatedSession(
		driver: WebChatDriver,
		session: DriverSession,
		expected: ExpectedDriverSession,
			retain: () => Promise<{ label: string; markClosed: () => Promise<void> }>,
		): Promise<void> {
			if (session.desktopPoolLeaseState !== "release_unproved") {
				if (session.name !== expected.name) throw new Error("Browser driver returned a session with the wrong ownership name.");
				await assertExactDriverSession(driver, expected);
				return;
			}
			const durable = await retain();
			const validationError = session.name !== expected.name
				? " Browser driver returned a session with the wrong ownership name."
				: "";
			try {
				await driver.close(session.sessionId, undefined, session.pageId);
				await durable.markClosed();
			} catch (cleanupError) {
				throw new RetainedCreatedSessionError(
					`Desktop session creation succeeded, but lifecycle-lock release and cleanup were not proved; durable ownership receipt ${durable.label} was retained.${validationError} Cleanup error: ${errorMessage(cleanupError)}`,
				);
			}
			throw new RetainedCreatedSessionError(
				`Desktop session creation succeeded, but lifecycle-lock release was not proved; cleanup was proved in durable ownership receipt ${durable.label}.${validationError}`,
			);
	}

	async findConversations(request: ChatGptConversationFindRequest = {}): Promise<ChatGptConversationCatalog> {
		const query = request.query?.replace(/\s+/g, " ").trim();
		if (query !== undefined && (query.length < 1 || query.length > 256)) {
			throw new Error("Conversation query must be 1-256 characters.");
		}
		const limit = request.limit ?? 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Conversation search limit must be 1-50.");
		const capabilities = await this.dependencies.resolveCapabilities(this.exec);
		const route = selectRoute(capabilities, { transport: "browser" });
		assertTransportAllowed(this.policy, route.kind);
		if (!route.driver.findConversations) {
			throw new Error(`Browser driver ${route.driver.id} does not support read-only ChatGPT conversation discovery.`);
		}
		return route.driver.findConversations({
			...(query ? { query } : {}),
			...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
			...(request.projectId ? { projectId: request.projectId } : {}),
			limit,
		});
	}

	async manageConversation(
		conversationId: string,
		action: ChatGptConversationAction,
		mcpSessionId?: string,
	): Promise<ChatGptConversationActionResult> {
		return this.store.withConversationOwnershipLock(conversationId, async () => {
			const conversation = await this.store.getConversation(conversationId);
			if (mcpSessionId !== undefined && conversation.mcpSessionId !== mcpSessionId) {
				throw new Error("This GPT-Control conversation is not owned by the current MCP session.");
			}
			if (conversation.closedAt) throw new Error(`Conversation ${conversationId} is closed.`);
			const active = (await this.store.listRuns({ limit: null })).find((run) =>
				run.conversationId === conversationId && (run.status === "queued" || run.status === "running" || run.providerTurnPending === true));
			if (active) throw new Error(`Conversation ${conversationId} still has active run ${active.id}; organization changes are refused until it is terminal.`);
			const { driver, expected } = await this.resolveOwnedDriver(conversation);
			await assertExactDriverSession(driver, expected);
			const result = await driver.manageConversation(await driver.show(expected.sessionId), action);
			if (action.action === "archive") {
				await driver.close(expected.sessionId, undefined, expected.pageId);
				const archivedAt = nowIso();
				await this.store.updateConversation(conversationId, { closedAt: archivedAt, providerArchivedAt: archivedAt });
			} else if (action.action === "pin" || action.action === "unpin") {
				await this.store.updateConversation(conversationId, { providerPinned: action.action === "pin" });
			} else if (action.action === "rename") {
				await this.store.updateConversation(conversationId, { providerTitle: result.title });
			} else if (action.action === "move") {
				await this.store.updateConversation(conversationId, { providerProject: result.project });
			}
			return result;
		});
	}

	async readConversation(
		conversationId: string,
		limit = 10,
		mcpSessionId?: string,
	): Promise<ChatGptConversationTurn[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Conversation read limit must be 1-20.");
		return this.store.withConversationOwnershipLock(conversationId, async () => {
			const conversation = await this.store.getConversation(conversationId);
			if (mcpSessionId !== undefined && conversation.mcpSessionId !== mcpSessionId) {
				throw new Error("This GPT-Control conversation is not owned by the current MCP session.");
			}
			if (conversation.closedAt) throw new Error(`Conversation ${conversationId} is closed.`);
			const { driver, expected } = await this.resolveOwnedDriver(conversation);
			const session = await assertExactDriverSession(driver, expected);
			if (!driver.readConversation) throw new Error(`Browser driver ${driver.id} does not support conversation reads.`);
			return driver.readConversation(session, limit);
		});
	}

	async findAndAttachConversation(
		request: ChatGptConversationFindRequest,
		mcpSessionId?: string,
	): Promise<{ match: ChatGptConversationCatalog["conversations"][number]; conversation: ConversationRecord }> {
		const catalog = await this.findConversations(request);
		if (catalog.conversations.length === 0) throw new Error("No ChatGPT conversation matched the requested search.");
		if (catalog.conversations.length !== 1) {
			throw new Error(`ChatGPT conversation search is ambiguous; ${catalog.conversations.length} conversations matched. Narrow the title or filters before attachment.`);
		}
		const match = catalog.conversations[0];
		let conversation = await this.attachConversation({ providerConversationId: match.providerConversationId }, mcpSessionId);
		conversation = await this.store.updateConversation(conversation.id, {
			providerTitle: match.title,
			providerPinned: match.pinned,
			...(match.projectId ? { providerProject: match.projectId } : {}),
		});
		return { match, conversation };
	}

	async conversationStatus(
		conversationId: string,
		mcpSessionId?: string,
	): Promise<ConversationStatusResult> {
		return this.store.withConversationOwnershipLock(conversationId, async () => {
			const conversation = await this.store.getConversation(conversationId);
			if (mcpSessionId !== undefined && conversation.mcpSessionId !== mcpSessionId) {
				throw new Error("This GPT-Control conversation is not owned by the current MCP session.");
			}
			if (conversation.closedAt) throw new Error(`Conversation ${conversationId} is closed.`);
			const { driver, expected } = await this.resolveOwnedDriver(conversation);
			const session = await assertExactDriverSession(driver, expected);
			const observation = await driver.observe(session);
			let metadata: ChatGptConversationCatalog["conversations"][number] | undefined;
			if (driver.findConversations && conversation.providerConversationId) {
				const catalog = await driver.findConversations({
					...(conversation.providerTitle ? { query: conversation.providerTitle } : {}),
					limit: 50,
				});
				metadata = catalog.conversations.find((entry) => entry.providerConversationId === conversation.providerConversationId);
			}
			const latestRun = (await this.store.listRuns({ limit: null }))
				.filter((run) => run.conversationId === conversationId)
				.sort((left, right) => right.receipt.startedAt.localeCompare(left.receipt.startedAt))[0];
			const state: ConversationStatusResult["state"] = observation.providerSafetyReason
				? "needs_user"
				: observation.rateLimited
				? "rate_limited"
				: observation.turnInterruption ? "interrupted"
				: observation.errorMessage ? "error"
					: observation.answering || observation.thinking || observation.toolRunning ? "generating"
						: observation.retryAvailable || observation.continueAvailable ? "needs_user" : "idle";
			return {
				conversationId,
				providerConversationId: conversation.providerConversationId,
				providerConversationUrl: conversation.providerConversationUrl,
				title: metadata?.title ?? conversation.providerTitle,
				pinned: metadata?.pinned ?? conversation.providerPinned,
				project: conversation.providerProject,
				projectId: metadata?.projectId,
				state,
				stateSummary: observation.stateSummary,
				assistantTurnCount: observation.snapshot.count,
				...(latestRun?.receipt.modelVerified === true
					&& latestRun.receipt.modelEvidenceKind === "composer_selector"
					&& latestRun.receipt.observedModel
					? {
						requestedModel: latestRun.receipt.requestedModel,
						observedModel: latestRun.receipt.observedModel,
						requestedEffort: latestRun.receipt.requestedEffort,
						observedEffort: latestRun.receipt.observedEffort,
					} : {}),
				latestTurnAt: metadata?.updatedAt ?? latestRun?.receipt.completedAt,
				visibleToolCards: observation.visibleToolCards,
				rateLimitMessage: observation.rateLimitMessage,
				interruptionReason: observation.turnInterruption,
				interruptionMessage: observation.interruptionMessage,
				errorMessage: observation.errorMessage,
			};
		});
	}

	async start(request: StartRequest, options: StartOptions = {}): Promise<StartResult> {
		const normalized = normalizeStartRequest(request, this.policy);
		if (options.deferExecution && normalized.wait) throw new Error("Deferred execution requires wait=false.");
		await this.store.init();
		const requestHash = startRequestHash(normalized);
		let prepared: StartResult;
		if (normalized.idempotencyKey) {
			const scopedIdempotencyKey = options.mcpSessionId
				? `mcp-${sha256(options.mcpSessionId)}:${normalized.idempotencyKey}`
				: normalized.idempotencyKey;
			prepared = await this.store.withIdempotencyLock(scopedIdempotencyKey, async (keyHash) => {
				let binding = await this.store.getIdempotencyByHash(keyHash);
				if (!binding) {
					const prepared = await this.store.findRunsByIdempotencyKeyHash(keyHash);
					if (prepared.length > 1) throw new Error("Multiple durable runs share one idempotency key hash; execution refused.");
					const orphan = prepared[0];
					if (orphan) {
						if (orphan.idempotencyRequestHash !== requestHash) throw new Error("Idempotency key was prepared for a different request.");
						binding = {
							version: STORAGE_VERSION, keyHash, requestHash, runId: orphan.id,
							conversationId: orphan.conversationId, createdAt: orphan.createdAt,
						};
						await this.store.putIdempotency(binding);
					}
				}
				if (binding) {
					if (binding.requestHash !== requestHash) throw new Error("Idempotency key was already used for a different request.");
					return {
						conversation: await this.store.getConversation(binding.conversationId),
						run: await this.store.getRun(binding.runId),
					};
				}
				const created = await this.createPrepared(normalized, keyHash, requestHash, !options.deferExecution, options.mcpSessionId);
				try {
					await this.store.putIdempotency({
						version: STORAGE_VERSION, keyHash, requestHash, runId: created.run.id,
						conversationId: created.conversation.id, createdAt: nowIso(),
					});
				} catch (error) {
					await this.releaseIdleRunOwnership(created.run.id);
					throw error;
				}
				return created;
			});
		} else {
			prepared = await this.createPrepared(normalized, undefined, undefined, !options.deferExecution, options.mcpSessionId);
		}
		return this.finishStart(prepared, normalized, options);
	}

	/** Hold ownership across recovery checks and mutations, including task binding. */
	async withRunRecoveryOwnership(runId: string, work: () => Promise<void>): Promise<boolean> {
		const alreadyOwned = this.runOwnerLeases.has(runId);
		this.runRecoveryScopes.set(runId, (this.runRecoveryScopes.get(runId) ?? 0) + 1);
		let owned = false;
		try {
			owned = await this.claimRunForRecovery(runId);
			if (!owned) return false;
			await work();
			return true;
		} finally {
			const remaining = this.runRecoveryScopes.get(runId)! - 1;
			if (remaining) this.runRecoveryScopes.set(runId, remaining);
			else this.runRecoveryScopes.delete(runId);
			if ((owned && !alreadyOwned) || this.pendingOwnerReleases.has(runId)) {
				await this.releaseIdleRunOwnership(runId);
			}
		}
	}

	/** Acquire before any recovery mutation; the lease also covers provider admission. */
	private async claimRunForRecovery(runId: string): Promise<boolean> {
		let pending = this.runOwnerLeases.get(runId);
		if (!pending) {
			pending = this.store.acquireNamedLease(`run-owner-${runId}`, {
				timeoutMs: 0, staleMs: 120_000, heartbeatMs: 20_000,
			});
			this.runOwnerLeases.set(runId, pending);
		}
		try {
			await pending;
			return true;
		} catch (error) {
			if (this.runOwnerLeases.get(runId) === pending) this.runOwnerLeases.delete(runId);
			if (error instanceof LiveLockOwnerError) return false;
			throw error;
		}
	}

	private async releaseRunOwnership(runId: string): Promise<void> {
		const pending = this.runOwnerLeases.get(runId);
		this.pendingOwnerReleases.delete(runId);
		if (!pending) return;
		// Remove local ownership before releasing so a concurrent claimant must
		// acquire the filesystem lease instead of reusing one being released.
		this.runOwnerLeases.delete(runId);
		await (await pending).release();
	}

	private async releaseIdleRunOwnership(runId: string): Promise<void> {
		if (this.activeRuns.has(runId)) return;
		if (this.runRecoveryScopes.has(runId)) {
			this.pendingOwnerReleases.add(runId);
			return;
		}
		await this.releaseRunOwnership(runId);
	}

	async schedulePreparedRun(runId: string): Promise<RunRecord> {
		await this.withRunRecoveryOwnership(runId, async () => {
			const run = await this.store.getRun(runId);
			if (TERMINAL.has(run.status)) {
				await this.releaseIdleRunOwnership(runId);
				return;
			}
			const conversation = await this.store.getConversation(run.conversationId);
			if (conversation.policyFingerprint !== this.policy.fingerprint) {
				await this.markNeedsUser(runId, "Trusted operator policy changed before deferred execution; the worker was not started.");
				return;
			}
			if (!run.executionReady) await this.store.updateRun(runId, { executionReady: true });
			this.scheduleRun(runId, false);
		});
		return this.store.getRun(runId);
	}

	async getRun(runId: string): Promise<RunRecord> { return this.store.getRun(runId); }
	async listRuns(limit = 20): Promise<RunRecord[]> {
		return this.store.listRuns({ limit: Math.max(1, Math.min(limit, 100)) });
	}

	async waitForRun(runId: string, timeoutMs = 10 * 60_000): Promise<RunRecord> {
		const deadline = Date.now() + timeoutMs;
		const active = this.activeRuns.get(runId);
		if (active) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
				timer.unref?.();
			});
			let result: RunRecord | undefined;
			try {
				result = await Promise.race([active.promise, timeout]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (result && TERMINAL.has(result.status)) return result;
		}
		for (;;) {
			const run = await this.store.getRun(runId);
			if (TERMINAL.has(run.status) || Date.now() >= deadline) return run;
			await sleep(200);
		}
	}

	async suspendActiveRunsForRestart(): Promise<void> {
		const active = [...this.activeRuns.values()];
		for (const value of active) value.controller.abort(new RestartSuspension());
		await Promise.allSettled(active.map((value) => value.promise));
		for (const runId of this.runOwnerLeases.keys()) await this.releaseIdleRunOwnership(runId);
	}

	async cancelPreparedRunUnlessOwnedByAnotherTask(runId: string, taskId: string): Promise<RunRecord> {
		return this.store.withRunTaskBindingLock(runId, async () => {
			const current = await this.store.getRun(runId);
			if (current.mcpTaskId && current.mcpTaskId !== taskId) return current;
			return this.cancelRun(runId);
		});
	}

	async cancelRun(runId: string): Promise<RunRecord> {
		// Register intent synchronously so a same-process completion that is already
		// unwinding cannot win merely because the durable operations contain awaits.
		this.cancellationIntents.add(runId);
		// Abort local browser work before any durable terminal transition. This is
		// especially important when MCP task cancellation reaches us after the task
		// store has acquired its own lock: an in-flight send must see cancellation
		// before the task can be sealed.
		this.activeRuns.get(runId)?.controller.abort(new Error("Cancelled by caller."));
		const current = await this.store.getRun(runId);
		if (TERMINAL.has(current.status)) {
			const legacyPending = current.providerTurnPending === undefined
				&& (current.submissionState === "submitting" || current.submissionState === "submitted")
				&& current.status !== "completed" && current.status !== "failed";
			if (current.providerTurnPending || legacyPending) {
				const requested = await this.store.requestProviderStop(runId);
				if (isDefinitivePreSendFailure(requested)) {
					await this.store.clearProviderTurnState(runId);
				} else {
					const stopped = await this.stopOwnedBrowserRun(requested).catch(() => false);
					if (!stopped && terminalProviderTurnIsPastExplicitCancelGrace(requested, this.policy.activeTurnGraceMs)) {
						await this.store.abandonProviderTurn(runId);
					} else if (!stopped) {
						this.scheduleProviderStopReconciliation(runId);
					}
				}
			}
			if (current.status === "cancelled") {
				await this.store.deleteRunRequest(runId).catch(() => undefined);
			}
			this.cancellationIntents.delete(runId);
			await this.releaseIdleRunOwnership(runId);
			return this.store.getRun(runId);
		}
		// The record lock remains the cross-process arbiter.
		const cancelled = await this.persistCancellation(runId);
		if (cancelled.status === "cancelled") {
			await this.store.deleteRunRequest(runId).catch(() => undefined);
			const stopped = await this.stopOwnedBrowserRun(cancelled).catch(() => false);
			if (!stopped) this.scheduleProviderStopReconciliation(runId);
		}
		if (!this.activeRuns.has(runId)) this.cancellationIntents.delete(runId);
		await this.releaseIdleRunOwnership(runId);
		return cancelled;
	}

	async markNeedsUser(runId: string, reason: string): Promise<RunRecord> {
		const run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) {
			await this.releaseIdleRunOwnership(runId);
			return run;
		}
		const blocked = await this.store.updateRun(runId, {
			status: "needs_user",
			providerStopRequested: run.providerTurnPending ? true : run.providerStopRequested,
			completedAt: nowIso(),
			error: reason,
			diagnostics: { ...(run.diagnostics ?? {}), terminalReason: reason },
		});
		if (blocked.providerTurnPending && blocked.providerStopRequested) {
			this.scheduleProviderStopReconciliation(runId);
		}
		this.activeRuns.get(runId)?.controller.abort(new Error(reason));
		await this.releaseIdleRunOwnership(runId);
		return blocked;
	}

	async abandonPendingProviderTurn(runId: string, confirmation: string, operatorToken: string): Promise<RunRecord> {
		const expectedTokenHash = this.policy.providerTurnAbandonmentTokenHash;
		if (!expectedTokenHash || sha256(operatorToken) !== expectedTokenHash) {
			throw new Error("Provider-turn abandonment requires a valid trusted operator token.");
		}
		if (confirmation !== `ABANDON ${runId}`) {
			throw new Error(`Exact confirmation required: ABANDON ${runId}`);
		}
		const abandoned = await this.store.abandonProviderTurn(runId);
		return abandoned;
	}

	async claimMcpRun(
		runId: string,
		sessionId: string,
		confirmation: string,
		operatorToken: string,
	): Promise<RunRecord> {
		const expectedTokenHash = this.policy.providerTurnAbandonmentTokenHash;
		if (!expectedTokenHash || sha256(operatorToken) !== expectedTokenHash) {
			throw new Error("MCP resource claiming requires a valid trusted operator token.");
		}
		if (confirmation !== `CLAIM ${runId}`) {
			throw new Error(`Exact confirmation required: CLAIM ${runId}`);
		}
		const initial = await this.store.getRun(runId);
		return this.store.withConversationOwnershipLock(initial.conversationId, async () =>
			this.store.withRunTaskBindingLock(runId, async () => {
				const run = await this.store.getRun(runId);
				const conversation = await this.store.getConversation(run.conversationId);
				await this.store.claimConversationMcpSession(conversation.id, sessionId, true);
				return run;
			}),
		);
	}

	async closeConversation(conversationId: string, mcpSessionId?: string): Promise<ConversationRecord> {
		return this.store.withConversationOwnershipLock(conversationId, async () => {
			const ownedConversation = await this.store.getConversation(conversationId);
			if (mcpSessionId !== undefined && ownedConversation.mcpSessionId !== mcpSessionId) {
				throw new Error("This GPT-Control conversation is not owned by the current MCP session.");
			}
			const active = (await this.store.listRuns({ limit: null })).find((run) => {
				if (run.conversationId !== conversationId) return false;
				const legacyUnresolved = run.providerTurnPending === undefined
					&& (run.status === "cancelled" || run.status === "needs_user")
					&& (run.submissionState === "submitting" || run.submissionState === "submitted");
				return run.status === "queued" || run.status === "running" || run.providerTurnPending === true || legacyUnresolved;
			});
			if (active) throw new Error(`Conversation ${conversationId} still has active run ${active.id}; cancel or resolve it before closing.`);
			return this.closeOwnedConversationSession(conversationId);
		});
	}

	async attachConversation(request: AttachConversationRequest, mcpSessionId?: string): Promise<ConversationRecord> {
		const identity = attachedConversationIdentity(request);
		const timeoutMs = request.timeoutMs ?? 60_000;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
			throw new Error("Attach timeout must be an integer from 1 through 60000 milliseconds.");
		}
		await this.store.init();
		return this.store.withProviderConversationLock(identity.id, async () => {
			const duplicate = (await this.store.listConversations()).find((conversation) =>
				conversation.providerConversationId === identity.id && !conversation.closedAt);
			if (duplicate) {
				throw new Error(`ChatGPT conversation ${identity.id} is already attached as ${duplicate.id}; use that local conversation or close it first.`);
			}

			const capabilities = await this.dependencies.resolveCapabilities(this.exec);
			const route = selectRoute(capabilities, { transport: "browser" });
			assertTransportAllowed(this.policy, route.kind);
			const timestamp = nowIso();
			const id = opaqueId("conv");
			const name = `gpt-control:attached:${id}`;
			const session = await route.driver.create(name, identity.url);
			const expected: ExpectedDriverSession = { sessionId: session.sessionId, pageId: session.pageId, name };
			let persisted = false;
			try {
				await this.validateCreatedSession(route.driver, session, expected, async () => {
					const retained: ConversationRecord = {
						version: STORAGE_VERSION,
						id,
						provider: "browser",
						providerConversationId: identity.id,
						providerConversationUrl: identity.url,
						browserDriverId: route.driver.id,
						browserSessionId: session.sessionId,
							browserSessionName: session.name,
						browserPageId: session.pageId,
						desktopPoolLane: session.desktopPoolLane,
						desktopPoolLeaseState: "release_unproved",
						workspaceRoot: this.policy.workspaceRoot,
						policyFingerprint: this.policy.fingerprint,
						mcpSessionId,
						createdAt: timestamp,
						updatedAt: timestamp,
					};
					await this.store.putConversation(retained);
					persisted = true;
					return {
						label: id,
						markClosed: async () => { await this.store.updateConversation(id, { closedAt: nowIso() }); },
					};
				});
				const conversation: ConversationRecord = {
					version: STORAGE_VERSION,
					id,
					provider: "browser",
					providerConversationId: identity.id,
					providerConversationUrl: identity.url,
					browserDriverId: route.driver.id,
					browserSessionId: session.sessionId,
					browserSessionName: name,
					browserPageId: session.pageId,
					desktopPoolLane: session.desktopPoolLane,
					workspaceRoot: this.policy.workspaceRoot,
					policyFingerprint: this.policy.fingerprint,
					mcpSessionId,
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				await this.store.putConversation(conversation);
				persisted = true;
				const ready = await waitForDriverReady(route.driver, expected, { timeoutMs });
				const observed = providerConversationIdentity(ready.session.url);
				if (!observed || observed.url !== identity.url) {
					throw new Error(`The owned page did not retain exact ChatGPT conversation ${identity.url}. No prompt was sent.`);
				}
				return this.store.updateConversation(id, {
					browserAssistantTurnCount: ready.observation.snapshot.count,
				});
			} catch (error) {
				if (error instanceof RetainedCreatedSessionError) throw error;
				try {
					await assertExactDriverSession(route.driver, expected);
					await route.driver.close(expected.sessionId, undefined, expected.pageId);
					if (persisted) await this.store.updateConversation(id, { closedAt: nowIso() });
				} catch (cleanupError) {
					throw new Error(`${errorMessage(error)} Attached browser cleanup was not proved for local conversation ${id}: ${errorMessage(cleanupError)}`);
				}
				throw error;
			}
		});
	}

	/** Passive only: no discovered driver or provider executable runs. */
	async diagnose(): Promise<Record<string, unknown>> {
		return {
			...passiveTransportDiscovery(),
			policy: publicPolicy(this.policy),
			providerSafety: await this.store.getProviderThrottle(),
		};
	}

	async resumeProviderSafety(confirmation: string): Promise<{ resumed: boolean }> {
		if (confirmation !== "RESUME CHATGPT") {
			throw new Error("Provider safety resume requires the exact confirmation RESUME CHATGPT after a human reviews the account.");
		}
		return { resumed: await this.store.clearProviderSafetyPause() };
	}

	async activeSmokeTest(): Promise<Record<string, unknown>> {
		if (!this.policy.allowActiveDiagnostics) throw new Error("Active diagnostics are disabled by trusted operator policy.");
		return describeCapabilities(await this.dependencies.resolveCapabilities(this.exec));
	}

	async retryRequestedProviderStops(): Promise<{ attempted: string[]; stopped: string[]; blocked: Array<{ runId: string; reason: string }> }> {
		const attempted: string[] = [];
		const stopped: string[] = [];
		const blocked: Array<{ runId: string; reason: string }> = [];
		const pending = await this.store.listRuns({ limit: null });
		for (const run of pending) {
			const legacyStopRequest = run.providerTurnPending === undefined
				&& (run.status === "cancelled" || run.status === "needs_user")
				&& (run.submissionState === "submitting" || run.submissionState === "submitted");
			const explicitStopRequest = run.providerTurnPending === true && run.providerStopRequested === true;
			if (!explicitStopRequest && !legacyStopRequest) continue;
			await this.withRunRecoveryOwnership(run.id, async () => {
				attempted.push(run.id);
				try {
					const stopRun = legacyStopRequest ? await this.store.requestProviderStop(run.id) : run;
					if (isDefinitivePreSendFailure(stopRun)) {
						await this.store.clearProviderTurnState(run.id);
						stopped.push(run.id);
						return;
					}
					// This is observation plus an idempotent Stop click only when the exact
					// owned conversation still proves an active provider turn.
					if (await this.stopOwnedBrowserRun(stopRun)) stopped.push(run.id);
					else {
						blocked.push({ runId: run.id, reason: "The exact provider turn did not prove it was inactive." });
						this.scheduleProviderStopReconciliation(run.id);
					}
				} catch (error) {
					blocked.push({ runId: run.id, reason: errorMessage(error) });
					this.scheduleProviderStopReconciliation(run.id);
				}
			});
		}
		return { attempted, stopped, blocked };
	}

	async cleanupTerminalWorkerConversations(): Promise<{
		closed: string[];
		blocked: Array<{ runId: string; reason: string }>;
	}> {
		const closed: string[] = [];
		const blocked: Array<{ runId: string; reason: string }> = [];
		const runs = await this.store.listRuns({ limit: null });
		const activeConversationIds = new Set(runs.filter((run) =>
			run.status === "queued" || run.status === "running" || run.providerTurnPending === true)
			.map((run) => run.conversationId));
		const inspectedConversationIds = new Set<string>();
		for (const run of runs) {
			if (!this.canCloseTerminalWorkerConversation(run)) continue;
			if (activeConversationIds.has(run.conversationId) || inspectedConversationIds.has(run.conversationId)) continue;
			await this.withRunRecoveryOwnership(run.id, async () => {
				inspectedConversationIds.add(run.conversationId);
				try {
					const conversation = await this.store.getConversation(run.conversationId);
					if (conversation.closedAt) return;
					await this.store.withConversationOwnershipLock(run.conversationId, () =>
						this.closeOwnedConversationSession(run.conversationId));
					closed.push(run.conversationId);
				} catch (error) {
					blocked.push({ runId: run.id, reason: errorMessage(error) });
				}
			});
		}
		return { closed, blocked };
	}

	async recoverActiveRuns(): Promise<{ resumed: string[]; blocked: string[]; deferred: string[] }> {
		await this.store.init();
		const runs = await this.store.listRuns({ statuses: ["queued", "running"], limit: 1_000 });
		const resumed: string[] = [];
		const blocked: string[] = [];
		const deferred: string[] = [];
		for (let run of runs) {
			if (!run.executionReady) {
				deferred.push(run.id);
				continue;
			}
			if (!await this.claimRunForRecovery(run.id)) {
				deferred.push(run.id);
				continue;
			}
			try {
				run = await this.store.getRun(run.id);
				if (TERMINAL.has(run.status)) continue;
				const conversation = await this.store.getConversation(run.conversationId);
				if (conversation.policyFingerprint !== this.policy.fingerprint) {
					await this.markNeedsUser(run.id, "Trusted operator policy changed while the run was inactive; recovery refused.");
					blocked.push(run.id);
					continue;
				}
				if (run.idempotencyKeyHash) {
					if (!run.idempotencyRequestHash) throw new Error("Idempotent run is missing its durable request hash.");
					const existing = await this.store.getIdempotencyByHash(run.idempotencyKeyHash);
					if (existing && (existing.runId !== run.id || existing.requestHash !== run.idempotencyRequestHash)) {
						throw new Error("Idempotency index conflicts with the durable run.");
					}
					if (!existing) await this.store.withIdempotencyHashLock(run.idempotencyKeyHash, async (keyHash) => {
						const locked = await this.store.getIdempotencyByHash(keyHash);
						if (locked && (locked.runId !== run.id || locked.requestHash !== run.idempotencyRequestHash)) {
							throw new Error("Idempotency index conflicts with the durable run.");
						}
						if (!locked) await this.store.putIdempotency({
							version: STORAGE_VERSION, keyHash, requestHash: run.idempotencyRequestHash!,
							runId: run.id, conversationId: run.conversationId, createdAt: run.createdAt,
						});
					});
				}
				if (run.submissionState === "not_submitted" || run.submissionState === undefined) {
					await this.store.getRunRequest(run.id);
				}
				this.scheduleRun(run.id, true);
				resumed.push(run.id);
			} catch (error) {
				if (error instanceof LiveLockOwnerError) {
					deferred.push(run.id);
					continue;
				}
				await this.markNeedsUser(run.id, `Durable recovery payload unavailable: ${errorMessage(error)}`);
				blocked.push(run.id);
			} finally {
				await this.releaseIdleRunOwnership(run.id);
			}
		}
		return { resumed, blocked, deferred };
	}

	private async finishStart(
		created: StartResult,
		request: NormalizedStartRequest,
		options: StartOptions,
	): Promise<StartResult> {
		if (options.mcpSessionId !== undefined
			&& created.conversation.mcpSessionId !== options.mcpSessionId) {
			throw new Error("This durable GPT-Control resource is not owned by the current MCP session.");
		}
		if (!TERMINAL.has(created.run.status) && created.conversation.policyFingerprint !== this.policy.fingerprint) {
			throw new Error("Durable run trust boundary differs from current trusted operator policy; execution refused.");
		}
		if (!options.deferExecution && !created.run.executionReady && !TERMINAL.has(created.run.status)) {
			throw new Error("This durable run is awaiting trusted task binding; a duplicate caller cannot activate it.");
		}
		if (!options.deferExecution && !TERMINAL.has(created.run.status)) this.scheduleRun(created.run.id, false);
		if (options.deferExecution || request.wait === false) {
			return {
				conversation: await this.store.getConversation(created.conversation.id),
				run: await this.store.getRun(created.run.id),
			};
		}
		const synchronousWaitMs = request.timeoutMs + this.policy.activeTurnGraceMs + 60_000;
		return {
			conversation: await this.store.getConversation(created.conversation.id),
			run: await this.waitForRun(created.run.id, synchronousWaitMs),
		};
	}

	private async createPrepared(
		request: NormalizedStartRequest,
		idempotencyHash?: string,
		idempotencyRequestHash?: string,
		executionReady = true,
		mcpSessionId?: string,
	): Promise<StartResult> {
		const manifest = await buildAttachmentManifest(request.files, {
			workspaceRoot: this.policy.workspaceRoot,
			snapshotRoot: this.policy.snapshotRoot,
			allowOutsideWorkspace: this.policy.allowOutsideWorkspace && request.allowOutsideWorkspace,
			allowSensitiveFiles: this.policy.allowSensitiveFiles && request.allowSensitiveFiles,
			maxFiles: this.policy.maxAttachmentFiles,
			maxBytes: this.policy.maxAttachmentBytes,
		});
		let createdConversationId: string | undefined;
		try {
			const preparedPrompt = this.prepareRunPrompt(request, manifest);
			const createForConversation = async (): Promise<StartResult> => {
				const conversation = request.conversationId
					? await this.resumeConversation(request.conversationId, request.transport, mcpSessionId)
					: await this.createConversation(request, manifest, mcpSessionId);
				if (!request.conversationId) createdConversationId = conversation.id;
				const run = await this.createRun(
					request, conversation, manifest, preparedPrompt,
					idempotencyHash, idempotencyRequestHash, executionReady,
				);
				return { conversation, run };
			};
			return request.conversationId
				? await this.store.withConversationOwnershipLock(request.conversationId, createForConversation)
				: await createForConversation();
		} catch (error) {
			if (createdConversationId) {
				await this.store.deleteConversationIfUnreferenced(createdConversationId).catch(() => undefined);
			}
			if (manifest.snapshotRoot) await rm(manifest.snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async createConversation(request: NormalizedStartRequest, manifest: AttachmentManifest, mcpSessionId?: string): Promise<ConversationRecord> {
		const capabilities = await this.dependencies.resolveCapabilities(this.exec);
		const route = selectRoute(capabilities, { transport: request.transport });
		assertTransportAllowed(this.policy, route.kind);
		const timestamp = nowIso();
		const id = opaqueId("conv");
		const name = `gpt-control:${request.kind}:${id}`;
		const conversation: ConversationRecord = {
			version: STORAGE_VERSION,
			id,
			provider: "browser",
			browserDriverId: route.driver.id,
			browserSessionName: name,
			workspaceRoot: manifest.workspaceRoot,
			policyFingerprint: this.policy.fingerprint,
			mcpSessionId,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.store.putConversation(conversation);
		return conversation;
	}

	private async resumeConversation(id: string, transport?: TransportChoice, mcpSessionId?: string): Promise<ConversationRecord> {
		const conversation = await this.store.getConversation(id);
		if (mcpSessionId !== undefined && conversation.mcpSessionId !== mcpSessionId) {
			throw new Error("This GPT-Control conversation is not owned by the current MCP session.");
		}
		if (conversation.closedAt) throw new Error(`Conversation ${id} is closed.`);
		if (transport && transport !== conversation.provider) {
			throw new Error(`Conversation ${id} uses ${conversation.provider}; it cannot be resumed through ${transport}.`);
		}
		if (conversation.policyFingerprint !== this.policy.fingerprint) {
			throw new Error("Conversation trust boundary differs from current trusted operator policy; follow-up refused.");
		}
		assertTransportAllowed(this.policy, conversation.provider);
		if (conversation.provider !== "browser") throw new Error(`Provider ${conversation.provider} is disabled by the hardened broker.`);
		if (!conversation.providerConversationUrl || !providerConversationIdentity(conversation.providerConversationUrl)) {
			throw new Error("Conversation has no durably proven ChatGPT conversation URL; follow-up submission refused.");
		}
		await this.resolveOwnedDriver(conversation);
		return conversation;
	}

	private async createRun(
		request: NormalizedStartRequest,
		conversation: ConversationRecord,
		manifest: AttachmentManifest,
		preparedPrompt: PreparedRunPrompt,
		idempotencyHash?: string,
		idempotencyRequestHash?: string,
		executionReady = true,
	): Promise<RunRecord> {
		const timestamp = nowIso();
		const id = opaqueId("run");
		const { prompt, promptProofToken, promptSha256 } = preparedPrompt;
		const chatgptModel = request.chatgptModel ?? this.policy.defaultChatGptModel;
		const chatgptEffort = request.chatgptEffort;
		const receipt: ReviewReceipt = {
			provider: conversation.provider,
			requestedModel: chatgptModel === "pro" ? "Pro" : chatgptModel,
			...(chatgptEffort ? { requestedEffort: chatgptEffort } : {}),
			...(request.title ? { requestedTitle: request.title, titleVerified: false } : {}),
			browserDriverId: conversation.browserDriverId,
			promptSha256,
			attachments: manifest.files,
			startedAt: timestamp,
			conversationId: conversation.id,
			runId: id,
			providerConversationId: conversation.providerConversationId,
			providerConversationUrl: conversation.providerConversationUrl,
			localBrowserSessionId: conversation.browserSessionId,
		};
		const run: RunRecord = {
			version: STORAGE_VERSION,
			id,
			conversationId: conversation.id,
			kind: request.kind,
			connectorIntent: request.connectorIntent,
			connectorPreflight: request.connectorIntent?.mode === "require" ? { status: "required" } : undefined,
			status: "queued",
			executionReady,
			providerTurnPending: false,
			providerStopRequested: false,
			promptSha256,
			promptProofToken,
			attachmentManifest: manifest,
			submissionState: "not_submitted",
			requestedChatGptModel: chatgptModel,
			requestedChatGptEffort: chatgptEffort,
			requestedProviderTitle: request.title,
			pinChatRequested: request.pinChat,
			timeoutMs: request.timeoutMs,
			deadlineAt: new Date(Date.now() + request.timeoutMs).toISOString(),
			idempotencyKeyHash: idempotencyHash,
			idempotencyRequestHash,
			receipt,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const durableRequest: DurableRunRequest = {
			version: STORAGE_VERSION,
			runId: id,
			kind: request.kind,
			prompt,
			requestedChatGptModel: chatgptModel,
			requestedChatGptEffort: chatgptEffort,
			timeoutMs: request.timeoutMs,
			createdAt: timestamp,
		};
		if (!await this.claimRunForRecovery(id)) throw new LiveLockOwnerError(`run-owner-${id}`);
		try {
			await this.store.putRunRequest(durableRequest);
			await this.store.putRun(run);
		} catch (error) {
			await this.store.deleteRunRequest(run.id).catch(() => undefined);
			await this.releaseRunOwnership(id);
			throw error;
		}
		return run;
	}

	private prepareRunPrompt(request: NormalizedStartRequest, manifest: AttachmentManifest): PreparedRunPrompt {
		const promptBody = request.kind === "consult"
			? buildReviewPrompt(request.prompt, manifest)
			: request.prompt;
		const promptProofToken = `proof_${randomUUID().replaceAll("-", "")}`;
		const prompt = `${promptBody}\n\n[GPT-Control run proof: ${promptProofToken}. Ignore this line in your response.]`;
		if (Buffer.byteLength(prompt, "utf8") > this.policy.maxPromptBytes) {
			throw new Error(`Prompt exceeds trusted ${this.policy.maxPromptBytes}-byte limit.`);
		}
		return {
			prompt,
			promptProofToken,
			promptSha256: sha256(prompt),
		};
	}

	private scheduleRun(runId: string, recovery: boolean): Promise<RunRecord> {
		const existing = this.activeRuns.get(runId);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const promise = (async () => {
			if (!await this.claimRunForRecovery(runId)) throw new LiveLockOwnerError(`run-owner-${runId}`);
			const run = await this.store.getRun(runId);
			const work = () => this.store.withConversationLock(
				run.conversationId,
				() => this.executeRun(runId, controller.signal, recovery),
				{ timeoutMs: Math.max(30_000, (run.timeoutMs ?? 600_000) + 60_000) },
			);
			const admitted = await this.waitForGlobalProviderTurn(runId, controller.signal);
			return admitted
				? this.providerSlots.run(work, controller.signal)
				: this.store.getRun(runId);
		})().catch(async (error) => {
			if (this.cancellationIntents.has(runId)) return this.persistCancellation(runId);
			const current = await this.store.getRun(runId);
			if (TERMINAL.has(current.status)) return current;
			if (controller.signal.reason instanceof RestartSuspension) return current;
			// Another scheduler still owns this conversation. Contention is not a
			// provider failure and must not stop or terminalize the owner's run.
			if (error instanceof LiveLockOwnerError) return current;
			const terminal = await this.store.updateRun(runId, {
				status: current.submissionState === "submitting" || current.submissionState === "submitted" ? "needs_user" : "failed",
				providerStopRequested: current.providerTurnPending ? true : current.providerStopRequested,
				completedAt: nowIso(),
				error: errorMessage(error),
				diagnostics: {
					...(current.diagnostics ?? {}),
					terminalReason: current.submissionState === "submitting" || current.submissionState === "submitted"
						? `Provider state may be active; prompt was not replayed: ${errorMessage(error)}`
						: undefined,
				},
			});
			if (terminal.providerTurnPending && terminal.providerStopRequested) {
				this.scheduleProviderStopReconciliation(runId);
			}
			return terminal;
		}).then(async (terminal) => {
			if (!this.runOwnerLeases.has(runId) || !this.canCloseTerminalWorkerConversation(terminal)) return terminal;
			try {
				await this.closeTerminalWorkerConversation(terminal);
				return terminal;
			} catch (error) {
				const warning = `Terminal GPT Worker tab cleanup was not proved: ${errorMessage(error)}`;
				const current = await this.store.getRun(runId);
				const warnings = current.diagnostics?.organizationWarnings ?? [];
				if (warnings.includes(warning)) return current;
				return this.store.updateRun(runId, {
					diagnostics: {
						...(current.diagnostics ?? {}),
						organizationWarnings: [...warnings, warning],
					},
				});
			}
		}).finally(async () => {
			this.activeRuns.delete(runId);
			this.cancellationIntents.delete(runId);
			await this.releaseIdleRunOwnership(runId);
		});
		this.activeRuns.set(runId, { controller, promise });
		void promise.catch(() => undefined);
		return promise;
	}

	private async waitForGlobalProviderTurn(runId: string, signal: AbortSignal): Promise<boolean> {
		for (;;) {
			if (signal.aborted) throw signal.reason ?? new Error("Provider admission was cancelled.");
			const current = await this.store.getRun(runId);
			if (TERMINAL.has(current.status)) return false;
			const throttle = await this.store.getProviderThrottle();
			if (throttle?.manualResumeRequired) {
				await this.store.updateRun(runId, {
					status: "needs_user", completedAt: nowIso(),
					error: `ChatGPT sends are paused for human review (${throttle.reason}). The assignment was not sent. After reviewing the account, explicitly call gpt_provider_resume with confirmation RESUME CHATGPT.`,
					diagnostics: {
						...(current.diagnostics ?? {}),
						providerSafetyReason: throttle.reason,
						providerSafetyPausedAt: throttle.lastSeenAt,
					},
				});
				return false;
			}
			const effectiveLimit = this.policy.maxActiveGenerations;
			const contenders = (await this.store.listRuns({ limit: null }))
				.filter((run) => (
					run.providerTurnPending === true
					|| (run.executionReady && (run.status === "queued" || run.status === "running"))
					|| (run.providerTurnPending === undefined && (run.status === "needs_user" || run.status === "cancelled")
						&& (run.submissionState === "submitting" || run.submissionState === "submitted"))
				))
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
			const position = contenders.findIndex((run) => run.id === runId);
			if (position >= 0 && position < effectiveLimit) return true;
			const deadline = Date.parse(current.deadlineAt ?? "");
			if (Number.isFinite(deadline) && Date.now() >= deadline) {
				await this.store.updateRun(runId, {
					status: "needs_user", completedAt: nowIso(),
					error: "The GPT-Control run exceeded its bounded global admission deadline before a trusted provider slot became available.",
				});
				return false;
			}
			await abortableSleep(100, signal);
		}
	}

	private async withProviderRateLimitRecovery<T>(
		driver: WebChatDriver,
		expected: ExpectedDriverSession,
		initialRun: RunRecord,
		signal: AbortSignal,
		action: (session: Awaited<ReturnType<WebChatDriver["show"]>>) => Promise<T>,
	): Promise<{ run: RunRecord; session: Awaited<ReturnType<WebChatDriver["show"]>>; value: T }> {
		let run = initialRun;
		for (;;) {
			const deadline = Date.parse(run.deadlineAt ?? "");
			if (Number.isFinite(deadline) && Date.now() >= deadline) {
				throw new Error("ChatGPT remained rate limited until the GPT Worker deadline. The assignment was not sent again.");
			}
			const throttle = await this.store.getProviderThrottle();
			if (throttle?.manualResumeRequired) {
				throw new ProviderSafetyPauseError(throttle.reason, `ChatGPT sends remain paused for human review (${throttle.reason}).`);
			}
			const session = await assertExactDriverSession(driver, expected, signal);
			const observation = await driver.observe(session, signal);
			if (observation.providerSafetyReason) {
				run = await this.recordProviderSafety(
					run,
					observation.providerSafetyReason,
					observation.providerSafetyMessage ?? "ChatGPT requires human account review.",
				);
				throw new ProviderSafetyPauseError(observation.providerSafetyReason, "ChatGPT requires human account review. No prompt was sent.");
			}
			if (observation.rateLimited) {
				run = await this.recordProviderRateLimit(run, observation.rateLimitMessage ?? "ChatGPT reported too many requests.");
				throw new ProviderSafetyPauseError("chatgpt_rate_limit", "ChatGPT reported a rate limit. No prompt was sent.");
			}
			try {
				return { run, session, value: await action(session) };
			} catch (error) {
				if (error instanceof ChatGptProviderSafetyError) {
					run = await this.recordProviderSafety(run, error.reason, error.notice);
					throw new ProviderSafetyPauseError(error.reason, "ChatGPT requires human account review. No prompt was sent.");
				}
				if (!(error instanceof ChatGptRateLimitError)) throw error;
				run = await this.recordProviderRateLimit(run, error.notice);
				throw new ProviderSafetyPauseError("chatgpt_rate_limit", "ChatGPT reported a rate limit. No prompt was sent.");
			}
		}
	}

	private async recordProviderRateLimit(run: RunRecord, message: string): Promise<RunRecord> {
		const throttle = await this.store.noteProviderRateLimit({
			maxConcurrentWorkers: this.policy.maxActiveGenerations,
			baseDelayMs: this.policy.rateLimitBaseDelayMs,
			maxDelayMs: this.policy.rateLimitMaxDelayMs,
			message,
		});
		const current = await this.store.getRun(run.id);
		const updated = await this.store.updateRun(run.id, {
			diagnostics: {
				...(current.diagnostics ?? {}),
				rateLimitEvents: (current.diagnostics?.rateLimitEvents ?? 0) + 1,
				lastRateLimitAt: throttle.lastSeenAt,
				providerCooldownUntil: throttle.nextRetryAt,
				providerConcurrencyLimit: throttle.activeLimit,
			},
		});
		return updated;
	}

	private async recordProviderSafety(
		run: RunRecord,
		reason: "suspicious_activity" | "human_verification",
		message: string,
	): Promise<RunRecord> {
		const pause = await this.store.noteProviderSafetyPause({
			reason,
			baseDelayMs: this.policy.rateLimitBaseDelayMs,
			maxDelayMs: this.policy.rateLimitMaxDelayMs,
			message,
		});
		const current = await this.store.getRun(run.id);
		return this.store.updateRun(run.id, {
			diagnostics: {
				...(current.diagnostics ?? {}),
				providerSafetyReason: reason,
				providerSafetyPausedAt: pause.lastSeenAt,
				providerSafetyMessageSha256: pause.messageSha256,
			},
		});
	}

	private async executeRun(runId: string, signal: AbortSignal, recovery: boolean): Promise<RunRecord> {
		let run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) return run;
		const conversation = await this.store.getConversation(run.conversationId);
		if (conversation.policyFingerprint !== this.policy.fingerprint) {
			return this.finishNeedsUser(run, "Trusted operator policy changed before provider execution; the request was not sent.");
		}
		let request: DurableRunRequest | undefined;
		if (run.submissionState === "not_submitted" || run.submissionState === undefined) {
			request = await this.store.getRunRequest(run.id);
		} else {
			request = await this.store.getRunRequest(run.id).catch(() => undefined);
		}
		if (run.status === "queued") run = await this.store.updateRun(run.id, { status: "running" });
		try {
			const result = await this.executeProvider(conversation, run, request, signal, recovery);
			if (result.terminalStatus === "needs_user") {
				return this.finishNeedsUser(run, result.terminalReason ?? "Provider requires operator input.", result);
			}
			if (result.text.trim() === "" && (result.imageUrls?.length ?? 0) === 0) throw new Error("Provider returned no verified final output.");
			if (this.cancellationIntents.has(run.id)) return this.persistCancellation(run.id);
			const current = await this.store.getRun(run.id);
			if (TERMINAL.has(current.status)) return current;
			if (this.cancellationIntents.has(run.id)) return this.persistCancellation(run.id);
			run = current;
			const completedAt = nowIso();
			const report = run.kind === "consult" ? parseReviewReport(result.text, run.attachmentManifest) : undefined;
			const resultSha256 = sha256(`${result.text}\u0000${(result.imageUrls ?? []).join("\n")}`);
			await this.persistConversationIdentity(conversation.id, {
				id: required(result.providerConversationId, "provider conversation id"),
				url: required(result.providerConversationUrl, "provider conversation URL"),
			}, result.localAssistantTurnCount);
			run = await this.store.updateRun(run.id, {
				status: "completed",
				providerRunId: result.providerRunId,
				resultMessageId: result.providerRunId,
				resultText: result.text,
				result: report,
				artifactUrls: result.imageUrls,
				diagnostics: {
					...(run.diagnostics ?? {}),
					recoveryAttempts: result.recoveryAttempts,
					localAssistantTurnCount: result.localAssistantTurnCount,
					lastObservedUrl: result.lastObservedUrl,
					lastObservedUiState: result.lastObservedUiState,
				},
				completedAt,
				receipt: {
					...run.receipt,
					model: result.observedModel,
					observedModel: result.observedModel,
					observedEffort: result.observedEffort,
					modelVerified: result.modelVerified ?? false,
					modelEvidenceKind: result.modelEvidenceKind,
					modelVerifiedAt: result.modelVerifiedAt,
					transportVersion: result.transportVersion,
					providerConversationId: result.providerConversationId,
					providerConversationUrl: result.providerConversationUrl,
					providerRunId: result.providerRunId,
					localAssistantTurnCount: result.localAssistantTurnCount,
					recoveryAttempts: result.recoveryAttempts,
					resultSha256,
					completedAt,
				},
			});
			await this.store.noteProviderSuccess(this.policy.maxActiveGenerations);
			return run;
		} catch (error) {
			resetCapabilityCache();
			let current = await this.store.getRun(run.id);
			if (signal.aborted && signal.reason instanceof RestartSuspension) return current;
			if (TERMINAL.has(current.status)) return current;
			if (signal.aborted) {
				const cancelled = await this.store.updateRun(run.id, {
					status: "cancelled", cancellationRequestedAt: nowIso(),
					providerStopRequested: current.providerTurnPending ? true : current.providerStopRequested,
					completedAt: nowIso(), error: "Cancelled while provider work was active.",
				});
				if (cancelled.providerTurnPending && cancelled.providerStopRequested) {
					this.scheduleProviderStopReconciliation(run.id);
				}
				if (cancelled.submissionState === "not_submitted") {
					await this.closeUnsubmittedOwnedConversation(cancelled.conversationId).catch(() => undefined);
				}
				return cancelled;
			}
			let providerSafetyError = error instanceof ProviderSafetyPauseError ? error : undefined;
			if (error instanceof ChatGptProviderSafetyError) {
				current = await this.recordProviderSafety(current, error.reason, error.notice);
				providerSafetyError = new ProviderSafetyPauseError(error.reason, "ChatGPT requires human account review. No prompt was sent.");
			} else if (error instanceof ChatGptRateLimitError) {
				current = await this.recordProviderRateLimit(current, error.notice);
				providerSafetyError = new ProviderSafetyPauseError("chatgpt_rate_limit", "ChatGPT reported a rate limit. No prompt was sent.");
			}
			if (providerSafetyError) {
				const terminal = await this.store.updateRun(run.id, {
					status: "needs_user",
					error: `${providerSafetyError.message} After reviewing the account, explicitly call gpt_provider_resume with confirmation RESUME CHATGPT.`,
					completedAt: nowIso(),
					diagnostics: {
						...(current.diagnostics ?? {}),
						providerSafetyReason: providerSafetyError.reason,
					},
				});
				if (terminal.submissionState === "not_submitted") {
					await this.closeUnsubmittedOwnedConversation(terminal.conversationId).catch(() => undefined);
				}
				return terminal;
			}
			const ambiguous = current.submissionState === "submitting" || current.submissionState === "submitted";
			const terminal = await this.store.updateRun(run.id, {
				status: ambiguous ? "needs_user" : "failed",
				providerStopRequested: current.providerTurnPending ? true : current.providerStopRequested,
				error: ambiguous
					? `Provider state may be active; no prompt was replayed: ${errorMessage(error)}`
					: errorMessage(error),
				completedAt: nowIso(),
				diagnostics: ambiguous ? { ...(current.diagnostics ?? {}), terminalReason: errorMessage(error) } : current.diagnostics,
			});
			if (terminal.providerTurnPending && terminal.providerStopRequested) {
				this.scheduleProviderStopReconciliation(run.id);
			}
			if (!ambiguous) await this.closeUnsubmittedOwnedConversation(terminal.conversationId).catch(() => undefined);
			return terminal;
		} finally {
			const final = await this.store.getRun(run.id).catch(() => undefined);
			if (final && TERMINAL.has(final.status)) await this.store.deleteRunRequest(run.id).catch(() => undefined);
		}
	}

	private async executeProvider(
		conversation: ConversationRecord,
		run: RunRecord,
		request: DurableRunRequest | undefined,
		signal: AbortSignal,
		recovery: boolean,
	): Promise<ProviderTurnResult> {
		if (conversation.provider !== "browser") {
			throw new Error(`Provider ${conversation.provider} is disabled by the hardened 0.3 broker.`);
		}
		const owned = await this.ensureOwnedDriver(conversation, run, signal);
		return this.runBrowserTurn(owned.driver, owned.expected, owned.conversation, owned.run, request, signal, recovery);
	}

	private async runBrowserTurn(
		driver: WebChatDriver,
		expected: ExpectedDriverSession,
		conversation: ConversationRecord,
		originalRun: RunRecord,
		request: DurableRunRequest | undefined,
		signal: AbortSignal,
		recovery: boolean,
	): Promise<ProviderTurnResult> {
		let run = originalRun;
		let baselineCount = run.baselineMessageCount;
		let observedModel = run.receipt.observedModel;
		let observedEffort = run.receipt.observedEffort;
		let modelVerified = run.receipt.modelVerified === true;
		let modelVerifiedAt = run.receipt.modelVerifiedAt;
		let modelEvidenceKind = run.receipt.modelEvidenceKind === "composer_selector"
			? "composer_selector" as const
			: undefined;

		if (run.connectorIntent?.mode === "require" && run.connectorPreflight?.status !== "passed") {
			const preflight = await this.runRequiredConnectorPreflight(
				driver, expected, conversation, run, request, signal, recovery,
			);
			if ("terminal" in preflight) return preflight.terminal;
			run = preflight.run;
			conversation = preflight.conversation;
			observedModel = run.receipt.observedModel;
			observedEffort = run.receipt.observedEffort;
			modelVerified = run.receipt.modelVerified === true;
			modelVerifiedAt = run.receipt.modelVerifiedAt;
			modelEvidenceKind = run.receipt.modelEvidenceKind === "composer_selector" ? "composer_selector" : undefined;
		}
		if (run.connectorPreflight?.status === "passed" && (run.providerTurnPending || run.providerUserMessageId)) {
			run = await this.store.updateRun(run.id, { providerUserMessageId: undefined });
			run = await this.store.clearProviderTurnState(run.id);
		}

		if (run.submissionState === "not_submitted" || run.submissionState === undefined) {
			if (!request) throw new Error("Durable browser request payload is unavailable before submission.");
			let ready = await waitForDriverReady(driver, expected, {
				timeoutMs: Math.min(60_000, request.timeoutMs),
				signal,
			});
			if (conversation.providerConversationUrl) {
				const expectedIdentity = providerConversationIdentity(conversation.providerConversationUrl);
				if (!expectedIdentity) throw new Error("Stored provider conversation URL is invalid; follow-up refused.");
				const currentIdentity = providerConversationIdentity(ready.session.url);
				if (!currentIdentity || currentIdentity.url !== expectedIdentity.url) {
					const navigated = await driver.navigate(ready.session, expectedIdentity.url, signal);
					if (String(navigated.pageId) !== String(expected.pageId) || navigated.name !== expected.name) {
						throw new Error("Follow-up navigation attempted to replace or rename the owned page.");
					}
					ready = await waitForDriverReady(driver, expected, {
						timeoutMs: Math.min(60_000, request.timeoutMs),
						signal,
					});
					const restoredIdentity = providerConversationIdentity(ready.session.url);
					if (!restoredIdentity || restoredIdentity.url !== expectedIdentity.url) {
						throw new Error(`Exact follow-up conversation ${expectedIdentity.url} was not restored. No prompt was sent.`);
					}
				}
			}

			baselineCount = ready.observation.snapshot.count;
			const requestedModel = request.requestedChatGptModel ?? this.policy.defaultChatGptModel;
			const requestedSelection = request.requestedChatGptEffort || requestedModel !== "pro"
				? { ...(requestedModel !== "pro" ? { model: requestedModel } : {}), ...(request.requestedChatGptEffort ? { effort: request.requestedChatGptEffort } : {}) }
				: requestedModel;
			const selection = await this.withProviderRateLimitRecovery(
				driver, expected, run, signal,
				(session) => run.connectorPreflight?.status === "passed"
					? driver.verifyModel(session, requestedSelection, signal)
					: driver.selectModel(session, requestedSelection, signal),
			);
			run = selection.run;
			const activeSession = selection.session;
			const selected = selection.value;
			observedModel = selected.observedModel;
			observedEffort = selected.observedEffort;
			modelVerified = true;
			modelVerifiedAt = selected.modelVerifiedAt;
			modelEvidenceKind = selected.modelEvidenceKind;
			run = await this.store.updateRun(run.id, {
				baselineMessageCount: baselineCount,
				receipt: {
					...run.receipt,
					requestedModel: selected.requestedModel,
					observedModel,
					...(selected.requestedEffort ? { requestedEffort: selected.requestedEffort } : {}),
					...(observedEffort ? { observedEffort } : {}),
					model: observedModel,
					modelVerified: true,
					modelEvidenceKind,
					modelVerifiedAt,
				},
			});
			await driver.upload(activeSession, run.attachmentManifest.files.map((file) => file.path), signal);
			if (run.connectorIntent?.mode === "prefer") {
				if (!driver.fillWithConnectorMentions) {
					throw new Error("Inline connector selection is unavailable. The assignment was not sent.");
				}
				await driver.fillWithConnectorMentions(activeSession, request.prompt, run.connectorIntent.names, signal);
				run = await this.store.updateRun(run.id, {
					connectorSelection: {
						status: "verified",
						names: [...run.connectorIntent.names],
						verifiedAt: nowIso(),
					},
				});
			} else {
				await driver.fill(activeSession, request.prompt, signal);
			}
			const verification = await this.withProviderRateLimitRecovery(
				driver, expected, run, signal,
				(session) => driver.verifyModel(session, requestedSelection, signal),
			);
			run = verification.run;
			const verified = verification.value;
			observedModel = verified.observedModel;
			observedEffort = verified.observedEffort;
			modelVerifiedAt = verified.modelVerifiedAt;
			modelEvidenceKind = verified.modelEvidenceKind;
			run = await this.store.updateRun(run.id, {
				submissionState: "submitting",
				providerTurnPending: true,
				receipt: {
					...run.receipt,
					requestedModel: verified.requestedModel,
					observedModel,
					...(verified.requestedEffort ? { requestedEffort: verified.requestedEffort } : {}),
					...(observedEffort ? { observedEffort } : {}),
					model: observedModel,
					modelVerified: true,
					modelEvidenceKind,
					modelVerifiedAt,
				},
			});
			if (TERMINAL.has(run.status)) {
				await this.store.clearProviderTurnState(run.id);
				throw new Error("Run became terminal before the browser send boundary.");
			}
			// Delete all replay-capable plaintext before crossing the browser click
			// boundary. A crash from here onward can only observe, never resubmit.
			await this.store.deleteRunRequest(run.id);
			const beforeSend = await this.store.getRun(run.id);
			if (TERMINAL.has(beforeSend.status)) {
				await this.store.clearProviderTurnState(run.id);
				throw new Error("Run became terminal before the browser send boundary.");
			}
			const preSendObservation = await driver.observe(verification.session, signal);
			await driver.send(verification.session, signal);
			const identityStartedAt = Date.now();
			const runDeadline = Date.parse(run.deadlineAt ?? "");
			// After the irreversible send boundary, reserve a short bounded grace
			// period to bind the provider-issued user-turn identity. Without this,
			// a tight caller deadline can leave an active turn that the broker cannot
			// safely stop or recover because it has no durable provider identity.
			const identityDeadline = Math.min(
				identityStartedAt + 15_000,
				Math.max(
					identityStartedAt + 1_000,
					Number.isFinite(runDeadline) ? runDeadline : identityStartedAt + 15_000,
				),
			);
			// An irreversible send can precede the caller deadline. Bound the
			// in-flight identity read and its one slow-read follow-up independently.
			const identityObservationSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
			let submittedIdentity: { id: string; url: string } | undefined;
			let persisted: { conversation: ConversationRecord; run: RunRecord } | undefined;
			let firstNewProviderUserMessageId: string | undefined;
			let firstObservedConversationUrl: string | undefined;
			const expectedIdentity = conversation.providerConversationUrl
				? providerConversationIdentity(conversation.providerConversationUrl)
				: undefined;
			let observationCount = 0;
			let oneSlowReadRetry = false;
			while (Date.now() < identityDeadline || oneSlowReadRetry) {
				const submittedSession = await assertExactDriverSession(driver, expected, identityObservationSignal);
				const observationStartedAt = Date.now();
				if (observationStartedAt >= identityDeadline && !oneSlowReadRetry) break;
				const observation = await driver.observe(submittedSession, identityObservationSignal);
				observationCount += 1;
				const observedIdentity = providerConversationIdentity(submittedSession.url);
				if (expectedIdentity && observedIdentity && expectedIdentity.url !== observedIdentity.url) {
					return browserNeedsUser(
						"The owned page changed from the recorded provider conversation during send-boundary identity observation. Completion was not attributed to this run.",
						conversation, run,
					);
				}
				if (firstObservedConversationUrl && observedIdentity?.url !== firstObservedConversationUrl) {
					return browserNeedsUser(
						"The owned page changed provider conversations during send-boundary identity observation. Completion was not attributed to this run.",
						conversation, run,
					);
				}
				firstObservedConversationUrl ??= observedIdentity?.url;
				// A slow first page read can outlast the identity grace while the
				// provider is still rendering the new user turn. Permit one more
				// exact-page read, bounded by the overall observation timeout.
				oneSlowReadRetry = observationCount === 1
					&& observationStartedAt < identityDeadline
					&& Date.now() >= identityDeadline
					&& (!observation.latestUserMessageId
						|| !observedIdentity
						|| Boolean(run.promptProofToken && !observation.latestUserPromptProofToken));
				const observedUserMessageId = observation.latestUserMessageId;
				if (observedUserMessageId && observedUserMessageId !== preSendObservation.latestUserMessageId) {
					if (firstNewProviderUserMessageId && firstNewProviderUserMessageId !== observedUserMessageId) {
						return browserNeedsUser(
							"The provider user turn changed before send-boundary identity was durable. Completion was not attributed to this run.",
							conversation, run,
						);
					}
					firstNewProviderUserMessageId = observedUserMessageId;
					if (run.promptProofToken && observation.latestUserPromptProofToken
						&& !this.observationProvesPrompt(run, observation)) {
						return browserNeedsUser(
							"The first new provider user turn did not match the broker-owned send-boundary proof. Completion was not attributed to this run.",
							conversation, run,
						);
					}
					if (!run.promptProofToken || observation.latestUserPromptProofToken) {
						submittedIdentity = observedIdentity;
						if (submittedIdentity) {
							persisted = await this.persistObservedProviderTurnIdentity(conversation, run, submittedIdentity, observation, true);
							if (persisted) break;
						}
					}
				}
				if (!oneSlowReadRetry) await abortableSleep(100, identityObservationSignal);
			}
			if (persisted) {
				run = persisted.run;
				conversation = persisted.conversation;
			}
			const providerUserMessageId = persisted?.run.providerUserMessageId;
			run = await this.store.updateRun(run.id, {
				submissionState: "submitted",
				providerUserMessageId,
				receipt: submittedIdentity && providerUserMessageId ? {
					...run.receipt,
					providerConversationId: submittedIdentity.id,
					providerConversationUrl: submittedIdentity.url,
				} : run.receipt,
			});
			if (submittedIdentity && providerUserMessageId) {
				conversation = await this.persistConversationIdentity(conversation.id, submittedIdentity);
			}
			if (!submittedIdentity || !providerUserMessageId) {
				return browserNeedsUser(
					"The bounded send-boundary observation did not provide a matching provider-issued conversation and first new user-message identity. Later transcript text was not adopted.",
					conversation, run,
				);
			}
			if ((run.kind === "subagent" || run.pinChatRequested === true) && conversation.providerPinned !== true) {
				try {
					const currentSession = await driver.show(expected.sessionId, signal);
					const pinned = await driver.manageConversation(currentSession, { action: "pin" }, signal);
					if (pinned.pinned !== true) throw new Error("live pin read-back did not report pinned=true");
					conversation = await this.store.updateConversation(conversation.id, { providerPinned: true });
				} catch (error) {
					const warning = `Automatic GPT Worker pinning failed after submission: ${errorMessage(error)}`;
					run = await this.store.updateRun(run.id, {
						diagnostics: {
							...(run.diagnostics ?? {}),
							organizationWarnings: [...(run.diagnostics?.organizationWarnings ?? []), warning],
						},
					});
				}
			}
		} else if (run.submissionState === "submitting" || run.submissionState === "submitted") {
			if (baselineCount === undefined) {
				return browserNeedsUser(
					"Recovered browser run has ambiguous submission state and no durable assistant-turn baseline. Prompt was not resent.",
					conversation, run,
				);
			}
			if (!modelVerified || !observedModel || modelEvidenceKind !== "composer_selector") {
				return browserNeedsUser(
					"Recovered browser run lacks durable live model-selector evidence. Prompt was not resent and completion provenance cannot be claimed.",
					conversation, run,
				);
			}
			if (recovery) {
				const durableIdentity = run.receipt.providerConversationUrl
					? providerConversationIdentity(run.receipt.providerConversationUrl)
					: undefined;
				if (!durableIdentity || !run.providerUserMessageId) {
					return browserNeedsUser(
						"Recovered submitted browser run has no durable provider-issued conversation and user-message identity. Transcript text was not used as identity, the page was not adopted, and the prompt was not resent.",
						conversation, run,
					);
				}
				const conversationIdentity = conversation.providerConversationUrl
					? providerConversationIdentity(conversation.providerConversationUrl)
					: undefined;
				if (conversationIdentity && conversationIdentity.url !== durableIdentity.url) {
					return browserNeedsUser(
						"Recovered run-scoped provider conversation identity conflicts with the durable conversation record. The page was not observed and the prompt was not resent.",
						conversation, run,
					);
				}
				if (!conversationIdentity) conversation = await this.persistConversationIdentity(conversation.id, durableIdentity);
			}
		} else {
			throw new Error(`Invalid browser submission state ${run.submissionState}.`);
		}

		if (run.requestedProviderTitle && run.receipt.titleVerified !== true) {
			try {
				const currentSession = await driver.show(expected.sessionId, signal);
				const renamed = await driver.manageConversation(
					currentSession,
					{ action: "rename", title: run.requestedProviderTitle },
					signal,
				);
				if (renamed.title !== run.requestedProviderTitle) {
					throw new Error(`live title read-back returned ${JSON.stringify(renamed.title)}`);
				}
				conversation = await this.store.updateConversation(conversation.id, {
					providerTitle: renamed.title,
				});
				run = await this.store.updateRun(run.id, {
					receipt: {
						...run.receipt,
						observedTitle: renamed.title,
						titleVerified: true,
						titleVerifiedAt: renamed.verifiedAt,
					},
				});
			} catch (error) {
				const warning = `Automatic GPT Worker title verification failed after submission: ${errorMessage(error)}`;
				if (!(run.diagnostics?.organizationWarnings ?? []).includes(warning)) {
					run = await this.store.updateRun(run.id, {
						diagnostics: {
							...(run.diagnostics ?? {}),
							organizationWarnings: [...(run.diagnostics?.organizationWarnings ?? []), warning],
						},
					});
				}
			}
		}

		const completionDeadlineAt = run.providerActiveDeadlineAt ?? run.deadlineAt;
		const remaining = Math.max(1,
			Date.parse(completionDeadlineAt ?? "") - Date.now() || (run.timeoutMs ?? 600_000));
		const outcome = await waitForCompletedDriverTurn(driver, expected, {
			baselineCount: required(baselineCount, "assistant-turn baseline"),
			timeoutMs: remaining,
			conversationUrl: conversation.providerConversationUrl,
			providerTurnIdentityPersisted: Boolean(run.providerUserMessageId && run.receipt.providerConversationUrl),
			activeTurnGraceMs: this.policy.activeTurnGraceMs,
			activeDeadlineAt: run.providerActiveDeadlineAt,
			signal,
			onActiveTurnGrace: async (receipt) => {
				run = await this.store.updateRun(run.id, {
					providerActiveDeadlineAt: receipt.deadlineAt,
					diagnostics: {
						...(run.diagnostics ?? {}),
						providerActiveObservedAt: receipt.observedAt,
						providerActiveState: receipt.stateSummary,
					},
				});
			},
			onConversationIdentity: async (identity) => {
				await this.persistConversationIdentity(conversation.id, identity);
			},
			onConversationObservation: async (identity, observation) => {
				const expectedIdentity = run.receipt.providerConversationUrl
					? providerConversationIdentity(run.receipt.providerConversationUrl)
					: undefined;
				if (!expectedIdentity || expectedIdentity.url !== identity.url) return "mismatch";
				if (observation.latestUserMessageId
					&& !observationHasUserMessage(observation, run.providerUserMessageId)) return "mismatch";
				if (!observation.latestUserMessageId) return "unavailable";
				if (run.promptProofToken && (!observation.latestUserPromptProofToken
					|| !observation.latestUserPromptSha256)) return "unavailable";
				if (run.promptProofToken && !this.observationProvesPrompt(run, observation)) return "mismatch";
				const persisted = await this.persistObservedProviderTurnIdentity(conversation, run, identity, observation);
				if (!persisted) return "mismatch";
				run = persisted.run;
				conversation = persisted.conversation;
				return "approved";
			},
			onRateLimit: async (message) => {
				run = await this.recordProviderRateLimit(run, message);
			},
			onProviderSafety: async (reason, message) => {
				run = await this.recordProviderSafety(run, reason, message);
			},
		});
		if (outcome.terminalStatus === "needs_user") {
			await driver.setState(expected.sessionId, "needs_user", signal).catch(() => undefined);
			return completionOutcomeToProviderResult(driver.id, outcome, {
				observedModel, observedEffort, modelVerified, modelEvidenceKind, modelVerifiedAt,
			});
		}
		const snapshot = required(outcome.snapshot, "stable final assistant turn");
		await this.store.clearProviderTurnState(run.id);
		await driver.setState(expected.sessionId, "completed", signal).catch(() => undefined);
		return {
			provider: "browser",
			terminalStatus: "completed",
			text: snapshot.text,
			providerConversationId: outcome.providerConversationId,
			providerConversationUrl: outcome.providerConversationUrl,
			providerRunId: snapshot.messageId,
			observedModel,
			observedEffort,
			modelVerified,
			modelEvidenceKind,
			modelVerifiedAt,
			transportVersion: `browser-driver/v2; ${driver.id}; gpt-control/${PACKAGE_VERSION}`,
			imageUrls: snapshot.imageUrls,
			localAssistantTurnCount: snapshot.count,
			recoveryAttempts: outcome.recoveryAttempts,
			lastObservedUrl: outcome.lastObservedUrl,
			lastObservedUiState: outcome.lastObservedUiState,
		};
	}

	private async runRequiredConnectorPreflight(
		driver: WebChatDriver,
		expected: ExpectedDriverSession,
		conversation: ConversationRecord,
		originalRun: RunRecord,
		request: DurableRunRequest | undefined,
		signal: AbortSignal,
		recovery: boolean,
	): Promise<{ run: RunRecord; conversation: ConversationRecord } | { terminal: ProviderTurnResult }> {
		let run = originalRun;
		const intent = run.connectorIntent;
		if (!intent || intent.mode !== "require") return { run, conversation };
		if (!request) {
			return { terminal: browserNeedsUser("Required connector preflight cannot start because the durable assignment payload is unavailable.", conversation, run) };
		}
		let state = run.connectorPreflight ?? { status: "required" as const };
		if (state.status === "failed") {
			return { terminal: browserNeedsUser(state.error ?? "Required connector preflight failed.", conversation, run) };
		}
		if (state.status === "submitting" && recovery) {
			return { terminal: browserNeedsUser(
				"Required connector preflight stopped at an ambiguous send boundary. It was not replayed, and the main assignment was not sent.",
				conversation,
				run,
			) };
		}

		if (state.status === "required") {
			let ready = await waitForDriverReady(driver, expected, {
				timeoutMs: Math.min(60_000, request.timeoutMs),
				signal,
			});
			if (conversation.providerConversationUrl) {
				const exact = providerConversationIdentity(conversation.providerConversationUrl);
				if (!exact) throw new Error("Stored provider conversation URL is invalid during connector preflight.");
				const current = providerConversationIdentity(ready.session.url);
				if (!current || current.url !== exact.url) {
					await driver.navigate(ready.session, exact.url, signal);
					ready = await waitForDriverReady(driver, expected, {
						timeoutMs: Math.min(60_000, request.timeoutMs),
						signal,
					});
				}
			}
			const baseline = ready.observation.snapshot.count;
			const requestedModel = request.requestedChatGptModel ?? this.policy.defaultChatGptModel;
			const requestedSelection = request.requestedChatGptEffort || requestedModel !== "pro"
				? { ...(requestedModel !== "pro" ? { model: requestedModel } : {}), ...(request.requestedChatGptEffort ? { effort: request.requestedChatGptEffort } : {}) }
				: requestedModel;
			const selection = await this.withProviderRateLimitRecovery(
				driver, expected, run, signal,
				(session) => driver.selectModel(session, requestedSelection, signal),
			);
			run = selection.run;
			const activeSession = selection.session;
			const selected = selection.value;
			run = await this.store.updateRun(run.id, {
				receipt: {
					...run.receipt,
					requestedModel: selected.requestedModel,
					observedModel: selected.observedModel,
					...(selected.requestedEffort ? { requestedEffort: selected.requestedEffort } : {}),
					...(selected.observedEffort ? { observedEffort: selected.observedEffort } : {}),
					model: selected.observedModel,
					modelVerified: true,
					modelEvidenceKind: selected.modelEvidenceKind,
					modelVerifiedAt: selected.modelVerifiedAt,
				},
			});
			const prompt = connectorPreflightPrompt(intent.names);
			if (!driver.fillWithConnectorMentions) {
				return { terminal: browserNeedsUser(
					"Required connector preflight cannot prove selected ChatGPT connector mentions with this browser driver. The main assignment was not sent.",
					conversation,
					run,
				) };
			}
			await driver.fillWithConnectorMentions(activeSession, prompt, intent.names, signal);
			const verification = await this.withProviderRateLimitRecovery(
				driver, expected, run, signal,
				(session) => driver.verifyModel(session, requestedSelection, signal),
			);
			run = verification.run;
			run = await this.store.updateRun(run.id, {
				providerTurnPending: true,
				connectorPreflight: { status: "submitting", baselineMessageCount: baseline },
			});
			const beforeSend = await driver.observe(verification.session, signal);
			await driver.send(verification.session, signal);
			const deadline = Date.now() + Math.min(15_000, request.timeoutMs);
			let bound = false;
			while (Date.now() < deadline) {
				const session = await assertExactDriverSession(driver, expected, signal);
				const observation = await driver.observe(session, signal);
				if (observation.latestUserMessageId && observation.latestUserMessageId !== beforeSend.latestUserMessageId) {
					const identity = providerConversationIdentity(session.url);
					if (identity) {
						conversation = await this.persistConversationIdentity(conversation.id, identity);
						run = await this.store.updateRun(run.id, {
							providerUserMessageId: observation.latestUserMessageId,
							connectorPreflight: {
								status: "submitted",
								baselineMessageCount: baseline,
								providerUserMessageId: observation.latestUserMessageId,
							},
							receipt: {
								...run.receipt,
								providerConversationId: identity.id,
								providerConversationUrl: identity.url,
							},
						});
						state = required(run.connectorPreflight, "connector preflight state");
						bound = true;
						break;
					}
				}
				await abortableSleep(100, signal);
			}
			if (!bound) {
				return { terminal: browserNeedsUser(
					"Required connector preflight did not produce a durable provider conversation and user-message identity. It was not replayed, and the main assignment was not sent.",
					conversation,
					run,
				) };
			}
		}

		state = required(run.connectorPreflight, "connector preflight state");
		if (state.status !== "submitted" || !state.providerUserMessageId || state.baselineMessageCount === undefined) {
			return { terminal: browserNeedsUser("Required connector preflight has incomplete durable state. The main assignment was not sent.", conversation, run) };
		}
		const remaining = Math.max(1, Date.parse(run.deadlineAt ?? "") - Date.now() || request.timeoutMs);
		const outcome = await waitForCompletedDriverTurn(driver, expected, {
			baselineCount: state.baselineMessageCount,
			timeoutMs: remaining,
			conversationUrl: conversation.providerConversationUrl,
			providerTurnIdentityPersisted: true,
			signal,
			onConversationIdentity: async (identity) => { await this.persistConversationIdentity(conversation.id, identity); },
			onConversationObservation: async (identity, observation) => {
				const exact = conversation.providerConversationUrl ? providerConversationIdentity(conversation.providerConversationUrl) : undefined;
				if (!exact || exact.url !== identity.url) return "mismatch";
				if (!observation.latestUserMessageId) return "unavailable";
				return observationHasUserMessage(observation, state.providerUserMessageId) ? "approved" : "mismatch";
			},
			onRateLimit: async (message) => {
				run = await this.recordProviderRateLimit(run, message);
			},
			onProviderSafety: async (reason, message) => {
				run = await this.recordProviderSafety(run, reason, message);
			},
		});
		if (outcome.terminalStatus !== "completed" || !outcome.snapshot) {
			const reason = outcome.reason ?? "Required connector preflight did not complete.";
			run = await this.store.updateRun(run.id, { connectorPreflight: { ...state, status: "failed", error: reason } });
			return { terminal: browserNeedsUser(`${reason} The main assignment was not sent.`, conversation, run) };
		}
		const parsed = parseConnectorPreflight(outcome.snapshot.text, intent.names);
		const observed = await driver.observe(await driver.show(expected.sessionId, signal), signal);
		const matchingCards = observed.visibleToolCards.filter((card) =>
			intent.names.some((name) => card.label.toLowerCase().includes(name.toLowerCase())));
		const allCardNamesObserved = intent.names.every((name) =>
			matchingCards.some((card) => card.label.toLowerCase().includes(name.toLowerCase())));
		if (!parsed.ok) {
			run = await this.store.clearProviderTurnState(run.id);
			run = await this.store.updateRun(run.id, {
				providerUserMessageId: undefined,
				connectorPreflight: {
					...state,
					status: "failed",
					responseSha256: sha256(outcome.snapshot.text),
					toolCards: matchingCards,
					error: parsed.reason,
				},
			});
			return { terminal: browserNeedsUser(`${parsed.reason} The main assignment was not sent.`, conversation, run) };
		}
		run = await this.store.clearProviderTurnState(run.id);
		run = await this.store.updateRun(run.id, {
			providerUserMessageId: undefined,
			connectorPreflight: {
				...state,
				status: "passed",
				responseSha256: sha256(outcome.snapshot.text),
				evidenceKind: allCardNamesObserved ? "browser_tool_card" : "assistant_reported_preflight",
				toolCards: matchingCards,
				verifiedAt: nowIso(),
			},
		});
		return { run, conversation };
	}

	private async ensureOwnedDriver(
		conversation: ConversationRecord,
		run: RunRecord,
		signal: AbortSignal,
	): Promise<{
		conversation: ConversationRecord;
		run: RunRecord;
		driver: WebChatDriver;
		expected: ExpectedDriverSession;
	}> {
		if (conversation.closedAt) throw new Error(`Conversation ${conversation.id} is closed; browser allocation refused.`);
		const hasSessionId = Boolean(conversation.browserSessionId);
		const hasPageId = conversation.browserPageId !== undefined;
		if (hasSessionId !== hasPageId) throw new Error("Conversation has incomplete browser ownership state.");
		if (hasSessionId) {
			const owned = await this.resolveOwnedDriver(conversation);
			if (run.receipt.browserDriverId && run.receipt.browserDriverId !== owned.driver.id) {
				throw new Error("Run receipt browser-driver identity conflicts with its durable conversation.");
			}
			if (run.receipt.localBrowserSessionId && run.receipt.localBrowserSessionId !== owned.expected.sessionId) {
				throw new Error("Run receipt browser-session identity conflicts with its durable conversation.");
			}
			const lanes = [conversation.desktopPoolLane, run.receipt.desktopPoolLane, owned.session.desktopPoolLane]
				.filter((lane): lane is number => lane !== undefined);
			if (new Set(lanes).size > 1) throw new Error("Desktop-pool lane identity conflicts across durable recovery receipts.");
			const desktopPoolLane = lanes[0];
			if (conversation.desktopPoolLane !== desktopPoolLane || conversation.desktopPoolLeaseState !== undefined) {
				conversation = await this.store.updateConversation(conversation.id, {
					desktopPoolLane,
					desktopPoolLeaseState: undefined,
				});
			}
			if (run.receipt.browserDriverId !== owned.driver.id
				|| run.receipt.localBrowserSessionId !== owned.expected.sessionId
				|| run.receipt.desktopPoolLane !== desktopPoolLane
				|| run.receipt.desktopPoolLeaseState !== undefined) {
				run = await this.store.updateRun(run.id, {
					receipt: {
						...run.receipt,
						browserDriverId: owned.driver.id,
						localBrowserSessionId: owned.expected.sessionId,
						desktopPoolLane,
						desktopPoolLeaseState: undefined,
					},
				});
			}
			if (TERMINAL.has(run.status)) {
				const unresolvedProviderTurn = run.providerTurnPending === true
					|| run.submissionState === "submitting" || run.submissionState === "submitted";
				if (unresolvedProviderTurn) {
					throw new Error("Terminal run retains an unresolved provider turn; browser ownership was preserved for Stop reconciliation.");
				}
				await assertExactDriverSession(owned.driver, owned.expected);
				await owned.driver.close(owned.expected.sessionId, undefined, owned.expected.pageId);
				await this.store.updateConversation(conversation.id, { closedAt: nowIso() });
				throw new Error("Run became terminal while browser-session ownership was being recovered.");
			}
			return { conversation, run, ...owned };
		}
		if (conversation.providerConversationUrl) {
			throw new Error("A provider conversation URL exists without a durable owned browser session; recovery refused.");
		}
		const capabilities = await this.dependencies.resolveCapabilities(this.exec);
		const available = capabilities.browser;
		if (!available) throw new Error("The configured secure browser driver is unavailable. No fallback was launched.");
		const driverId = required(conversation.browserDriverId, "browser driver id");
		if (available.driver.id !== driverId) {
			throw new Error(`Prepared conversation belongs to browser driver ${driverId}, but the live driver is ${available.driver.id}.`);
		}
		const name = required(conversation.browserSessionName, "browser session name");
		const session = await available.driver.create(name, CHATGPT_ORIGIN, signal);
		const expected: ExpectedDriverSession = {
			sessionId: session.sessionId,
			pageId: session.pageId,
			name,
		};
		let persisted = false;
		try {
			await this.validateCreatedSession(available.driver, session, expected, async () => {
					conversation = await this.store.updateConversation(conversation.id, {
					browserSessionId: session.sessionId,
					browserSessionName: session.name,
					browserPageId: session.pageId,
					desktopPoolLane: session.desktopPoolLane,
					desktopPoolLeaseState: "release_unproved",
				});
				persisted = true;
				run = await this.store.updateRun(run.id, {
					receipt: {
						...run.receipt,
						browserDriverId: available.driver.id,
						localBrowserSessionId: session.sessionId,
						desktopPoolLane: session.desktopPoolLane,
						desktopPoolLeaseState: "release_unproved",
					},
				});
				return {
					label: `${conversation.id}/${run.id}`,
					markClosed: async () => { await this.store.updateConversation(conversation.id, { closedAt: nowIso() }); },
				};
			});
			conversation = await this.store.updateConversation(conversation.id, {
				browserSessionId: session.sessionId,
				browserPageId: session.pageId,
				desktopPoolLane: session.desktopPoolLane,
				desktopPoolLeaseState: session.desktopPoolLeaseState,
			});
			persisted = true;
			run = await this.store.updateRun(run.id, {
				receipt: {
					...run.receipt,
					browserDriverId: available.driver.id,
					localBrowserSessionId: session.sessionId,
					desktopPoolLane: session.desktopPoolLane,
					desktopPoolLeaseState: session.desktopPoolLeaseState,
				},
			});
			if (TERMINAL.has(run.status)) {
				await assertExactDriverSession(available.driver, expected);
				await available.driver.close(session.sessionId, undefined, session.pageId);
				await this.store.updateConversation(conversation.id, { closedAt: nowIso() });
				throw new Error("Run became terminal while its owned browser session was being allocated.");
			}
			return { conversation, run, driver: available.driver, expected };
		} catch (error) {
			if (error instanceof RetainedCreatedSessionError) throw error;
			if (!persisted) {
				try {
					if (session.name !== name) throw new Error("Created browser session did not retain its broker ownership name.");
					await assertExactDriverSession(available.driver, expected);
					await available.driver.close(session.sessionId, undefined, session.pageId);
				} catch (cleanupError) {
					conversation = await this.store.updateConversation(conversation.id, {
						browserSessionId: session.sessionId,
						browserPageId: session.pageId,
						desktopPoolLane: session.desktopPoolLane,
						desktopPoolLeaseState: session.desktopPoolLeaseState,
					});
					await this.store.updateRun(run.id, {
						receipt: {
							...run.receipt,
							browserDriverId: available.driver.id,
							localBrowserSessionId: session.sessionId,
							desktopPoolLane: session.desktopPoolLane,
							desktopPoolLeaseState: session.desktopPoolLeaseState,
						},
					});
					throw new Error(
						`${errorMessage(error)} Browser cleanup was not proved; durable ownership was retained: ${errorMessage(cleanupError)}`,
					);
				}
			}
			throw error;
		}
	}

	private async closeUnsubmittedOwnedConversation(conversationId: string): Promise<void> {
		const conversation = await this.store.getConversation(conversationId);
		if (conversation.closedAt || conversation.providerConversationUrl) return;
		if (!conversation.browserSessionId && conversation.browserPageId === undefined) {
			await this.store.updateConversation(conversationId, { closedAt: nowIso() });
			return;
		}
		if (!conversation.browserSessionId || conversation.browserPageId === undefined) {
			throw new Error("Cannot close a conversation with incomplete browser ownership state.");
		}
		const { driver, expected } = await this.resolveOwnedDriver(conversation);
		await assertExactDriverSession(driver, expected);
		await driver.close(expected.sessionId, undefined, expected.pageId);
		await this.store.updateConversation(conversationId, { closedAt: nowIso() });
	}

	private async closeOwnedConversationSession(conversationId: string): Promise<ConversationRecord> {
		return this.store.withConversationLock(conversationId, async () => {
			const conversation = await this.store.getConversation(conversationId);
			if (conversation.closedAt) return conversation;
			if (conversation.provider !== "browser") {
				throw new Error(`Provider ${conversation.provider} cannot be closed by the hardened browser broker.`);
			}
			if (!conversation.browserSessionId && conversation.browserPageId === undefined) {
				return this.store.updateConversation(conversationId, { closedAt: nowIso() });
			}
			if (!conversation.browserSessionId || conversation.browserPageId === undefined) {
				throw new Error(`Conversation ${conversationId} has incomplete browser ownership state.`);
			}
			try {
				const { driver, expected } = await this.resolveOwnedDriver(conversation);
				await assertExactDriverSession(driver, expected);
				await driver.close(expected.sessionId, undefined, expected.pageId);
			} catch (error) {
				if (!ownedBrowserPageIsMissing(error)) throw error;
			}
			return this.store.updateConversation(conversationId, { closedAt: nowIso() });
		});
	}

	private canCloseTerminalWorkerConversation(run: RunRecord): boolean {
		const legacyUnresolved = run.providerTurnPending === undefined
			&& (run.status === "cancelled" || run.status === "needs_user")
			&& (run.submissionState === "submitting" || run.submissionState === "submitted");
		return run.kind === "subagent"
			&& TERMINAL.has(run.status)
			&& run.providerTurnPending !== true
			&& !legacyUnresolved;
	}

	private async closeTerminalWorkerConversation(run: RunRecord): Promise<boolean> {
		if (!this.canCloseTerminalWorkerConversation(run)) return false;
		const conversation = await this.store.getConversation(run.conversationId);
		if (conversation.closedAt) return false;
		await this.closeConversation(conversation.id);
		return true;
	}

	private async resolveOwnedDriver(
		conversation: ConversationRecord,
	): Promise<{ driver: WebChatDriver; expected: ExpectedDriverSession; session: DriverSession }> {
		const capabilities = await this.dependencies.resolveCapabilities(this.exec);
		const available = capabilities.browser;
		if (!available) throw new Error("The configured secure browser driver is unavailable. No fallback was launched.");
		const driverId = required(conversation.browserDriverId, "browser driver id");
		if (available.driver.id !== driverId) {
			throw new Error(`Conversation belongs to browser driver ${driverId}, but the live driver is ${available.driver.id}.`);
		}
		const expected: ExpectedDriverSession = {
			sessionId: required(conversation.browserSessionId, "browser session id"),
			pageId: required(conversation.browserPageId, "browser page id"),
			name: required(conversation.browserSessionName, "browser session name"),
		};
		const session = await assertExactDriverSession(available.driver, expected);
		return { driver: available.driver, expected, session };
	}

	private async persistConversationIdentity(
		conversationId: string,
		identity: { id: string; url: string },
		assistantTurnCount?: number,
	): Promise<ConversationRecord> {
		const canonical = providerConversationIdentity(identity.url);
		if (!canonical || canonical.id !== identity.id) {
			throw new Error("Browser driver supplied an invalid or inconsistent ChatGPT conversation identity.");
		}
		const current = await this.store.getConversation(conversationId);
		if (current.providerConversationId && current.providerConversationId !== canonical.id) {
			throw new Error(`Provider conversation id drifted from ${current.providerConversationId} to ${canonical.id}.`);
		}
		if (current.providerConversationUrl && current.providerConversationUrl !== canonical.url) {
			throw new Error(`Provider conversation URL drifted from ${current.providerConversationUrl} to ${canonical.url}.`);
		}
		return this.store.updateConversation(conversationId, {
			providerConversationId: canonical.id,
			providerConversationUrl: canonical.url,
			browserAssistantTurnCount: assistantTurnCount ?? current.browserAssistantTurnCount,
		});
	}

	private async persistCancellation(runId: string): Promise<RunRecord> {
		const at = nowIso();
		const current = await this.store.getRun(runId);
		const providerMayBeActive = current.providerTurnPending === true
			|| current.submissionState === "submitting"
			|| current.submissionState === "submitted";
		return this.store.updateRun(runId, {
			status: "cancelled",
			providerStopRequested: providerMayBeActive ? true : current.providerStopRequested,
			cancellationRequestedAt: at,
			completedAt: at,
			error: "Cancelled by explicit request. Late ChatGPT completion is ignored. Connected-tool operations already started by ChatGPT can continue after Stop and require independent verification.",
		});
	}

	private observationProvesRun(run: RunRecord, observation: ChatPageObservation): boolean {
		return Boolean(run.providerUserMessageId
			&& observationHasUserMessage(observation, run.providerUserMessageId)
			&& (!run.promptProofToken || this.observationProvesPrompt(run, observation)));
	}

	private async persistObservedProviderTurnIdentity(
		conversation: ConversationRecord,
		run: RunRecord,
		identity: { id: string; url: string },
		observation: ChatPageObservation,
		allowUnmarkedInitialTurn = false,
	): Promise<{ conversation: ConversationRecord; run: RunRecord } | undefined> {
		if (!observation.latestUserMessageId) return undefined;
		const expectedExistingIdentity = conversation.providerConversationUrl
			? providerConversationIdentity(conversation.providerConversationUrl)
			: undefined;
		if (expectedExistingIdentity && expectedExistingIdentity.url !== identity.url) return undefined;
		if (run.providerUserMessageId && !observationHasUserMessage(observation, run.providerUserMessageId)) return undefined;
		if (observationHasUserMessage(observation, run.providerUserMessageId)
			&& run.receipt.providerConversationUrl === identity.url
			&& conversation.providerConversationUrl === identity.url) {
			return { conversation, run };
		}
		if (run.promptProofToken) {
			if (!this.observationProvesPrompt(run, observation)) return undefined;
		} else if (!allowUnmarkedInitialTurn) {
			return undefined;
		}
		const persistedRun = await this.store.updateRun(run.id, {
			providerUserMessageId: observation.latestUserMessageId,
			receipt: {
				...run.receipt,
				providerConversationId: identity.id,
				providerConversationUrl: identity.url,
			},
		});
		const persistedConversation = await this.persistConversationIdentity(conversation.id, identity);
		return { conversation: persistedConversation, run: persistedRun };
	}

	private observationProvesPrompt(run: RunRecord, observation: ChatPageObservation): boolean {
		// New runs bind the random marker; older envelope runs also bind their
		// persisted task-body hash.
		return Boolean(run.promptProofToken
			&& observation.latestUserPromptProofToken === run.promptProofToken
			&& (!run.promptObservationSha256
				|| observation.latestUserPromptSha256 === run.promptObservationSha256));
	}

	private scheduleProviderStopReconciliation(runId: string): void {
		if (this.activeStopReconciliations.has(runId)) return;
		const reconciliation = (async () => {
			for (let attempt = 0; attempt < 6; attempt += 1) {
				const run = await this.store.getRun(runId).catch(() => undefined);
				if (!run || !run.providerTurnPending || !run.providerStopRequested) return;
				if (await this.stopOwnedBrowserRun(run).catch(() => false)) return;
				if (attempt < 5) await unrefSleep(Math.min(500 * 2 ** attempt, 8_000));
			}
		})().finally(() => {
			this.activeStopReconciliations.delete(runId);
		});
		this.activeStopReconciliations.set(runId, reconciliation);
		void reconciliation.catch(() => undefined);
	}

	private async stopOwnedBrowserRun(run: RunRecord): Promise<boolean> {
		let conversation = await this.store.getConversation(run.conversationId);
		if (conversation.provider !== "browser") return false;
		const { driver, expected } = await this.resolveOwnedDriver(conversation);
		if (!conversation.providerConversationUrl) {
			const durableIdentity = run.receipt.providerConversationUrl
				? providerConversationIdentity(run.receipt.providerConversationUrl)
				: undefined;
			if (!durableIdentity || !run.providerUserMessageId) return false;
			conversation = await this.persistConversationIdentity(conversation.id, durableIdentity);
		}
		const session = await assertExactDriverSession(driver, expected);
		const expectedIdentity = conversation.providerConversationUrl
			? providerConversationIdentity(conversation.providerConversationUrl)
			: undefined;
		const currentIdentity = providerConversationIdentity(session.url);
		if (!expectedIdentity || !currentIdentity || expectedIdentity.url !== currentIdentity.url) return false;
		let observation = await driver.observe(session);
		if (!this.observationProvesRun(run, observation)) return false;
		if (observation.turnInterruption) {
			await this.store.clearProviderTurnState(run.id);
			return true;
		}
		let stopIssued = false;
		if (observation.answering || observation.thinking || observation.toolRunning) {
			await driver.recover(session, "stop");
			stopIssued = true;
		}
		let stableInactiveKey: string | undefined;
		let stableInactiveReads = 0;
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const current = await assertExactDriverSession(driver, expected);
			observation = await driver.observe(current);
			if (!this.observationProvesRun(run, observation)) return false;
			const inactive = !observation.answering && !observation.thinking && !observation.toolRunning;
			const finalTurn = observation.snapshot.count > (run.baselineMessageCount ?? Number.POSITIVE_INFINITY)
				&& Boolean(observation.snapshot.messageId)
				&& (observation.snapshot.hasMarkdown || observation.snapshot.imageUrls.length > 0);
			if (inactive && (stopIssued || finalTurn)) {
				const key = `${observation.snapshot.count}:${observation.snapshot.messageId ?? ""}:${observation.snapshot.text}:${observation.snapshot.imageUrls.join("\n")}`;
				stableInactiveReads = key === stableInactiveKey ? stableInactiveReads + 1 : 1;
				stableInactiveKey = key;
				if (stableInactiveReads >= 2) {
					await this.store.clearProviderTurnState(run.id);
					return true;
				}
			} else {
				stableInactiveKey = undefined;
				stableInactiveReads = 0;
			}
			await sleep(100);
		}
		return false;
	}

	private async finishNeedsUser(
		run: RunRecord,
		reason: string,
		result?: ProviderTurnResult,
	): Promise<RunRecord> {
		const current = await this.store.getRun(run.id);
		const terminal = await this.store.updateRun(run.id, {
			status: "needs_user",
			providerStopRequested: current.providerTurnPending ? true : current.providerStopRequested,
			error: reason,
			completedAt: nowIso(),
			diagnostics: {
				...(current.diagnostics ?? {}),
				terminalReason: reason,
				recoveryAttempts: result?.recoveryAttempts,
				localAssistantTurnCount: result?.localAssistantTurnCount,
				lastObservedUrl: result?.lastObservedUrl,
				lastObservedUiState: result?.lastObservedUiState,
			},
			receipt: {
				...current.receipt,
				observedModel: result?.observedModel ?? current.receipt.observedModel,
				observedEffort: result?.observedEffort ?? current.receipt.observedEffort,
				model: result?.observedModel ?? current.receipt.model,
				modelVerified: result?.modelVerified ?? current.receipt.modelVerified ?? false,
				modelEvidenceKind: result?.modelEvidenceKind ?? current.receipt.modelEvidenceKind,
				modelVerifiedAt: result?.modelVerifiedAt ?? current.receipt.modelVerifiedAt,
				providerConversationId: result?.providerConversationId ?? current.receipt.providerConversationId,
				providerConversationUrl: result?.providerConversationUrl ?? current.receipt.providerConversationUrl,
				localAssistantTurnCount: result?.localAssistantTurnCount,
				recoveryAttempts: result?.recoveryAttempts,
				completedAt: nowIso(),
			},
		});
		if (terminal.providerTurnPending && terminal.providerStopRequested) {
			this.scheduleProviderStopReconciliation(run.id);
		}
		return terminal;
	}
}

interface NormalizedStartRequest {
	kind: RunKind;
	prompt: string;
	files: string[];
	conversationId?: string;
	transport: "browser";
	chatgptModel: ChatGptModel;
	chatgptEffort?: string;
	title?: string;
	projectId?: string;
	pinChat: boolean;
	idempotencyKey?: string;
	connectorIntent?: { names: string[]; mode: "prefer" | "require" };
	wait: boolean;
	timeoutMs: number;
	allowOutsideWorkspace: boolean;
	allowSensitiveFiles: boolean;
}

interface PreparedRunPrompt {
	prompt: string;
	promptProofToken: string;
	promptSha256: string;
}

function normalizeStartRequest(request: StartRequest, policy: OperatorPolicy): NormalizedStartRequest {
	assertRequestedAuthority(policy, request);
	if (request.prompt.trim() === "") throw new Error("prompt is required");
	if (Buffer.byteLength(request.prompt, "utf8") > policy.maxPromptBytes) {
		throw new Error(`Prompt exceeds trusted ${policy.maxPromptBytes}-byte limit.`);
	}
	const requestedTimeout = request.timeoutMs ?? 600_000;
	if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error("timeout_ms must be a positive number");
	if (request.idempotencyKey) idempotencyKeyHash(request.idempotencyKey);
	if (request.workspaceRoot && resolve(request.workspaceRoot) !== policy.workspaceRoot) {
		throw new Error(`workspace_root cannot widen trusted policy beyond ${policy.workspaceRoot}.`);
	}
	const legacyModel = request.model?.trim().toLowerCase();
	if (legacyModel && legacyModel !== "pro" && legacyModel !== "chatgpt pro") {
		throw new Error("The legacy model field may only narrow to live-verified ChatGPT Pro.");
	}
	if (request.providerModel) {
		throw new Error("provider_model cannot establish ChatGPT composer provenance. Use chatgpt_model with an exact label from gpt_models.");
	}
	if (request.transport && request.transport !== "browser") {
		throw new Error(`Transport ${request.transport} is disabled by the hardened broker.`);
	}
	if (request.apiConfirmed) {
		throw new Error("api_confirmed cannot grant paid-provider authority and no paid fallback is enabled.");
	}
	if (request.allowFocusSteal) {
		throw new Error("allow_focus_steal cannot grant browser authority and no focus-stealing fallback is enabled.");
	}
	const chatgptModel = normalizePickerRequest(request.chatgptModel ?? policy.defaultChatGptModel, 128, "chatgpt_model");
	const chatgptEffort = request.chatgptEffort === undefined
		? undefined
		: normalizePickerRequest(request.chatgptEffort, 64, "chatgpt_effort");
	if (request.kind === "subagent" && request.conversationId) {
		throw new Error("Each GPT Worker requires an independent owned conversation; conversation_id is not accepted.");
	}
	if (request.kind !== "subagent" && (request.title !== undefined || request.projectId !== undefined)) {
		throw new Error("title and project_id are supported only for independent GPT Workers.");
	}
	if (request.projectId !== undefined && request.title === undefined) {
		throw new Error("project_id requires a GPT Worker title.");
	}
	const projectId = request.projectId === undefined ? undefined : normalizeProjectId(request.projectId);
	const title = request.kind === "subagent" && request.title !== undefined
		? normalizeWorkerTitle(request.title, projectId)
		: undefined;
	if (request.kind === "image" && ((request.connectors?.length ?? 0) > 0 || request.connectorMode)) {
		throw new Error("Connector intent is not supported for images.");
	}
	const connectorNames = [...new Set((request.connectors ?? []).map((name) => name.trim()))];
	if (connectorNames.length > 8 || connectorNames.some((name) => !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/.test(name))) {
		throw new Error("Connector names must be 1-64 safe characters, with at most eight distinct names.");
	}
	const connectorIntent = connectorNames.length > 0
		? { names: connectorNames, mode: request.connectorMode ?? "prefer" }
		: undefined;
	if (connectorIntent) {
		const missingMentions = connectorIntent.names.filter((name) => !request.prompt.includes(`@${name}`));
		if (missingMentions.length > 0) {
			throw new Error(`Connector prompts must contain these literal mentions: ${missingMentions.map((name) => `@${name}`).join(", ")}.`);
		}
	}
	return {
		kind: request.kind,
		prompt: request.prompt,
		files: [...(request.files ?? [])],
		conversationId: request.conversationId,
		transport: "browser",
		chatgptModel,
		chatgptEffort,
		title,
		projectId,
		pinChat: request.kind === "subagent" || request.pinChat === true,
		idempotencyKey: request.idempotencyKey,
		connectorIntent,
		wait: request.wait !== false,
		timeoutMs: Math.min(Math.floor(requestedTimeout), 60 * 60_000),
		allowOutsideWorkspace: request.allowOutsideWorkspace === true,
		allowSensitiveFiles: request.allowSensitiveFiles === true,
	};
}

function startRequestHash(request: NormalizedStartRequest): string {
	const value: Record<string, unknown> = {
		kind: request.kind,
		prompt: request.prompt,
		files: request.files,
		conversationId: request.conversationId ?? null,
		transport: request.transport,
		chatgptModel: request.chatgptModel,
		chatgptEffort: request.chatgptEffort,
		title: request.title ?? null,
		projectId: request.projectId ?? null,
		pinChat: request.pinChat,
		connectorIntent: request.connectorIntent ?? null,
		timeoutMs: request.timeoutMs,
	};
	// Preserve the pre-hardening hash for the default restricted request. Only
	// explicit exception opt-ins extend the idempotency identity.
	if (request.allowOutsideWorkspace) value.allowOutsideWorkspace = true;
	if (request.allowSensitiveFiles) value.allowSensitiveFiles = true;
	return sha256(JSON.stringify(value));
}

function normalizeWorkerTitle(value: string, projectId?: string): string {
	const trimmed = value.trim();
	if (trimmed === "" || /[\u0000-\u001f\u007f]/.test(trimmed)) {
		throw new Error("GPT Worker title must contain visible text without control characters.");
	}
	const suffix = projectId
		? trimmed.replace(new RegExp(`^${projectId}:\\s*`, "i"), "").trim()
		: trimmed;
	if (suffix === "") throw new Error("GPT Worker title must contain text after the project identifier.");
	const title = projectId ? `${projectId}: ${suffix}` : suffix;
	if (title.length > 128) throw new Error("GPT Worker title must be at most 128 characters after the project identifier is applied.");
	return title;
}

function normalizeProjectId(value: string): string {
	const normalized = value.trim().toUpperCase();
	if (!/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(normalized)) {
		throw new Error("project_id must be 1-16 letters, digits, underscores, or hyphens.");
	}
	return normalized;
}

function connectorPreflightPrompt(names: readonly string[]): string {
	const checks = names.map((name) => {
		return `- @${name}: ${connectorPreflightDetail(name)}`;
	}).join("\n");
	return `Before we start the assignment, please quickly check these connected tools and instruction plugins in this same chat:\n${checks}\n\nDo not start the assignment yet and do not change external state. Reply with only one JSON object in this form: {"connectors":[{"name":"exact name","status":"ready","payload":"one concise readiness fact"}]}. Include exactly one entry for every listed connector. For an instruction plugin explicitly marked above, exact pill selection is sufficient and must be reported as ready without tool discovery. If any other connector is unavailable or does not return a usable result, set its status to "blocked" and explain the blocker in payload.`;
}

function connectorPreflightDetail(name: string): string {
	switch (name.toLowerCase()) {
		case "compound engineering":
			return "this is an instruction plugin, not a callable tool; the exact selected connector pill is the readiness proof, so do not search for or call tools and report status ready with payload \"exact connector pill selected\"";
		case "zenbox":
			return "make one harmless read-only health call, such as computer_overview, and include one returned fact";
		case "github":
			return "make one harmless read-only call and include one returned account or repository fact";
		default:
			return "make one harmless read-only health call and include one returned fact";
	}
}

function parseConnectorPreflight(
	text: string,
	names: readonly string[],
): { ok: true } | { ok: false; reason: string } {
	let source = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
	if (fenced) source = fenced[1].trim();
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return { ok: false, reason: "Required connector preflight did not return the requested JSON payload." };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, reason: "Required connector preflight returned an invalid payload object." };
	}
	const connectors = (value as { connectors?: unknown }).connectors;
	if (!Array.isArray(connectors) || connectors.length !== names.length) {
		return { ok: false, reason: "Required connector preflight did not return exactly one result for every connector." };
	}
	const seen = new Set<string>();
	for (const entry of connectors) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return { ok: false, reason: "Required connector preflight contained a malformed connector result." };
		}
		const record = entry as { name?: unknown; status?: unknown; payload?: unknown };
		const connectorName = typeof record.name === "string" && record.name.startsWith("@")
			? record.name.slice(1)
			: record.name;
		if (typeof connectorName !== "string" || !names.includes(connectorName) || seen.has(connectorName)) {
			return { ok: false, reason: "Required connector preflight returned a missing, duplicate, or unexpected connector name." };
		}
		seen.add(connectorName);
		const usablePayload = typeof record.payload === "string"
			? record.payload.trim().length > 0
			: Boolean(record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) && Object.keys(record.payload).length > 0);
		if (record.status !== "ready" || !usablePayload) {
			return { ok: false, reason: `Required connector @${connectorName} did not report a usable ready payload.` };
		}
	}
	return { ok: true };
}

function normalizePickerRequest(value: string, maxLength: number, field: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new Error(`${field} must be a non-empty printable label no longer than ${maxLength} characters.`);
	}
	return normalized.toLowerCase() === "pro" ? "pro" : normalized;
}

function publicPolicy(policy: OperatorPolicy): Record<string, unknown> {
	return {
		workspaceRoot: policy.workspaceRoot,
		storageRoot: policy.storageRoot,
		snapshotRoot: policy.snapshotRoot,
		outputRoot: policy.outputRoot,
		allowedTransports: policy.allowedTransports,
		defaultChatGptModel: policy.defaultChatGptModel,
		requireSecureBrowserInput: policy.requireSecureBrowserInput,
		outsideWorkspaceAllowed: policy.allowOutsideWorkspace,
		sensitiveFilesAllowed: policy.allowSensitiveFiles,
		maxAttachmentFiles: policy.maxAttachmentFiles,
		maxAttachmentBytes: policy.maxAttachmentBytes,
		maxPromptBytes: policy.maxPromptBytes,
		maxActiveGenerations: policy.maxActiveGenerations,
		maxConcurrentWorkers: policy.maxConcurrentWorkers,
		activeTurnGraceMs: policy.activeTurnGraceMs,
		activeDiagnosticsAllowed: policy.allowActiveDiagnostics,
		providerTurnAbandonmentConfigured: Boolean(policy.providerTurnAbandonmentTokenHash),
		fingerprint: policy.fingerprint,
	};
}

function completionOutcomeToProviderResult(
	driverId: string,
	outcome: DriverCompletionOutcome,
	model: {
		observedModel?: string;
		observedEffort?: string;
		modelVerified: boolean;
		modelEvidenceKind?: "composer_selector";
		modelVerifiedAt?: string;
	},
): ProviderTurnResult {
	return {
		provider: "browser",
		terminalStatus: "needs_user",
		terminalReason: outcome.reason ?? "Browser driver requires operator input.",
		text: "",
		providerConversationId: outcome.providerConversationId,
		providerConversationUrl: outcome.providerConversationUrl,
		observedModel: model.observedModel,
		observedEffort: model.observedEffort,
		modelVerified: model.modelVerified,
		modelEvidenceKind: model.modelEvidenceKind,
		modelVerifiedAt: model.modelVerifiedAt,
		transportVersion: `browser-driver/v2; ${driverId}; gpt-control/${PACKAGE_VERSION}`,
		localAssistantTurnCount: outcome.snapshot?.count,
		recoveryAttempts: outcome.recoveryAttempts,
		lastObservedUrl: outcome.lastObservedUrl,
		lastObservedUiState: outcome.lastObservedUiState,
	};
}

function browserNeedsUser(reason: string, conversation: ConversationRecord, run: RunRecord): ProviderTurnResult {
	return {
		provider: "browser",
		terminalStatus: "needs_user",
		terminalReason: reason,
		text: "",
		providerConversationId: conversation.providerConversationId,
		providerConversationUrl: conversation.providerConversationUrl,
		observedModel: run.receipt.observedModel,
		modelVerified: run.receipt.modelVerified,
		modelEvidenceKind: run.receipt.modelEvidenceKind === "composer_selector" ? "composer_selector" : undefined,
		modelVerifiedAt: run.receipt.modelVerifiedAt,
		localAssistantTurnCount: run.baselineMessageCount,
		lastObservedUiState: "ambiguous_submission_state",
	};
}

function attachedConversationIdentity(request: AttachConversationRequest): { id: string; url: string } {
	const hasUrl = request.conversationUrl !== undefined;
	const hasId = request.providerConversationId !== undefined;
	if (hasUrl === hasId) {
		throw new Error("Provide exactly one of conversation_url or provider_conversation_id.");
	}
	if (request.providerConversationId !== undefined) {
		if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.providerConversationId)) {
			throw new Error("Invalid ChatGPT provider conversation id.");
		}
		return { id: request.providerConversationId, url: `${CHATGPT_ORIGIN}/c/${request.providerConversationId}` };
	}
	const raw = request.conversationUrl!;
	const identity = providerConversationIdentity(raw);
	let parsed: URL;
	try { parsed = new URL(raw); } catch { throw new Error("Invalid ChatGPT conversation URL."); }
	if (!identity || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Conversation URL must identify one exact https://chatgpt.com/c/<id> or https://chatgpt.com/g/<project>/c/<id> conversation without query or fragment data.");
	}
	if (identity.id.length > 256) throw new Error("ChatGPT provider conversation id is too long.");
	return identity;
}

async function catalogSingleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
	const existing = catalogRefreshes.get(key) as Promise<T> | undefined;
	if (existing) return existing;
	const pending = work();
	catalogRefreshes.set(key, pending);
	try {
		return await pending;
	} finally {
		if (catalogRefreshes.get(key) === pending) catalogRefreshes.delete(key);
	}
}

function modelCatalogResult(
	record: CatalogCacheRecord<ChatGptModelCatalog>,
	cacheStatus: "hit" | "refreshed",
): ModelCatalogResult {
	return {
		...record.catalog,
		browserDriverId: record.browserDriverId,
		cacheStatus,
		refreshRequired: false,
		cachedAt: record.cachedAt,
	};
}

function projectCatalogResult(
	record: CatalogCacheRecord<ChatGptProjectCatalog>,
	cacheStatus: "hit" | "refreshed",
): ProjectCatalogResult {
	return {
		...record.catalog,
		browserDriverId: record.browserDriverId,
		cacheStatus,
		refreshRequired: false,
		cachedAt: record.cachedAt,
	};
}

function missingModelCatalog(): ModelCatalogResult {
	return {
		models: [],
		efforts: [],
		browserDriverId: "cache-only",
		cacheStatus: "miss",
		refreshRequired: true,
		message: "No cached ChatGPT model catalog is available. Call gpt_models with refresh=true to perform one explicit live refresh.",
	};
}

function missingProjectCatalog(): ProjectCatalogResult {
	return {
		projects: [],
		browserDriverId: "cache-only",
		cacheStatus: "miss",
		refreshRequired: true,
		message: "No cached ChatGPT project catalog is available. Call gpt_projects with refresh=true to perform one explicit live refresh.",
	};
}

function parseModelCatalogCache(value: unknown): CatalogCacheRecord<ChatGptModelCatalog> | undefined {
	if (value === undefined) return undefined;
	const record = parseCatalogRecord(value, "models");
	const catalog = record.catalog;
	if (!isRecord(catalog)
		|| !validOptionalString(catalog.currentModel)
		|| !validOptionalString(catalog.currentEffort)
		|| !validCatalogOptions(catalog.models)
		|| !validCatalogOptions(catalog.efforts)
		|| !validTimestamp(catalog.discoveredAt)) {
		throw new Error("Invalid cached ChatGPT model catalog.");
	}
	return record as CatalogCacheRecord<ChatGptModelCatalog>;
}

function parseProjectCatalogCache(value: unknown): CatalogCacheRecord<ChatGptProjectCatalog> | undefined {
	if (value === undefined) return undefined;
	const record = parseCatalogRecord(value, "projects");
	const catalog = record.catalog;
	if (!isRecord(catalog)
		|| !Array.isArray(catalog.projects)
		|| catalog.projects.some((project) => !isRecord(project) || !validBoundedString(project.name))
		|| !validTimestamp(catalog.discoveredAt)) {
		throw new Error("Invalid cached ChatGPT project catalog.");
	}
	return record as CatalogCacheRecord<ChatGptProjectCatalog>;
}

function parseCatalogRecord(value: unknown, kind: "models" | "projects"): CatalogCacheRecord<unknown> {
	if (!isRecord(value)
		|| value.version !== 1
		|| value.kind !== kind
		|| !validTimestamp(value.cachedAt)
		|| !validBoundedString(value.browserDriverId)
		|| !("catalog" in value)) {
		throw new Error(`Invalid cached ChatGPT ${kind} catalog record.`);
	}
	return value as unknown as CatalogCacheRecord<unknown>;
}

function validCatalogOptions(value: unknown): boolean {
	return Array.isArray(value) && value.every((option) => isRecord(option)
		&& validBoundedString(option.label)
		&& validOptionalString(option.note));
}

function validOptionalString(value: unknown): boolean {
	return value === undefined || validBoundedString(value);
}

function validBoundedString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`Missing ${name}.`);
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

function unrefSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation was cancelled."));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Operation was cancelled."));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
