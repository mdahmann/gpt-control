import { createHash } from "node:crypto";
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
	type WebChatDriver,
} from "./browser-driver";
import {
	CHATGPT_ORIGIN,
	canonicalPromptObservationText,
	providerConversationIdentity,
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
import { idempotencyKeyHash, RunStore, type DurableRunRequest } from "./store";
import { passiveTransportDiscovery } from "./transport";
import type { Exec } from "./types";

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled", "needs_user"]);

class RestartSuspension extends Error {
	constructor() { super("GPT-Control monitoring suspended for process restart."); }
}

export interface StartRequest {
	kind: RunKind;
	prompt: string;
	files?: string[];
	conversationId?: string;
	transport?: TransportChoice;
	chatgptModel?: ChatGptModel;
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

export class GptControlService {
	readonly store: RunStore;
	readonly policy: OperatorPolicy;
	private readonly exec: Exec;
	private readonly dependencies: Required<ServiceDependencies>;
	private readonly activeRuns = new Map<string, ActiveRun>();
	private readonly activeStopReconciliations = new Map<string, Promise<void>>();
	private readonly cancellationIntents = new Set<string>();
	private readonly workerSlots: FairSemaphore;

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
		this.workerSlots = new FairSemaphore(this.policy.maxConcurrentWorkers);
	}

	async start(request: StartRequest, options: StartOptions = {}): Promise<StartResult> {
		const normalized = normalizeStartRequest(request, this.policy);
		if (options.deferExecution && normalized.wait) throw new Error("Deferred execution requires wait=false.");
		await this.store.init();
		const requestHash = startRequestHash(normalized);
		if (normalized.idempotencyKey) {
			const scopedIdempotencyKey = options.mcpSessionId
				? `mcp-${sha256(options.mcpSessionId)}:${normalized.idempotencyKey}`
				: normalized.idempotencyKey;
			return this.store.withIdempotencyLock(scopedIdempotencyKey, async (keyHash) => {
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
					return this.finishStart({
						conversation: await this.store.getConversation(binding.conversationId),
						run: await this.store.getRun(binding.runId),
					}, normalized, options);
				}
				const created = await this.createPrepared(normalized, keyHash, requestHash, !options.deferExecution, options.mcpSessionId);
				await this.store.putIdempotency({
					version: STORAGE_VERSION, keyHash, requestHash, runId: created.run.id,
					conversationId: created.conversation.id, createdAt: nowIso(),
				});
				return this.finishStart(created, normalized, options);
			});
		}
		return this.finishStart(
			await this.createPrepared(normalized, undefined, undefined, !options.deferExecution, options.mcpSessionId),
			normalized,
			options,
		);
	}

	async schedulePreparedRun(runId: string): Promise<RunRecord> {
		let run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) return run;
		const conversation = await this.store.getConversation(run.conversationId);
		if (conversation.policyFingerprint !== this.policy.fingerprint) {
			return this.markNeedsUser(runId, "Trusted operator policy changed before deferred execution; the worker was not started.");
		}
		if (!run.executionReady) run = await this.store.updateRun(runId, { executionReady: true });
		this.scheduleRun(runId, false);
		return run;
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
				const stopped = await this.stopOwnedBrowserRun(requested).catch(() => false);
				if (!stopped) this.scheduleProviderStopReconciliation(runId);
			}
			if (current.status === "cancelled") {
				await this.store.deleteRunRequest(runId).catch(() => undefined);
			}
			this.cancellationIntents.delete(runId);
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
		return cancelled;
	}

	async markNeedsUser(runId: string, reason: string): Promise<RunRecord> {
		const run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) return run;
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
			return this.store.withConversationLock(conversationId, async () => {
				const conversation = await this.store.getConversation(conversationId);
				if (conversation.closedAt) return conversation;
				if (conversation.provider !== "browser") throw new Error(`Provider ${conversation.provider} cannot be closed by the hardened browser broker.`);
				if (!conversation.browserSessionId && conversation.browserPageId === undefined) {
					return this.store.updateConversation(conversationId, { closedAt: nowIso() });
				}
				if (!conversation.browserSessionId || conversation.browserPageId === undefined) {
					throw new Error(`Conversation ${conversationId} has incomplete browser ownership state.`);
				}
				const { driver, expected } = await this.resolveOwnedDriver(conversation);
				await assertExactDriverSession(driver, expected);
				await driver.close(expected.sessionId);
				return this.store.updateConversation(conversationId, { closedAt: nowIso() });
			});
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
				if (session.name !== name) throw new Error("Browser driver returned an attached session with the wrong ownership name.");
				await assertExactDriverSession(route.driver, expected);
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
				try {
					await assertExactDriverSession(route.driver, expected);
					await route.driver.close(expected.sessionId);
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
		return { ...passiveTransportDiscovery(), policy: publicPolicy(this.policy) };
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
			attempted.push(run.id);
			try {
				const stopRun = legacyStopRequest ? await this.store.requestProviderStop(run.id) : run;
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
		}
		return { attempted, stopped, blocked };
	}

	async recoverActiveRuns(): Promise<{ resumed: string[]; blocked: string[]; deferred: string[] }> {
		await this.store.init();
		const runs = await this.store.listRuns({ statuses: ["queued", "running"], limit: 1_000 });
		const resumed: string[] = [];
		const blocked: string[] = [];
		const deferred: string[] = [];
		for (const run of runs) {
			if (!run.executionReady) {
				deferred.push(run.id);
				continue;
			}
			const conversation = await this.store.getConversation(run.conversationId);
			if (conversation.policyFingerprint !== this.policy.fingerprint) {
				await this.markNeedsUser(run.id, "Trusted operator policy changed while the run was inactive; recovery refused.");
				blocked.push(run.id);
				continue;
			}
			try {
				if (run.idempotencyKeyHash) {
					if (!run.idempotencyRequestHash) throw new Error("Idempotent run is missing its durable request hash.");
					await this.store.withIdempotencyHashLock(run.idempotencyKeyHash, async (keyHash) => {
						const existing = await this.store.getIdempotencyByHash(keyHash);
						if (existing && (existing.runId !== run.id || existing.requestHash !== run.idempotencyRequestHash)) {
							throw new Error("Idempotency index conflicts with the durable run.");
						}
						if (!existing) await this.store.putIdempotency({
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
				await this.markNeedsUser(run.id, `Durable recovery payload unavailable: ${errorMessage(error)}`);
				blocked.push(run.id);
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
		return {
			conversation: await this.store.getConversation(created.conversation.id),
			run: await this.waitForRun(created.run.id, request.timeoutMs + 60_000),
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
		const { prompt, promptProofToken, promptSha256, promptObservationSha256 } = preparedPrompt;
		const chatgptModel = request.chatgptModel ?? this.policy.defaultChatGptModel;
		const receipt: ReviewReceipt = {
			provider: conversation.provider,
			requestedModel: chatgptModel === "pro" ? "Pro" : chatgptModel,
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
			status: "queued",
			executionReady,
			providerTurnPending: false,
			providerStopRequested: false,
			promptSha256,
			promptObservationSha256,
			promptProofToken,
			attachmentManifest: manifest,
			submissionState: "not_submitted",
			requestedChatGptModel: chatgptModel,
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
			timeoutMs: request.timeoutMs,
			createdAt: timestamp,
		};
		await this.store.putRunRequest(durableRequest);
		try {
			await this.store.putRun(run);
		} catch (error) {
			await this.store.deleteRunRequest(run.id).catch(() => undefined);
			throw error;
		}
		return run;
	}

	private prepareRunPrompt(request: NormalizedStartRequest, manifest: AttachmentManifest): PreparedRunPrompt {
		const promptBody = request.kind === "consult"
			? buildReviewPrompt(request.prompt, manifest)
			: request.prompt;
		const prompt = promptBody;
		if (Buffer.byteLength(prompt, "utf8") > this.policy.maxPromptBytes) {
			throw new Error(`Prompt exceeds trusted ${this.policy.maxPromptBytes}-byte limit.`);
		}
		return {
			prompt,
			promptSha256: sha256(prompt),
			promptObservationSha256: sha256(canonicalPromptObservationText(promptBody)),
		};
	}

	private scheduleRun(runId: string, recovery: boolean): Promise<RunRecord> {
		const existing = this.activeRuns.get(runId);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const promise = (async () => {
			const run = await this.store.getRun(runId);
			const work = () => this.store.withConversationLock(
				run.conversationId,
				() => this.executeRun(runId, controller.signal, recovery),
				{ timeoutMs: Math.max(30_000, (run.timeoutMs ?? 600_000) + 60_000) },
			);
			if (run.kind !== "subagent") return work();
			const admitted = await this.waitForGlobalWorkerTurn(runId, controller.signal);
			return admitted
				? this.workerSlots.run(work, controller.signal)
				: this.store.getRun(runId);
		})().catch(async (error) => {
			if (this.cancellationIntents.has(runId)) return this.persistCancellation(runId);
			const current = await this.store.getRun(runId);
			if (TERMINAL.has(current.status)) return current;
			if (controller.signal.reason instanceof RestartSuspension) return current;
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
		}).finally(() => {
			this.activeRuns.delete(runId);
			this.cancellationIntents.delete(runId);
		});
		this.activeRuns.set(runId, { controller, promise });
		void promise.catch(() => undefined);
		return promise;
	}

	private async waitForGlobalWorkerTurn(runId: string, signal: AbortSignal): Promise<boolean> {
		for (;;) {
			if (signal.aborted) throw signal.reason ?? new Error("Worker admission was cancelled.");
			const current = await this.store.getRun(runId);
			if (TERMINAL.has(current.status)) return false;
			const contenders = (await this.store.listRuns({ limit: null }))
				.filter((run) => run.kind === "subagent" && (
					run.providerTurnPending === true
					|| (run.executionReady && (run.status === "queued" || run.status === "running"))
					|| (run.providerTurnPending === undefined && (run.status === "needs_user" || run.status === "cancelled")
						&& (run.submissionState === "submitting" || run.submissionState === "submitted"))
				))
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
			const position = contenders.findIndex((run) => run.id === runId);
			if (position >= 0 && position < this.policy.maxConcurrentWorkers) return true;
			const deadline = Date.parse(current.deadlineAt ?? "");
			if (Number.isFinite(deadline) && Date.now() >= deadline) {
				await this.store.updateRun(runId, {
					status: "needs_user", completedAt: nowIso(),
					error: "The Pro worker exceeded its bounded global admission deadline before a trusted concurrency slot became available.",
				});
				return false;
			}
			await abortableSleep(100, signal);
		}
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
		let modelVerified = run.receipt.modelVerified === true;
		let modelVerifiedAt = run.receipt.modelVerifiedAt;
		let modelEvidenceKind = run.receipt.modelEvidenceKind === "composer_selector"
			? "composer_selector" as const
			: undefined;

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
			const selected = await driver.selectModel(ready.session, requestedModel, signal);
			observedModel = selected.observedModel;
			modelVerified = true;
			modelVerifiedAt = selected.modelVerifiedAt;
			modelEvidenceKind = selected.modelEvidenceKind;
			run = await this.store.updateRun(run.id, {
				baselineMessageCount: baselineCount,
				receipt: {
					...run.receipt,
					requestedModel: selected.requestedModel,
					observedModel,
					model: observedModel,
					modelVerified: true,
					modelEvidenceKind,
					modelVerifiedAt,
				},
			});
			await driver.upload(ready.session, run.attachmentManifest.files.map((file) => file.path), signal);
			await driver.fill(ready.session, request.prompt, signal);
			const verified = await driver.verifyModel(ready.session, requestedModel, signal);
			observedModel = verified.observedModel;
			modelVerifiedAt = verified.modelVerifiedAt;
			modelEvidenceKind = verified.modelEvidenceKind;
			run = await this.store.updateRun(run.id, {
				submissionState: "submitting",
				providerTurnPending: true,
				receipt: {
					...run.receipt,
					requestedModel: verified.requestedModel,
					observedModel,
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
			const preSendObservation = await driver.observe(ready.session, signal);
			await driver.send(ready.session, signal);
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
			let submittedIdentity: { id: string; url: string } | undefined;
			let persisted: { conversation: ConversationRecord; run: RunRecord } | undefined;
			let firstNewProviderUserMessageId: string | undefined;
			while (Date.now() < identityDeadline) {
				const submittedSession = await assertExactDriverSession(driver, expected, signal);
				const observation = await driver.observe(submittedSession, signal);
				const observedUserMessageId = observation.latestUserMessageId;
				if (observedUserMessageId && observedUserMessageId !== preSendObservation.latestUserMessageId) {
					if (firstNewProviderUserMessageId && firstNewProviderUserMessageId !== observedUserMessageId) {
						return browserNeedsUser(
							"The provider user turn changed before send-boundary identity was durable. Completion was not attributed to this run.",
							conversation, run,
						);
					}
					firstNewProviderUserMessageId = observedUserMessageId;
					if (run.promptProofToken && !this.observationProvesPrompt(run, observation)) {
						return browserNeedsUser(
							"The first new provider user turn did not match the broker-owned send-boundary proof. Completion was not attributed to this run.",
							conversation, run,
						);
					}
					submittedIdentity = providerConversationIdentity(submittedSession.url);
					if (submittedIdentity) {
						persisted = await this.persistObservedProviderTurnIdentity(conversation, run, submittedIdentity, observation, true);
						if (persisted) break;
					}
				}
				await abortableSleep(100, signal);
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

		const remaining = Math.max(1, Math.min(
			run.timeoutMs ?? 600_000,
			Date.parse(run.deadlineAt ?? "") - Date.now() || (run.timeoutMs ?? 600_000),
		));
		const outcome = await waitForCompletedDriverTurn(driver, expected, {
			baselineCount: required(baselineCount, "assistant-turn baseline"),
			timeoutMs: remaining,
			conversationUrl: conversation.providerConversationUrl,
			providerTurnIdentityPersisted: Boolean(run.providerUserMessageId && run.receipt.providerConversationUrl),
			signal,
			onConversationIdentity: async (identity) => {
				await this.persistConversationIdentity(conversation.id, identity);
			},
			onConversationObservation: async (identity, observation) => {
				const expectedIdentity = run.receipt.providerConversationUrl
					? providerConversationIdentity(run.receipt.providerConversationUrl)
					: undefined;
				if (!expectedIdentity || expectedIdentity.url !== identity.url) return "mismatch";
				if (observation.latestUserMessageId
					&& observation.latestUserMessageId !== run.providerUserMessageId) return "mismatch";
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
		});
		if (outcome.terminalStatus === "needs_user") {
			await driver.setState(expected.sessionId, "needs_user", signal).catch(() => undefined);
			return completionOutcomeToProviderResult(driver.id, outcome, {
				observedModel, modelVerified, modelEvidenceKind, modelVerifiedAt,
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
			if (run.receipt.browserDriverId !== owned.driver.id
				|| run.receipt.localBrowserSessionId !== owned.expected.sessionId) {
				run = await this.store.updateRun(run.id, {
					receipt: {
						...run.receipt,
						browserDriverId: owned.driver.id,
						localBrowserSessionId: owned.expected.sessionId,
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
				await owned.driver.close(owned.expected.sessionId);
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
			if (session.name !== name) throw new Error("Browser driver returned a session with the wrong ownership name.");
			await assertExactDriverSession(available.driver, expected, signal);
			conversation = await this.store.updateConversation(conversation.id, {
				browserSessionId: session.sessionId,
				browserPageId: session.pageId,
			});
			persisted = true;
			run = await this.store.updateRun(run.id, {
				receipt: {
					...run.receipt,
					browserDriverId: available.driver.id,
					localBrowserSessionId: session.sessionId,
				},
			});
			if (TERMINAL.has(run.status)) {
				await assertExactDriverSession(available.driver, expected);
				await available.driver.close(session.sessionId);
				await this.store.updateConversation(conversation.id, { closedAt: nowIso() });
				throw new Error("Run became terminal while its owned browser session was being allocated.");
			}
			return { conversation, run, driver: available.driver, expected };
		} catch (error) {
			if (!persisted) {
				try {
					if (session.name !== name) throw new Error("Created browser session did not retain its broker ownership name.");
					await assertExactDriverSession(available.driver, expected);
					await available.driver.close(session.sessionId);
				} catch (cleanupError) {
					conversation = await this.store.updateConversation(conversation.id, {
						browserSessionId: session.sessionId,
						browserPageId: session.pageId,
					});
					await this.store.updateRun(run.id, {
						receipt: {
							...run.receipt,
							browserDriverId: available.driver.id,
							localBrowserSessionId: session.sessionId,
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
		await driver.close(expected.sessionId);
		await this.store.updateConversation(conversationId, { closedAt: nowIso() });
	}

	private async resolveOwnedDriver(
		conversation: ConversationRecord,
	): Promise<{ driver: WebChatDriver; expected: ExpectedDriverSession }> {
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
		await assertExactDriverSession(available.driver, expected);
		return { driver: available.driver, expected };
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
			error: "Cancelled by caller. Late provider completion is ignored.",
		});
	}

	private observationProvesRun(run: RunRecord, observation: ChatPageObservation): boolean {
		return Boolean(run.providerUserMessageId
			&& observation.latestUserMessageId === run.providerUserMessageId
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
		if (run.providerUserMessageId && run.providerUserMessageId !== observation.latestUserMessageId) return undefined;
		if (run.providerUserMessageId === observation.latestUserMessageId
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
		return Boolean(run.promptProofToken
			&& run.promptObservationSha256
			&& observation.latestUserPromptProofToken === run.promptProofToken
			&& observation.latestUserPromptSha256 === run.promptObservationSha256);
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
				terminalReason: reason,
				recoveryAttempts: result?.recoveryAttempts,
				localAssistantTurnCount: result?.localAssistantTurnCount,
				lastObservedUrl: result?.lastObservedUrl,
				lastObservedUiState: result?.lastObservedUiState,
			},
			receipt: {
				...run.receipt,
				observedModel: result?.observedModel ?? run.receipt.observedModel,
				model: result?.observedModel ?? run.receipt.model,
				modelVerified: result?.modelVerified ?? run.receipt.modelVerified ?? false,
				modelEvidenceKind: result?.modelEvidenceKind ?? run.receipt.modelEvidenceKind,
				modelVerifiedAt: result?.modelVerifiedAt ?? run.receipt.modelVerifiedAt,
				providerConversationId: result?.providerConversationId ?? run.receipt.providerConversationId,
				providerConversationUrl: result?.providerConversationUrl ?? run.receipt.providerConversationUrl,
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
	idempotencyKey?: string;
	connectorIntent?: { names: string[]; mode: "prefer" | "require" };
	wait: boolean;
	timeoutMs: number;
	allowOutsideWorkspace: boolean;
	allowSensitiveFiles: boolean;
}

interface PreparedRunPrompt {
	prompt: string;
	promptProofToken?: string;
	promptSha256: string;
	promptObservationSha256: string;
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
		throw new Error("provider_model cannot establish ChatGPT composer provenance. Use the live verified Pro selector.");
	}
	if (request.transport && request.transport !== "browser") {
		throw new Error(`Transport ${request.transport} is disabled by the hardened 0.3 broker.`);
	}
	if (request.apiConfirmed) {
		throw new Error("api_confirmed cannot grant paid-provider authority and no paid fallback is enabled.");
	}
	if (request.allowFocusSteal) {
		throw new Error("allow_focus_steal cannot grant browser authority and no focus-stealing fallback is enabled.");
	}
	if (request.chatgptModel && request.chatgptModel !== "pro") {
		throw new Error("The hardened browser contract currently supports only a live-verified ChatGPT Pro selection.");
	}
	if (request.kind === "subagent" && request.conversationId) {
		throw new Error("Each Pro subagent requires an independent owned conversation; conversation_id is not accepted.");
	}
	if (request.kind !== "subagent" && ((request.connectors?.length ?? 0) > 0 || request.connectorMode)) {
		throw new Error("Connector intent is supported only for independent Pro subagents.");
	}
	const connectorNames = [...new Set((request.connectors ?? []).map((name) => name.trim()))];
	if (connectorNames.length > 8 || connectorNames.some((name) => !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/.test(name))) {
		throw new Error("Connector names must be 1-64 safe characters, with at most eight distinct names.");
	}
	const connectorIntent = connectorNames.length > 0
		? { names: connectorNames, mode: request.connectorMode ?? "prefer" }
		: undefined;
	return {
		kind: request.kind,
		prompt: request.prompt,
		files: [...(request.files ?? [])],
		conversationId: request.conversationId,
		transport: "browser",
		chatgptModel: "pro",
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
		connectorIntent: request.connectorIntent ?? null,
		timeoutMs: request.timeoutMs,
	};
	// Preserve the pre-hardening hash for the default restricted request. Only
	// explicit exception opt-ins extend the idempotency identity.
	if (request.allowOutsideWorkspace) value.allowOutsideWorkspace = true;
	if (request.allowSensitiveFiles) value.allowSensitiveFiles = true;
	return sha256(JSON.stringify(value));
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
		maxConcurrentWorkers: policy.maxConcurrentWorkers,
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
		throw new Error("Conversation URL must identify one exact https://chatgpt.com/c/<id> conversation without query or fragment data.");
	}
	if (identity.id.length > 256) throw new Error("ChatGPT provider conversation id is too long.");
	return identity;
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
