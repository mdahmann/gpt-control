import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	describeCapabilities,
	resetCapabilityCache,
	resolveCapabilities,
	selectRoute,
	type Capabilities,
	type Route,
	type TransportChoice,
} from "./capability";
import {
	CHATGPT_ORIGIN,
	attachFiles,
	clickSend,
	closeSession,
	fillPrompt,
	createSession,
	openChat,
	selectAndVerifyChatGptModel,
	setSessionState,
	verifyChatGptModelBeforeSend,
	waitForCompletedAssistantTurn,
	waitForOwnedChatReady,
	assertOwnedSessionTab,
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
	type ReviewReceipt,
	type RunKind,
	type RunRecord,
	type RunStatus,
} from "./domain";
import { buildAttachmentManifest } from "./files";
import {
	assertTransportAllowed,
	resolveTrustedProviderModel,
	operatorPolicyFromEnv,
	type OperatorPolicy,
} from "./policy";
import { runCodexTurn, runResponsesTurn, type ProviderTurnResult } from "./providers";
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
	/** Typed ChatGPT composer selection. Chrome/subagent defaults to trusted policy (Pro). */
	chatgptModel?: ChatGptModel;
	/** Provider model may only select a model already allowed by trusted operator policy. */
	providerModel?: string;
	idempotencyKey?: string;
	wait?: boolean;
	timeoutMs?: number;
}

export interface StartResult {
	conversation: ConversationRecord;
	run: RunRecord;
}

export interface StartOptions {
	/** Trusted internal control used to bind durable MCP task cancellation before provider execution. */
	deferExecution?: boolean;
}

export interface ServiceDependencies {
	resolveCapabilities?: (exec: Exec, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<Capabilities>;
	runCodexTurn?: typeof runCodexTurn;
	runResponsesTurn?: typeof runResponsesTurn;
}

interface ActiveRun {
	controller: AbortController;
	promise: Promise<RunRecord>;
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
		try {
			return await work();
		} finally {
			this.release();
		}
	}

	private acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Worker admission was cancelled."));
		if (this.active < this.limit) {
			this.active += 1;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const waiter: { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void } = { resolve, reject, signal };
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
		this.dependencies = {
			resolveCapabilities: dependencies.resolveCapabilities ?? resolveCapabilities,
			runCodexTurn: dependencies.runCodexTurn ?? runCodexTurn,
			runResponsesTurn: dependencies.runResponsesTurn ?? runResponsesTurn,
		};
		this.workerSlots = new FairSemaphore(this.policy.maxConcurrentWorkers);
	}

	async start(request: StartRequest, options: StartOptions = {}): Promise<StartResult> {
		const normalized = normalizeStartRequest(request, this.policy);
		if (options.deferExecution && normalized.wait) {
			throw new Error("Deferred execution requires wait=false.");
		}
		await this.store.init();
		const requestHash = startRequestHash(normalized);
		if (normalized.idempotencyKey) {
			return this.store.withIdempotencyLock(normalized.idempotencyKey, async (keyHash) => {
				let binding = await this.store.getIdempotencyByHash(keyHash);
				if (!binding) {
					const prepared = await this.store.findRunsByIdempotencyKeyHash(keyHash);
					if (prepared.length > 1) {
						throw new Error("Multiple durable runs share one idempotency key hash; execution refused pending operator review.");
					}
					const orphan = prepared[0];
					if (orphan) {
						if (orphan.idempotencyRequestHash !== requestHash) {
							throw new Error("Idempotency key was already prepared for a different GPT-Control request.");
						}
						binding = {
							version: STORAGE_VERSION,
							keyHash,
							requestHash,
							runId: orphan.id,
							conversationId: orphan.conversationId,
							createdAt: orphan.createdAt,
						};
						await this.store.putIdempotency(binding);
					}
				}
				if (binding) {
					if (binding.requestHash !== requestHash) {
						throw new Error("Idempotency key was already used for a different GPT-Control request.");
					}
					const existing = {
						conversation: await this.store.getConversation(binding.conversationId),
						run: await this.store.getRun(binding.runId),
					};
					return this.finishStart(existing, normalized, options);
				}
				const created = await this.createPrepared(normalized, keyHash, requestHash, !options.deferExecution);
				await this.store.putIdempotency({
					version: STORAGE_VERSION,
					keyHash,
					requestHash,
					runId: created.run.id,
					conversationId: created.conversation.id,
					createdAt: nowIso(),
				});
				return this.finishStart(created, normalized, options);
			});
		}
		return this.finishStart(await this.createPrepared(normalized, undefined, undefined, !options.deferExecution), normalized, options);
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

	async getRun(runId: string): Promise<RunRecord> {
		return this.store.getRun(runId);
	}

	async listRuns(limit = 20): Promise<RunRecord[]> {
		return this.store.listRuns({ limit: Math.max(1, Math.min(limit, 100)) });
	}

	async waitForRun(runId: string, timeoutMs = 10 * 60_000): Promise<RunRecord> {
		const active = this.activeRuns.get(runId);
		if (active) {
			const result = await Promise.race([
				active.promise,
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
			]);
			if (result && TERMINAL.has(result.status)) return result;
		}
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const run = await this.store.getRun(runId);
			if (TERMINAL.has(run.status) || Date.now() >= deadline) return run;
			await sleep(200);
		}
	}

	/** Gracefully stop in-process monitors while preserving durable submitted state for restart recovery. */
	async suspendActiveRunsForRestart(): Promise<void> {
		const active = [...this.activeRuns.values()];
		for (const value of active) value.controller.abort(new RestartSuspension());
		await Promise.allSettled(active.map((value) => value.promise));
	}

	async cancelRun(runId: string): Promise<RunRecord> {
		// Abort the local watcher before the first await so a concurrently-rendered final
		// answer cannot outrun a cancellation request in this process. The durable
		// terminal transition below remains the cross-process source of truth.
		this.activeRuns.get(runId)?.controller.abort(new Error("Cancelled by caller."));
		const run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) return run;
		return this.store.updateRun(runId, {
			status: "cancelled",
			completedAt: nowIso(),
			error: "Cancelled by caller. Late provider completion is ignored.",
		});
	}

	async markNeedsUser(runId: string, reason: string): Promise<RunRecord> {
		const run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) return run;
		const blocked = await this.store.updateRun(runId, {
			status: "needs_user",
			completedAt: nowIso(),
			error: reason,
			diagnostics: { ...(run.diagnostics ?? {}), terminalReason: reason },
		});
		this.activeRuns.get(runId)?.controller.abort();
		return blocked;
	}

	async closeConversation(conversationId: string): Promise<ConversationRecord> {
		const conversation = await this.store.getConversation(conversationId);
		if (conversation.provider === "chrome_bridge") {
			const capabilities = await this.dependencies.resolveCapabilities(this.exec);
			if (!capabilities.bridge) throw new Error("Chrome Bridge is unavailable; the owned conversation tab was not closed.");
			const sessionId = required(conversation.bridgeSessionId, "bridge session id");
			const tabId = required(conversation.bridgeTabId, "bridge tab id");
			await assertOwnedSessionTab(this.exec, capabilities.bridge.launcher, sessionId, tabId);
			await closeSession(this.exec, capabilities.bridge.launcher, sessionId);
		}
		return this.store.updateConversation(conversationId, { closedAt: nowIso() });
	}

	/** Passive discovery only: no discovered Bridge, Oracle, or Codex program executes. */
	async diagnose(): Promise<Record<string, unknown>> {
		return {
			...passiveTransportDiscovery(),
			policy: publicPolicy(this.policy),
		};
	}

	/** Explicit active smoke test, disabled unless trusted operator policy permits it. */
	async activeSmokeTest(): Promise<Record<string, unknown>> {
		if (!this.policy.allowActiveDiagnostics) {
			throw new Error("Active diagnostics are disabled by trusted operator policy.");
		}
		return describeCapabilities(await this.dependencies.resolveCapabilities(this.exec));
	}

	async recoverActiveRuns(): Promise<{ resumed: string[]; blocked: string[]; deferred: string[] }> {
		const runs = await this.store.listRuns({ statuses: ["queued", "running"], limit: 100 });
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
				await this.store.updateRun(run.id, {
					status: "needs_user",
					completedAt: nowIso(),
					error: "Trusted operator policy changed while the run was inactive; recovery refused.",
				});
				blocked.push(run.id);
				continue;
			}
			try {
				if (run.idempotencyKeyHash) {
					if (!run.idempotencyRequestHash) {
						throw new Error("Idempotent run is missing its durable request hash.");
					}
					await this.store.withIdempotencyHashLock(run.idempotencyKeyHash, async (keyHash) => {
						const existing = await this.store.getIdempotencyByHash(keyHash);
						if (existing && (existing.runId !== run.id || existing.requestHash !== run.idempotencyRequestHash)) {
							throw new Error("Idempotency index conflicts with the durable run; automatic recovery refused.");
						}
						if (!existing) {
							await this.store.putIdempotency({
								version: STORAGE_VERSION,
								keyHash,
								requestHash: run.idempotencyRequestHash!,
								runId: run.id,
								conversationId: run.conversationId,
								createdAt: run.createdAt,
							});
						}
					});
				}
				await this.store.getRunRequest(run.id);
				this.scheduleRun(run.id, true);
				resumed.push(run.id);
			} catch (error) {
				await this.store.updateRun(run.id, {
					status: "needs_user",
					completedAt: nowIso(),
					error: `Durable recovery payload unavailable: ${errorMessage(error)}`,
				});
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
	): Promise<StartResult> {
		const manifest = await buildAttachmentManifest(request.files, {
			workspaceRoot: this.policy.workspaceRoot,
			snapshotRoot: this.policy.snapshotRoot,
			allowOutsideWorkspace: this.policy.allowOutsideWorkspace,
			allowSensitiveFiles: this.policy.allowSensitiveFiles,
			maxFiles: this.policy.maxAttachmentFiles,
			maxBytes: this.policy.maxAttachmentBytes,
		});
		const conversation = request.conversationId
			? await this.resumeConversation(request.conversationId, request.transport)
			: await this.createConversation(request, manifest);
		if (conversation.provider !== "chrome_bridge") {
			request.providerModel = resolveTrustedProviderModel(this.policy, conversation.provider, request.providerModel);
		}
		const run = await this.createRun(request, conversation, manifest, idempotencyHash, idempotencyRequestHash, executionReady);
		return { conversation, run };
	}

	private scheduleRun(runId: string, recovery: boolean): Promise<RunRecord> {
		const existing = this.activeRuns.get(runId);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const promise = (async () => {
			const run = await this.store.getRun(runId);
			const work = () => this.store.withConversationLock(run.conversationId, () => this.executeRun(runId, controller.signal, recovery), {
				timeoutMs: Math.max(30_000, (run.timeoutMs ?? 600_000) + 60_000),
			});
			if (run.kind !== "subagent") return work();
			return this.workerSlots.run(async () => {
				const admitted = await this.waitForGlobalWorkerTurn(runId, controller.signal);
				return admitted ? work() : this.store.getRun(runId);
			}, controller.signal);
		})().catch(async (error) => {
			const current = await this.store.getRun(runId);
			if (TERMINAL.has(current.status)) return current;
			throw error;
		}).finally(() => this.activeRuns.delete(runId));
		this.activeRuns.set(runId, { controller, promise });
		void promise.catch(() => undefined);
		return promise;
	}

	private async waitForGlobalWorkerTurn(runId: string, signal: AbortSignal): Promise<boolean> {
		for (;;) {
			if (signal.aborted) throw signal.reason ?? new Error("Worker admission was cancelled.");
			const current = await this.store.getRun(runId);
			if (TERMINAL.has(current.status)) return false;
			const contenders = (await this.store.listRuns({ statuses: ["queued", "running"], limit: 1000 }))
				.filter((run) => run.kind === "subagent")
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
			const position = contenders.findIndex((run) => run.id === runId);
			if (position >= 0 && position < this.policy.maxConcurrentWorkers) return true;
			const deadline = Date.parse(current.deadlineAt ?? "");
			if (Number.isFinite(deadline) && Date.now() >= deadline) {
				await this.store.updateRun(runId, {
					status: "needs_user",
					completedAt: nowIso(),
					error: "The Pro worker exceeded its bounded global admission deadline before a trusted concurrency slot became available.",
				});
				return false;
			}
			await abortableSleep(100, signal);
		}
	}

	private async createConversation(request: NormalizedStartRequest, manifest: AttachmentManifest): Promise<ConversationRecord> {
		const capabilities = await this.dependencies.resolveCapabilities(this.exec);
		const desiredTransport = request.kind === "subagent" ? "chrome_bridge" : request.transport;
		const route = selectRoute(capabilities, { transport: desiredTransport });
		assertTransportAllowed(this.policy, route.kind);
		if (request.kind === "subagent" && route.kind !== "chrome_bridge") {
			throw new Error("A Pro subagent requires Chrome Bridge; no local-provider fallback is permitted.");
		}
		const timestamp = nowIso();
		const conversation: ConversationRecord = {
			version: STORAGE_VERSION,
			id: opaqueId("conv"),
			provider: route.kind,
			workspaceRoot: manifest.workspaceRoot,
			policyFingerprint: this.policy.fingerprint,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (route.kind === "chrome_bridge") {
			const launcher = required(route.launcher, "Chrome Bridge launcher");
			if (!launcher.privateRpc) {
				throw new Error("Chrome Bridge lacks the private request-file transport required for prompt and attachment secrecy.");
			}
			const sessionId = await createSession(this.exec, launcher, `gpt-control:${request.kind}:${conversation.id}`);
			const tabId = await openChat(this.exec, launcher, sessionId, CHATGPT_ORIGIN);
			conversation.bridgeSessionId = sessionId;
			conversation.bridgeTabId = tabId;
		}
		await this.store.putConversation(conversation);
		return conversation;
	}

	private async resumeConversation(id: string, transport?: TransportChoice): Promise<ConversationRecord> {
		const conversation = await this.store.getConversation(id);
		if (conversation.closedAt) throw new Error(`Conversation ${id} is closed.`);
		if (transport && transport !== conversation.provider) {
			throw new Error(`Conversation ${id} uses ${conversation.provider}; it cannot be resumed through ${transport}.`);
		}
		if (conversation.policyFingerprint !== this.policy.fingerprint) {
			throw new Error("Conversation trust boundary differs from current trusted operator policy; follow-up refused.");
		}
		assertTransportAllowed(this.policy, conversation.provider);
		if (conversation.provider === "oracle_browser" || conversation.provider === "oracle_api") {
			throw new Error("Oracle transport is disabled by the hardened broker.");
		}
		return conversation;
	}

	private async createRun(
		request: NormalizedStartRequest,
		conversation: ConversationRecord,
		manifest: AttachmentManifest,
		idempotencyHash?: string,
		idempotencyRequestHash?: string,
		executionReady = true,
	): Promise<RunRecord> {
		const timestamp = nowIso();
		const id = opaqueId("run");
		const prompt = request.kind === "consult" ? buildReviewPrompt(request.prompt, manifest) : request.prompt;
		const promptSha256 = sha256(prompt);
		const chatgptModel = conversation.provider === "chrome_bridge"
			? (request.chatgptModel ?? this.policy.defaultChatGptModel)
			: undefined;
		const requestedModel = chatgptModel === "pro" ? "Pro" : request.providerModel;
		const receipt: ReviewReceipt = {
			provider: conversation.provider,
			requestedModel,
			promptSha256,
			attachments: manifest.files,
			startedAt: timestamp,
			conversationId: conversation.id,
			runId: id,
			providerConversationId: conversation.providerConversationId,
			providerConversationUrl: conversation.providerConversationUrl,
			localBridgeSessionId: conversation.bridgeSessionId,
		};
		const run: RunRecord = {
			version: STORAGE_VERSION,
			id,
			conversationId: conversation.id,
			kind: request.kind,
			status: "queued",
			executionReady,
			promptSha256,
			attachmentManifest: manifest,
			submissionState: conversation.provider === "chrome_bridge" ? "not_submitted" : "not_applicable",
			requestedChatGptModel: chatgptModel,
			providerModel: request.providerModel,
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
			providerModel: request.providerModel,
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

	private async executeRun(runId: string, signal: AbortSignal, recovery: boolean): Promise<RunRecord> {
		let run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) return run;
		const conversation = await this.store.getConversation(run.conversationId);
		if (conversation.policyFingerprint !== this.policy.fingerprint) {
			return this.finishNeedsUser(run, "Trusted operator policy changed before provider execution; the request was not sent.");
		}
		const request = await this.store.getRunRequest(run.id);
		if (recovery && run.status === "running" && conversation.provider !== "chrome_bridge") {
			return this.finishNeedsUser(run, "A non-browser provider request was in flight across process restart. GPT-Control will not resend a possibly paid or duplicate request.");
		}
		if (run.status === "queued") run = await this.store.updateRun(run.id, { status: "running" });
		try {
			const result = await this.executeProvider(conversation, run, request, signal);
			if (result.terminalStatus === "needs_user") {
				return await this.finishNeedsUser(run, result.terminalReason ?? "Provider requires operator input.", result);
			}
			if (result.terminalStatus !== "completed") throw new Error("Provider did not return an honest terminal status.");
			if (result.text.trim() === "" && (result.imageUrls?.length ?? 0) === 0) {
				throw new Error("Provider returned no stable final output.");
			}
			const completedAt = nowIso();
			const report = run.kind === "consult" ? parseReviewReport(result.text, run.attachmentManifest) : undefined;
			const resultSha256 = sha256(`${result.text}\u0000${(result.imageUrls ?? []).join("\n")}`);
			await this.store.updateConversation(conversation.id, {
				providerConversationId: result.providerConversationId ?? conversation.providerConversationId,
				providerConversationUrl: result.providerConversationUrl ?? conversation.providerConversationUrl,
				bridgeAssistantTurnCount: result.localAssistantTurnCount ?? conversation.bridgeAssistantTurnCount,
			});
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
					providerEndpoint: result.providerEndpoint,
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
			const current = await this.store.getRun(run.id);
			if (signal.aborted && signal.reason instanceof RestartSuspension) return current;
			if (current.status === "cancelled" || signal.aborted) return current.status === "cancelled"
				? current
				: this.store.updateRun(run.id, { status: "cancelled", completedAt: nowIso(), error: "Cancelled while provider work was active." });
			return this.store.updateRun(run.id, {
				status: "failed",
				error: errorMessage(error),
				completedAt: nowIso(),
			});
		} finally {
			const final = await this.store.getRun(run.id).catch(() => undefined);
			if (final && TERMINAL.has(final.status)) await this.store.deleteRunRequest(run.id).catch(() => undefined);
		}
	}

	private async executeProvider(
		conversation: ConversationRecord,
		run: RunRecord,
		request: DurableRunRequest,
		signal: AbortSignal,
	): Promise<ProviderTurnResult> {
		if (conversation.provider === "codex") {
			const model = resolveTrustedProviderModel(this.policy, "codex", request.providerModel);
			return this.dependencies.runCodexTurn({
				kind: run.kind,
				prompt: request.prompt,
				manifest: run.attachmentManifest,
				providerConversationId: conversation.providerConversationId,
				model,
				signal,
			});
		}
		if (conversation.provider === "responses") {
			const model = resolveTrustedProviderModel(this.policy, "responses", request.providerModel);
			const confirmed = await this.policy.confirmPaidRequest?.({
				provider: "responses",
				conversationId: conversation.id,
				runId: run.id,
				kind: run.kind,
				followup: Boolean(conversation.providerConversationId),
				model,
				endpoint: this.policy.openAIBaseUrl,
			});
			if (confirmed !== true) {
				throw new Error("Fresh trusted operator confirmation is required for this paid Responses request; prior confirmation is not reusable.");
			}
			return this.dependencies.runResponsesTurn({
				kind: run.kind,
				prompt: request.prompt,
				manifest: run.attachmentManifest,
				providerConversationId: conversation.providerConversationId,
				model,
				providerEndpoint: this.policy.openAIBaseUrl,
				signal,
			});
		}
		if (conversation.provider !== "chrome_bridge") {
			throw new Error(`Provider ${conversation.provider} is disabled by the hardened broker.`);
		}
		const capabilities = await this.dependencies.resolveCapabilities(this.exec);
		const bridge = capabilities.bridge;
		if (!bridge) throw new Error("Chrome Bridge became unavailable. No foreground or paid fallback was launched.");
		if (!bridge.launcher.privateRpc) {
			throw new Error("Chrome Bridge private request-file transport is unavailable; prompt submission refused.");
		}
		return this.runBrowserTurn(conversation, run, request, bridge.launcher, signal);
	}

	private async runBrowserTurn(
		conversation: ConversationRecord,
		originalRun: RunRecord,
		request: DurableRunRequest,
		launcher: NonNullable<Route["launcher"]>,
		signal: AbortSignal,
	): Promise<ProviderTurnResult> {
		const sessionId = required(conversation.bridgeSessionId, "bridge session id");
		const tabId = required(conversation.bridgeTabId, "bridge tab id");
		let run = originalRun;
		const ready = await waitForOwnedChatReady(this.exec, launcher, sessionId, tabId, {
			timeoutMs: Math.min(60_000, request.timeoutMs),
			signal,
		});
		let baselineCount = run.baselineMessageCount;
		let verification = run.receipt.modelVerified && run.receipt.observedModel
			? {
				requestedModel: run.receipt.requestedModel ?? "Pro",
				observedModel: run.receipt.observedModel,
				modelVerified: true as const,
				modelEvidenceKind: "composer_selector" as const,
				modelVerifiedAt: run.receipt.modelVerifiedAt ?? nowIso(),
			}
			: undefined;

		if (run.submissionState === "not_submitted" || run.submissionState === undefined) {
			baselineCount = ready.snapshot.count;
			const requested = request.requestedChatGptModel ?? this.policy.defaultChatGptModel;
			verification = await selectAndVerifyChatGptModel(this.exec, launcher, tabId, requested, signal);
			run = await this.store.updateRun(run.id, {
				baselineMessageCount: baselineCount,
				receipt: {
					...run.receipt,
					requestedModel: verification.requestedModel,
					observedModel: verification.observedModel,
					model: verification.observedModel,
					modelVerified: true,
					modelEvidenceKind: verification.modelEvidenceKind,
					modelVerifiedAt: verification.modelVerifiedAt,
				},
			});
			await attachFiles(this.exec, launcher, tabId, run.attachmentManifest.files.map((file) => file.path), signal);
			await fillPrompt(this.exec, launcher, tabId, request.prompt, signal);
			verification = await verifyChatGptModelBeforeSend(this.exec, launcher, tabId, requested, signal);
			run = await this.store.updateRun(run.id, {
				submissionState: "submitting",
				receipt: {
					...run.receipt,
					observedModel: verification.observedModel,
					model: verification.observedModel,
					modelVerified: true,
					modelEvidenceKind: verification.modelEvidenceKind,
					modelVerifiedAt: verification.modelVerifiedAt,
				},
			});
			await clickSend(this.exec, launcher, tabId, signal);
			run = await this.store.updateRun(run.id, { submissionState: "submitted" });
		} else if (run.submissionState === "submitting" || run.submissionState === "submitted") {
			if (baselineCount === undefined) {
				return {
					provider: "chrome_bridge",
					terminalStatus: "needs_user",
					terminalReason: "Recovered browser run has ambiguous submission state and no durable assistant-turn baseline. Prompt was not resent.",
					text: "",
					localAssistantTurnCount: ready.snapshot.count,
					lastObservedUrl: ready.url,
					lastObservedUiState: "ambiguous_submission_without_baseline",
				};
			}
		} else {
			throw new Error(`Invalid Chrome submission state ${run.submissionState}.`);
		}

		const remaining = Math.max(1, Math.min(
			request.timeoutMs,
			Date.parse(run.deadlineAt ?? "") - Date.now() || request.timeoutMs,
		));
		const outcome = await waitForCompletedAssistantTurn(this.exec, launcher, sessionId, tabId, {
			baselineCount: required(baselineCount, "assistant-turn baseline"),
			timeoutMs: remaining,
			conversationUrl: conversation.providerConversationUrl,
			signal,
		});
		if (outcome.terminalStatus === "needs_user") {
			await setSessionState(this.exec, launcher, sessionId, "needs_user", signal).catch(() => undefined);
			return {
				provider: "chrome_bridge",
				terminalStatus: "needs_user",
				terminalReason: outcome.reason,
				text: "",
				providerConversationId: outcome.providerConversationId,
				providerConversationUrl: outcome.providerConversationUrl,
				observedModel: verification?.observedModel,
				modelVerified: Boolean(verification),
				modelEvidenceKind: verification?.modelEvidenceKind,
				modelVerifiedAt: verification?.modelVerifiedAt,
				transportVersion: `chrome-bridge/private-rpc; gpt-control/${PACKAGE_VERSION}`,
				localAssistantTurnCount: outcome.snapshot?.count,
				recoveryAttempts: outcome.recoveryAttempts,
				lastObservedUrl: outcome.lastObservedUrl,
				lastObservedUiState: outcome.lastObservedUiState,
			};
		}
		const snapshot = required(outcome.snapshot, "stable final assistant turn");
		await setSessionState(this.exec, launcher, sessionId, "completed", signal).catch(() => undefined);
		return {
			provider: "chrome_bridge",
			terminalStatus: "completed",
			text: snapshot.text,
			providerConversationId: outcome.providerConversationId,
			providerConversationUrl: outcome.providerConversationUrl,
			providerRunId: snapshot.messageId,
			observedModel: verification?.observedModel,
			modelVerified: Boolean(verification),
			modelEvidenceKind: verification?.modelEvidenceKind,
			modelVerifiedAt: verification?.modelVerifiedAt,
			transportVersion: `chrome-bridge/private-rpc; gpt-control/${PACKAGE_VERSION}`,
			imageUrls: snapshot.imageUrls,
			localAssistantTurnCount: snapshot.count,
			recoveryAttempts: outcome.recoveryAttempts,
			lastObservedUrl: outcome.lastObservedUrl,
			lastObservedUiState: outcome.lastObservedUiState,
		};
	}

	private async finishNeedsUser(
		run: RunRecord,
		reason: string,
		result?: ProviderTurnResult,
	): Promise<RunRecord> {
		return this.store.updateRun(run.id, {
			status: "needs_user",
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
	}
}

interface NormalizedStartRequest {
	kind: RunKind;
	prompt: string;
	files: string[];
	conversationId?: string;
	transport?: TransportChoice;
	chatgptModel?: ChatGptModel;
	providerModel?: string;
	idempotencyKey?: string;
	wait: boolean;
	timeoutMs: number;
}

function normalizeStartRequest(request: StartRequest, policy: OperatorPolicy): NormalizedStartRequest {
	if (request.prompt.trim() === "") throw new Error("prompt is required");
	if (!Number.isFinite(request.timeoutMs ?? 600_000) || (request.timeoutMs ?? 600_000) <= 0) {
		throw new Error("timeout_ms must be a positive number");
	}
	if (request.kind === "subagent" && request.conversationId) {
		throw new Error("Each Pro subagent requires an independent owned conversation; conversation_id is not accepted.");
	}
	if (request.kind === "subagent" && request.transport && request.transport !== "chrome_bridge") {
		throw new Error("Pro subagents require transport=chrome_bridge.");
	}
	if (request.kind === "subagent" && request.chatgptModel && request.chatgptModel !== "pro") {
		throw new Error("The bounded subagent contract currently supports only ChatGPT Pro.");
	}
	if (request.idempotencyKey) idempotencyKeyHash(request.idempotencyKey);
	if (request.transport === "chrome_bridge" && request.providerModel) {
		throw new Error("Use chatgpt_model for Chrome Bridge; provider_model is not composer provenance.");
	}
	if (request.transport && request.transport !== "chrome_bridge" && request.chatgptModel) {
		throw new Error("chatgpt_model applies only to Chrome Bridge runs.");
	}
	return {
		kind: request.kind,
		prompt: request.prompt,
		files: [...(request.files ?? [])],
		conversationId: request.conversationId,
		transport: request.kind === "subagent" ? "chrome_bridge" : request.transport,
		chatgptModel: request.kind === "subagent" ? "pro" : request.chatgptModel,
		providerModel: request.providerModel,
		idempotencyKey: request.idempotencyKey,
		wait: request.wait !== false,
		timeoutMs: Math.min(Math.floor(request.timeoutMs ?? 600_000), 60 * 60_000),
	};
}

function startRequestHash(request: NormalizedStartRequest): string {
	return sha256(JSON.stringify({
		kind: request.kind,
		prompt: request.prompt,
		files: request.files,
		conversationId: request.conversationId ?? null,
		transport: request.transport ?? null,
		chatgptModel: request.chatgptModel ?? null,
		providerModel: request.providerModel ?? null,
		timeoutMs: request.timeoutMs,
	}));
}

function publicPolicy(policy: OperatorPolicy): Record<string, unknown> {
	return {
		workspaceRoot: policy.workspaceRoot,
		allowedTransports: policy.allowedTransports,
		allowedProviderModels: policy.allowedProviderModels ?? [],
		defaultProviderModel: policy.defaultProviderModel,
		defaultChatGptModel: policy.defaultChatGptModel,
		openAIEndpoint: policy.openAIBaseUrl,
		alternateOpenAIEndpointAllowed: policy.allowAlternateOpenAIEndpoint,
		paidConfirmationConfigured: typeof policy.confirmPaidRequest === "function",
		outsideWorkspaceAllowed: policy.allowOutsideWorkspace,
		sensitiveFilesAllowed: policy.allowSensitiveFiles,
		maxConcurrentWorkers: policy.maxConcurrentWorkers,
		activeDiagnosticsAllowed: policy.allowActiveDiagnostics,
		fingerprint: policy.fingerprint,
	};
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
