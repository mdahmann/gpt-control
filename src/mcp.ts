#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ProgressToken, Request, RequestId, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import type { CreateTaskOptions, CreateTaskRequestHandlerExtra, TaskRequestHandlerExtra, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import { z } from "zod";
import { fallbackExec } from "./host";
import { PACKAGE_VERSION, type RunKind, type RunRecord } from "./domain";
import { GptControlService, type StartRequest } from "./service";
import { DurableTaskStore } from "./task_store";

const TransportSchema = z.literal("browser");
const ChatGptModelSchema = z.literal("pro");
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ConnectorNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/);
const ConnectorModeSchema = z.enum(["prefer", "require"]);
const CommonSchema = {
	conversation_id: z.string().optional(),
	files: z.array(z.string()).max(32).optional(),
	transport: TransportSchema.optional(),
	chatgpt_model: ChatGptModelSchema.optional(),
	idempotency_key: IdempotencyKeySchema.optional(),
	wait: z.boolean().optional(),
	timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
};
const INPUT_REQUIRED_DELIVERY_GRACE_MS = 500;
const SUBAGENT_TASK_POLL_INTERVAL_MS = 100;
const SUBAGENT_ACTIVATION_GRACE_MS = 250;

const SubagentSchema = {
	prompt: z.string().min(1),
	files: z.array(z.string()).max(32).optional(),
	idempotency_key: IdempotencyKeySchema,
	connectors: z.array(ConnectorNameSchema).max(8).optional(),
	connector_mode: ConnectorModeSchema.optional(),
	timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
};

interface SubagentParams {
	prompt: string;
	files?: string[];
	idempotency_key: string;
	connectors?: string[];
	connector_mode?: "prefer" | "require";
	timeout_ms?: number;
}

export interface GptMcpOptions {
	service?: GptControlService;
	taskStore?: DurableTaskStore;
	/** Test and compatibility switch. The normal value is true. */
	taskSupport?: boolean;
	recover?: boolean;
}

export function createMcpServer(serviceOrOptions: GptControlService | GptMcpOptions = {}): McpServer {
	const options = serviceOrOptions instanceof GptControlService ? { service: serviceOrOptions } : serviceOrOptions;
	const service = options.service ?? new GptControlService(fallbackExec);
	const taskStore = options.taskStore ?? new DurableTaskStore(join(service.store.root, "mcp-tasks"), service.store);
	const tasksEnabled = options.taskSupport !== false;
	const monitors = new Map<string, Promise<void>>();
	const activationTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const protocolTaskStore = new ObservingTaskStore(taskStore, (taskId) => {
		scheduleTaskActivation(service, taskStore, monitors, activationTimers, taskId);
	});
	const server = new McpServer(
		{ name: "gpt-control", version: PACKAGE_VERSION },
		{
			taskStore: protocolTaskStore,
			defaultTaskPollInterval: 1000,
			capabilities: tasksEnabled ? {
				tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
			} : {},
		},
	);

	taskStore.setCancellationListener(async (_taskId, runId) => {
		if (runId) await service.cancelRun(runId);
	});
	const recoveryReady = options.recover === false
		? Promise.resolve()
		: resumeDurableSubagents(service, taskStore, monitors).catch((error) => {
			console.error(`GPT-Control task recovery failed: ${errorMessage(error)}`);
			throw error;
		});
	void recoveryReady.catch(() => undefined);

	registerCoreTools(server, service, taskStore);
	registerSubagentRecoveryTools(server, service, taskStore, monitors);
	registerSubagentRun(server, service, taskStore, monitors, activationTimers, tasksEnabled, recoveryReady);
	return server;
}

function registerCoreTools(server: McpServer, service: GptControlService, taskStore: DurableTaskStore): void {
	server.registerTool("gpt_consult", {
		description: "Request a bounded independent review. Attachment and provider authority come only from trusted operator policy.",
		inputSchema: { question: z.string().min(1), ...CommonSchema },
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params, extra) => {
		return startPayload(await service.start(toRequest(params, "consult", params.question), { mcpSessionId: extra.sessionId }));
	});

	server.registerTool("gpt_chat", {
		description: "Start or continue one provider conversation. Each submission receives a durable run id and truthful provenance.",
		inputSchema: { prompt: z.string().min(1), ...CommonSchema },
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params, extra) => {
		return startPayload(await service.start(toRequest(params, "chat", params.prompt), { mcpSessionId: extra.sessionId }));
	});

	server.registerTool("gpt_image", {
		description: "Generate an image in an owned ChatGPT conversation. Returns verified run provenance and provider artifact URLs; local writes remain policy-confined.",
		inputSchema: {
			prompt: z.string().min(1),
			conversation_id: z.string().optional(),
			files: z.array(z.string()).max(32).optional(),
			chatgpt_model: ChatGptModelSchema.optional(),
			idempotency_key: IdempotencyKeySchema.optional(),
			timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
		},
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params, extra) => {
		return startPayload(await service.start({
			kind: "image",
			prompt: params.prompt,
			files: params.files,
			conversationId: params.conversation_id,
			transport: "browser",
			chatgptModel: params.chatgpt_model,
			idempotencyKey: params.idempotency_key,
			timeoutMs: params.timeout_ms,
		}, { mcpSessionId: extra.sessionId }));
	});

	server.registerTool("gpt_run", {
		description: "Read one exact durable run. Internal polling never submits a prompt and is not required for task-based subagents.",
		inputSchema: { action: z.enum(["status", "wait", "result"]), run_id: z.string(), timeout_ms: z.number().int().positive().optional() },
		annotations: { readOnlyHint: true },
	}, async (params, extra) => {
		if (params.action === "wait") await service.waitForRun(params.run_id, params.timeout_ms);
		return withMcpRunAccess(service, taskStore, params.run_id, extra.sessionId, async () =>
			runPayload(await service.getRun(params.run_id)));
	});

	server.registerTool("gpt_run_cancel", {
		description: "Cancel one durable run. Terminal state is monotonic; late provider completion cannot overwrite cancellation.",
		inputSchema: { run_id: z.string() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params, extra) => {
		return withMcpRunAccess(service, taskStore, params.run_id, extra.sessionId, async () =>
			runPayload(await service.cancelRun(params.run_id)));
	});

	server.registerTool("gpt_run_abandon_pending", {
		description: "Operator-authenticated release of one unresolved provider-turn slot after manual review. Requires the trusted out-of-band token and exact confirmation ABANDON <run_id>.",
		inputSchema: { run_id: z.string(), confirmation: z.string(), operator_token: z.string().min(32) },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params, extra) => {
		return withMcpRunAccess(service, taskStore, params.run_id, extra.sessionId, async () =>
			runPayload(await service.abandonPendingProviderTurn(params.run_id, params.confirmation, params.operator_token)));
	});

	server.registerTool("gpt_run_claim", {
		description: "Operator-authenticated claim or transfer of the authoritative conversation owner for one durable run. Requires the trusted out-of-band token and exact confirmation CLAIM <run_id>.",
		inputSchema: { run_id: z.string(), confirmation: z.string(), operator_token: z.string().min(32) },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params, extra) => {
		if (!extra.sessionId) throw new Error("Resource claiming requires a stateful MCP session id.");
		const run = await service.claimMcpRun(
			params.run_id,
			extra.sessionId,
			params.confirmation,
			params.operator_token,
		);
		return toolPayload(
			`Claimed conversation ${run.conversationId} as the authoritative owner of run ${run.id} and its bound tasks for the current MCP session.`,
			publicRun(run),
		);
	});

	server.registerTool("gpt_conversation_close", {
		description: "Close one GPT-Control conversation locally. Provider-side history and uploads are not deleted.",
		inputSchema: { conversation_id: z.string() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params, extra) => {
		const conversation = await service.closeConversation(params.conversation_id, extra.sessionId);
		return toolPayload(`Closed ${conversation.id} locally. Provider-side data was not deleted.`, {
			conversationId: conversation.id,
			closedAt: conversation.closedAt,
		});
	});

	server.registerTool("gpt_diagnose", {
		description: "Passively report discovered transports and trusted policy. Does not execute a discovered driver, browser, legacy provider CLI, or model.",
		inputSchema: {},
		annotations: { readOnlyHint: true },
	}, async () => toolPayload("GPT-Control passive diagnosis.", await service.diagnose()));

	server.registerTool("gpt_diagnose_active", {
		description: "Run an explicitly operator-authorized active transport smoke test. Trusted policy must enable it.",
		inputSchema: {},
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async () => toolPayload("GPT-Control active smoke test.", await service.activeSmokeTest()));
}

function registerSubagentRun(
	server: McpServer,
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	activationTimers: Map<string, ReturnType<typeof setTimeout>>,
	taskSupport: boolean,
	recoveryReady: Promise<void>,
): void {
	const config = {
		title: "Run ChatGPT Pro worker",
		description: "Start one bounded ChatGPT Pro worker in its own owned browser conversation. Codex remains the orchestrator. Do not poll while the task result is pending.",
		inputSchema: SubagentSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		execution: { taskSupport: "optional" as const },
	};
	if (!taskSupport || typeof server.experimental.tasks.registerToolTask !== "function") {
		server.registerTool("gpt_subagent_run", {
			...config,
			description: `${config.description} This runtime lacks MCP task registration, so the call returns exactly once when terminal.`,
		}, async (params, extra) => {
			await recoveryReady;
			return startPayload(await service.start(subagentRequest(params, true), { mcpSessionId: extra.sessionId }));
		});
		return;
	}

	server.experimental.tasks.registerToolTask("gpt_subagent_run", config, {
		async createTask(params: SubagentParams, extra: CreateTaskRequestHandlerExtra) {
			await recoveryReady;
			const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl, pollInterval: SUBAGENT_TASK_POLL_INTERVAL_MS });
			let preparedRunId: string | undefined;
			const progressToken = readProgressToken(extra._meta?.progressToken);
			taskStore.setStatusListener(task.taskId, async (updated) => {
				await extra.sendNotification({ method: "notifications/tasks/status", params: updated });
			});
			const cancelOriginatingTask = () =>
				taskStore.updateTaskStatus(task.taskId, "cancelled", "Originating MCP request was cancelled.", extra.sessionId);
			extra.signal.addEventListener("abort", () => { void cancelOriginatingTask(); }, { once: true });
			// AbortSignal does not replay an event to a listener installed after the
			// signal was aborted. Register first, then check explicitly; duplicate
			// cancellation is monotonic and harmless if the event races this check.
			if (extra.signal.aborted) {
				await cancelOriginatingTask();
				taskStore.removeStatusListener(task.taskId);
				return { task };
			}
			await sendProgress(extra.sendNotification, progressToken, 0.05, "Creating owned Pro worker.");
			try {
				const started = await service.start(subagentRequest(params, false), { deferExecution: true, mcpSessionId: extra.sessionId });
				preparedRunId = started.run.id;
				if (started.run.mcpTaskId && started.run.mcpTaskId !== task.taskId) {
					throw new Error("This idempotent Pro worker is already owned by another durable MCP task.");
				}
				if (started.run.executionReady && !started.run.mcpTaskId) {
					throw new Error("This idempotent Pro worker was created outside MCP task ownership and cannot be adopted.");
				}
				await taskStore.bindRun(task.taskId, started.run.id);
				const currentTask = await taskStore.getTask(task.taskId, extra.sessionId);
				if (currentTask?.status === "cancelled") {
					await service.cancelRun(started.run.id);
				} else {
					// Bind and return taskCreated before provider work is eligible. A short
					// activation grace lets an immediate protocol cancellation durably seal
					// the run before any browser submission; no status polling is required.
					await taskStore.updateTaskStatus(task.taskId, "working", `Pro worker ${started.run.id} is prepared for activation after the cancellation grace.`);
					await sendProgress(extra.sendNotification, progressToken, 0.1, "Owned worker prepared; browser execution begins after taskCreated and the bounded cancellation grace.");
					scheduleTaskActivation(service, taskStore, monitors, activationTimers, task.taskId);
				}
			} catch (error) {
				const currentTask = await taskStore.getTask(task.taskId, extra.sessionId);
				if (currentTask?.status === "cancelled" && preparedRunId) {
					await service.cancelPreparedRunUnlessOwnedByAnotherTask(preparedRunId, task.taskId);
					taskStore.removeStatusListener(task.taskId);
					return { task };
				}
				await taskStore.storeTaskResult(task.taskId, "failed", toolPayload(`Pro worker could not start: ${errorMessage(error)}`, {
					taskId: task.taskId,
					status: "failed",
					reason: errorMessage(error),
				}, true));
				taskStore.removeStatusListener(task.taskId);
			}
			return { task };
		},
		async getTask(_params: SubagentParams, extra: TaskRequestHandlerExtra) {
			const task = await extra.taskStore.getTask(extra.taskId);
			if (!task) throw new Error(`Task ${extra.taskId} is not present in durable storage.`);
			return task;
		},
		async getTaskResult(_params: SubagentParams, extra: TaskRequestHandlerExtra) {
			return await extra.taskStore.getTaskResult(extra.taskId) as CallToolResult;
		},
	});
}

function registerSubagentRecoveryTools(
	server: McpServer,
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
): void {
	server.registerTool("gpt_subagent_get", {
		description: "Durable read-only lookup for one Pro worker by run id or MCP task id. Use after reconnect, not as a polling loop.",
		inputSchema: { run_id: z.string().optional(), task_id: z.string().optional() },
		annotations: { readOnlyHint: true },
	}, async (params, extra) => {
		const identity = requireOneIdentity(params.run_id, params.task_id);
		const taskId = identity.taskId ?? await taskStore.findTaskIdByRun(identity.runId!, extra.sessionId);
		if (identity.runId && extra.sessionId !== undefined && !taskId) {
			throw new Error("No Pro worker owned by this MCP session matched that run id.");
		}
		const runId = identity.runId ?? (taskId ? await taskStore.getRunId(taskId, extra.sessionId) : undefined);
		if (taskId) await activateTaskIfPending(service, taskStore, monitors, taskId);
		const task = taskId ? await taskStore.getTask(taskId, extra.sessionId) : null;
		const run = runId ? await service.getRun(runId) : undefined;
		if (!task && !run) throw new Error("No durable Pro worker matched that identity.");
		return toolPayload(run ? runText(run) : `Task ${taskId}: ${task?.status}.`, {
			task: task ? publicTask(task) : undefined,
			run: run ? publicRun(run) : undefined,
		});
	});

	server.registerTool("gpt_subagent_cancel", {
		description: "Cancel one Pro worker independently by run id or MCP task id. Late completion cannot overwrite cancellation.",
		inputSchema: { run_id: z.string().optional(), task_id: z.string().optional() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params, extra) => {
		const identity = requireOneIdentity(params.run_id, params.task_id);
		const taskId = identity.taskId ?? await taskStore.findTaskIdByRun(identity.runId!, extra.sessionId);
		if (identity.runId && extra.sessionId !== undefined && !taskId) {
			throw new Error("No Pro worker owned by this MCP session matched that run id.");
		}
		if (taskId) {
			const runId = identity.runId ?? await taskStore.getRunId(taskId, extra.sessionId);
			await taskStore.updateTaskStatus(taskId, "cancelled", "Cancelled through gpt_subagent_cancel.", extra.sessionId);
			// Keep the tool's provider-Stop guarantee explicit. The task-store listener
			// also routes protocol tasks/cancel here; cancelRun is durable and idempotent.
			const run = runId ? await service.cancelRun(runId) : undefined;
			return toolPayload(`Pro worker ${taskId} is cancelled.`, { taskId, run: run ? publicRun(run) : undefined });
		}
		if (!identity.runId) throw new Error("No run id was available to cancel.");
		return runPayload(await service.cancelRun(identity.runId));
	});

	server.registerTool("gpt_subagent_list", {
		description: "Bounded overview of active Pro workers. This is a recovery aid, not a polling requirement.",
		inputSchema: { limit: z.number().int().positive().max(100).optional(), include_terminal: z.boolean().optional() },
		annotations: { readOnlyHint: true },
	}, async (params, extra) => {
		const limit = params.limit ?? 20;
		const bindings = await taskStore.listBindings(100, extra.sessionId);
		const rows: Array<Record<string, unknown>> = [];
		for (const binding of bindings.sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt))) {
			if (!params.include_terminal && ["completed", "failed", "cancelled"].includes(binding.task.status)) continue;
			const run = binding.runId ? await service.getRun(binding.runId).catch(() => undefined) : undefined;
			rows.push({ task: publicTask(binding.task), run: run ? publicRun(run) : undefined });
			if (rows.length >= limit) break;
		}
		return toolPayload(`${rows.length} Pro worker${rows.length === 1 ? "" : "s"}.`, { workers: rows });
	});
}

class ObservingTaskStore implements TaskStore {
	constructor(
		private readonly delegate: DurableTaskStore,
		private readonly onObserve: (taskId: string) => void,
	) {}

	createTask(options: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task> {
		return this.delegate.createTask(options, requestId, request, sessionId);
	}

	async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
		const task = await this.delegate.getTask(taskId, sessionId);
		if (task) this.onObserve(taskId);
		return task;
	}

	storeTaskResult(taskId: string, status: "completed" | "failed", result: Result, sessionId?: string): Promise<void> {
		return this.delegate.storeTaskResult(taskId, status, result, sessionId);
	}

	async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
		const task = await this.delegate.getTask(taskId, sessionId);
		if (!task) throw new Error(`Task ${taskId} is not present in this MCP session.`);
		this.onObserve(taskId);
		return this.delegate.getTaskResult(taskId, sessionId);
	}

	updateTaskStatus(taskId: string, status: Task["status"], statusMessage?: string, sessionId?: string): Promise<void> {
		return this.delegate.updateTaskStatus(taskId, status, statusMessage, sessionId);
	}

	listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
		return this.delegate.listTasks(cursor, sessionId);
	}
}

function scheduleTaskActivation(
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	timers: Map<string, ReturnType<typeof setTimeout>>,
	taskId: string,
): void {
	if (timers.has(taskId) || monitors.has(taskId)) return;
	const timer = setTimeout(() => {
		timers.delete(taskId);
		void activateTaskIfPending(service, taskStore, monitors, taskId).catch(async (error) => {
			await taskStore.storeTaskResult(taskId, "failed", toolPayload(`Pro worker activation failed: ${errorMessage(error)}`, {
				taskId, status: "failed", reason: errorMessage(error),
			}, true)).catch(() => undefined);
		});
	}, SUBAGENT_ACTIVATION_GRACE_MS);
	timer.unref();
	timers.set(taskId, timer);
}

async function activateTaskIfPending(
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	taskId: string,
): Promise<void> {
	const task = await taskStore.getTask(taskId);
	if (!task || task.status !== "working") return;
	const runId = await taskStore.getRunId(taskId);
	if (!runId) return;
	const run = await service.getRun(runId);
	if (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "needs_user") {
		startTaskMonitor(service, taskStore, monitors, taskId, runId);
		return;
	}
	const currentTask = await taskStore.getTask(taskId);
	if (!currentTask || currentTask.status !== "working") return;
	await service.schedulePreparedRun(runId);
	const afterSchedule = await taskStore.getTask(taskId);
	if (!afterSchedule || afterSchedule.status !== "working") {
		await service.cancelRun(runId);
		return;
	}
	await taskStore.updateTaskStatus(taskId, "working", `Pro worker ${runId} is running in an owned browser conversation.`);
	startTaskMonitor(service, taskStore, monitors, taskId, runId);
}

function startTaskMonitor(
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	taskId: string,
	runId: string,
	emitProgress?: (progress: number, message: string) => Promise<void>,
): Promise<void> {
	const existing = monitors.get(taskId);
	if (existing) return existing;
	const monitor = monitorTask(service, taskStore, taskId, runId, emitProgress)
		.catch(async (error) => {
			await taskStore.storeTaskResult(taskId, "failed", toolPayload(`Pro worker monitor failed: ${errorMessage(error)}`, {
				taskId,
				runId,
				status: "failed",
				reason: errorMessage(error),
			}, true)).catch(() => undefined);
		})
		.finally(() => {
			taskStore.removeStatusListener(taskId);
			monitors.delete(taskId);
		});
	monitors.set(taskId, monitor);
	return monitor;
}

async function monitorTask(
	service: GptControlService,
	taskStore: DurableTaskStore,
	taskId: string,
	runId: string,
	emitProgress?: (progress: number, message: string) => Promise<void>,
): Promise<void> {
	const initial = await service.getRun(runId);
	await emitProgress?.(0.45, "Watching the owned ChatGPT conversation without resubmitting or model-visible polling.");
	let run = await service.waitForRun(runId, (initial.timeoutMs ?? 600_000) + 120_000);
	if (run.status === "queued" || run.status === "running") {
		run = await service.markNeedsUser(runId, "The Pro worker exceeded its bounded monitor deadline. The owned browser conversation and conversation identity were retained; the prompt was not resent.");
	}
	const task = await taskStore.getTask(taskId);
	if (task?.status === "cancelled") return;
	if (run.status === "completed") {
		await emitProgress?.(1, "Stable final assistant turn verified.");
		await taskStore.storeTaskResult(taskId, "completed", subagentResult(taskId, run));
		return;
	}
	if (run.status === "needs_user") {
		await taskStore.updateTaskStatus(taskId, "input_required", run.error ?? "The Pro worker requires operator input.");
		await emitProgress?.(0.95, "Pro worker needs operator input; delivering one terminal blocker result.");
		// MCP input_required is intentionally non-terminal. Keep it observable for
		// several declared poll intervals, then seal the task with one blocker result.
		await delay(INPUT_REQUIRED_DELIVERY_GRACE_MS);
		const current = await taskStore.getTask(taskId);
		if (current?.status === "cancelled") return;
		await taskStore.storeTaskResult(taskId, "failed", subagentResult(taskId, run, "input_required"));
		return;
	}
	if (run.status === "cancelled") {
		await taskStore.updateTaskStatus(taskId, "cancelled", run.error ?? "Pro worker was cancelled.");
		return;
	}
	await taskStore.storeTaskResult(taskId, "failed", subagentResult(taskId, run));
}

export async function resumeDurableSubagents(
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors = new Map<string, Promise<void>>(),
): Promise<void> {
	await taskStore.init();
	const stopRecovery = await service.retryRequestedProviderStops();
	if (stopRecovery.blocked.length > 0) {
		console.error(`GPT-Control could not recheck ${stopRecovery.blocked.length} cancelled provider turn(s); a later restart will retry.`);
	}
	let bindings = await taskStore.listBindings();
	const claimedRuns = new Map(
		(await service.store.listRuns({ limit: null }))
			.filter((run) => run.mcpTaskId)
			.map((run) => [run.mcpTaskId!, run]),
	);
	for (const binding of bindings) {
		if (binding.runId) continue;
		const claimed = claimedRuns.get(binding.task.taskId);
		if (!claimed) continue;
		if (["completed", "failed", "cancelled"].includes(binding.task.status)) {
			if (claimed.status !== "completed" && claimed.status !== "failed") {
				await service.cancelRun(claimed.id);
			}
			continue;
		}
		await taskStore.bindRun(binding.task.taskId, claimed.id);
	}
	bindings = await taskStore.listBindings();
	// Reconcile durable task authority before recovering runnable work. This also
	// repairs records written by older builds that persisted task cancellation
	// before run cancellation and then crashed between those writes.
	for (const binding of bindings) {
		if (!binding.runId || !["completed", "failed", "cancelled"].includes(binding.task.status)) continue;
		const run = await service.getRun(binding.runId);
		if (run.status === "queued" || run.status === "running" || run.status === "cancelled") await service.cancelRun(binding.runId);
	}
	await service.recoverActiveRuns();
	for (const binding of bindings) {
		if (["completed", "failed", "cancelled"].includes(binding.task.status)) continue;
		const runId = binding.runId;
		if (!runId) {
			await taskStore.storeTaskResult(binding.task.taskId, "failed", toolPayload("Pro worker task has no durable run binding; no prompt was resubmitted.", {
				taskId: binding.task.taskId,
				status: "failed",
				reason: "missing durable run binding",
			}, true));
			continue;
		}
		await service.schedulePreparedRun(runId);
		startTaskMonitor(service, taskStore, monitors, binding.task.taskId, runId);
	}
}

function subagentRequest(params: SubagentParams, wait: boolean): StartRequest {
	return {
		kind: "subagent",
		prompt: params.prompt,
		files: params.files,
		transport: "browser",
		chatgptModel: "pro",
		idempotencyKey: params.idempotency_key,
		connectors: params.connectors,
		connectorMode: params.connector_mode,
		wait,
		timeoutMs: params.timeout_ms,
	};
}

function toRequest(params: Record<string, unknown>, kind: Exclude<RunKind, "subagent" | "image">, prompt: string): StartRequest {
	return {
		kind,
		prompt,
		files: params.files as string[] | undefined,
		conversationId: params.conversation_id as string | undefined,
		transport: params.transport as StartRequest["transport"],
		chatgptModel: params.chatgpt_model as StartRequest["chatgptModel"],
		idempotencyKey: params.idempotency_key as string | undefined,
		wait: params.wait !== false,
		timeoutMs: params.timeout_ms as number | undefined,
	};
}

function startPayload(value: Awaited<ReturnType<GptControlService["start"]>>): CallToolResult {
	return toolPayload(runText(value.run), {
		conversationId: value.conversation.id,
		run: publicRun(value.run),
	}, value.run.status === "failed" || value.run.status === "needs_user");
}

function runPayload(run: RunRecord): CallToolResult {
	return toolPayload(runText(run), publicRun(run), run.status === "failed" || run.status === "needs_user");
}

function subagentResult(taskId: string, run: RunRecord, workerStatus?: string): CallToolResult {
	return toolPayload(runText(run), {
		taskId,
		workerStatus: workerStatus ?? run.status,
		run: publicRun(run),
	}, run.status !== "completed");
}

function publicRun(run: RunRecord): Record<string, unknown> {
	return {
		runId: run.id,
		conversationId: run.conversationId,
		kind: run.kind,
		status: run.status,
		providerTurnPending: run.providerTurnPending,
		providerStopRequested: run.providerStopRequested,
		providerTurnAbandonedAt: run.providerTurnAbandonedAt,
		connectorIntent: run.connectorIntent,
		connectorVerification: run.connectorIntent ? {
			status: "unverified",
			evidenceKind: "provider_prompt_intent_only",
			note: "GPT-Control cannot observe ChatGPT connector tool calls. Verify required connector results independently before accepting the worker output.",
		} : undefined,
		providerRunId: run.providerRunId,
		resultText: run.resultText,
		report: run.result,
		artifacts: run.artifactUrls,
		error: run.error,
		diagnostics: run.diagnostics,
		receipt: {
			...run.receipt,
			attachments: run.receipt.attachments.map(publicAttachment),
		},
		manifest: {
			files: run.attachmentManifest.files.map(publicAttachment),
			totalBytes: run.attachmentManifest.totalBytes,
			sha256: run.attachmentManifest.sha256,
			snapshotId: run.attachmentManifest.snapshotId,
		},
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		completedAt: run.completedAt,
	};
}

function publicAttachment(file: { relativePath: string; size: number; sha256: string; lineCount?: number }): Record<string, unknown> {
	return { relativePath: file.relativePath, size: file.size, sha256: file.sha256, lineCount: file.lineCount };
}

function publicTask(task: Task): Record<string, unknown> {
	return {
		taskId: task.taskId,
		status: task.status,
		createdAt: task.createdAt,
		lastUpdatedAt: task.lastUpdatedAt,
		statusMessage: task.statusMessage,
		pollInterval: task.pollInterval,
	};
}

function runText(run: RunRecord): string {
	if (run.status === "completed") return run.resultText ?? "Pro worker completed without text.";
	if (run.status === "failed" || run.status === "cancelled" || run.status === "needs_user") return run.error ?? run.status;
	return `Run ${run.id} is ${run.status}.`;
}

function toolPayload(text: string, structured: unknown, isError = false): CallToolResult {
	return {
		content: [{ type: "text", text }],
		structuredContent: structured as Record<string, unknown>,
		...(isError ? { isError: true } : {}),
	};
}

function requireOneIdentity(runId?: string, taskId?: string): { runId?: string; taskId?: string } {
	if (Boolean(runId) === Boolean(taskId)) throw new Error("Provide exactly one of run_id or task_id.");
	return { runId, taskId };
}

async function withMcpRunAccess<T>(
	service: GptControlService,
	taskStore: DurableTaskStore,
	runId: string,
	sessionId: string | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	if (sessionId === undefined) return operation();
	const initial = await service.getRun(runId);
	const legacyTaskOwned = initial.kind === "subagent"
		&& await taskStore.legacySessionOwnsRun(runId, sessionId);
	return service.store.withConversationOwnershipLock(initial.conversationId, async () => {
		const run = await service.getRun(runId);
		if (run.conversationId !== initial.conversationId) throw new Error("Durable run conversation identity changed.");
		const conversation = await service.store.getConversation(run.conversationId);
		if (conversation.mcpSessionId !== sessionId && !(conversation.mcpSessionId === undefined && legacyTaskOwned)) {
			throw new Error("No GPT-Control run owned by this MCP session matched that run id.");
		}
		return operation();
	});
}

function readProgressToken(value: unknown): ProgressToken | undefined {
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

async function sendProgress(
	sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: ProgressToken; progress: number; total?: number; message?: string } }) => Promise<void>,
	progressToken: ProgressToken | undefined,
	progress: number,
	message: string,
): Promise<void> {
	if (progressToken === undefined) return;
	try {
		await sendNotification({ method: "notifications/progress", params: { progressToken, progress, total: 1, message } });
	} catch {
		// Progress is advisory. Durable task state remains authoritative.
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
	const entry = process.argv[1];
	return typeof entry === "string" && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
	const service = new GptControlService(fallbackExec);
	const server = createMcpServer({ service });
	await server.connect(new StdioServerTransport());
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			await service.suspendActiveRunsForRestart();
			await server.close();
		} catch (error) {
			console.error(`GPT-Control shutdown after ${signal} failed: ${errorMessage(error)}`);
			process.exitCode = 1;
		}
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
