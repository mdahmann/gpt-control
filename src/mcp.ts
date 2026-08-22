#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
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
import type { Exec } from "./types";
import { findOnPath } from "./transport";

const TransportSchema = z.literal("browser");
const ChatGptModelSchema = z.string().min(1).max(128);
const ChatGptEffortSchema = z.string().min(1).max(64);
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ConnectorNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/);
const ConnectorModeSchema = z.enum(["prefer", "require"]);
const CodexThreadIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
const CommonSchema = {
	conversation_id: z.string().optional(),
	files: z.array(z.string()).max(32).optional(),
	transport: TransportSchema.optional(),
	chatgpt_model: ChatGptModelSchema.optional(),
	chatgpt_effort: ChatGptEffortSchema.optional(),
	pin_chat: z.boolean().optional(),
	idempotency_key: IdempotencyKeySchema.optional(),
	wait: z.boolean().optional(),
	timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
};
const INPUT_REQUIRED_DELIVERY_GRACE_MS = 500;
const SUBAGENT_TASK_POLL_INTERVAL_MS = 100;
const SUBAGENT_ACTIVATION_GRACE_MS = 250;

const SubagentSchema = {
	prompt: z.string().min(1),
	title: z.string().min(1).max(128).optional(),
	project_id: z.string().min(1).max(16).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
	files: z.array(z.string()).max(32).optional(),
	idempotency_key: IdempotencyKeySchema,
	chatgpt_model: ChatGptModelSchema.optional(),
	chatgpt_effort: ChatGptEffortSchema.optional(),
	connectors: z.array(ConnectorNameSchema).max(8).optional(),
	connector_mode: ConnectorModeSchema.optional(),
	timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
};

interface SubagentParams {
	prompt: string;
	title?: string;
	project_id?: string;
	files?: string[];
	idempotency_key: string;
	chatgpt_model?: string;
	chatgpt_effort?: string;
	connectors?: string[];
	connector_mode?: "prefer" | "require";
	timeout_ms?: number;
}

interface BackgroundWorkerParams extends SubagentParams {
	callback_thread_id?: string;
}

export interface GptMcpOptions {
	service?: GptControlService;
	taskStore?: DurableTaskStore;
	/** Test and compatibility switch. The normal value is true. */
	taskSupport?: boolean;
	recover?: boolean;
	codexCallback?: false | CodexCallbackOptions;
}

export interface CodexCallbackOptions {
	/** Optional runtime default. MCP servers are not guaranteed to receive a per-thread value. */
	threadId?: string;
	/** Trusted executable selected by the operator/runtime. */
	command: string;
	exec: Exec;
	delayMs?: number;
}

export function codexCallbackOptionsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	exec: Exec = fallbackExec,
): false | CodexCallbackOptions {
	const requestedThreadId = env.CODEX_THREAD_ID?.trim();
	const threadId = requestedThreadId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestedThreadId)
		? requestedThreadId
		: undefined;
	if (requestedThreadId && !threadId) {
		console.error("GPT-Control ignored an invalid default CODEX_THREAD_ID; explicit per-launch callback routing remains available.");
	}
	const requestedCommand = env.GPT_CONTROL_CODEX_CLI?.trim() || "codex";
	const command = findOnPath(requestedCommand, env);
	if (!command) {
		console.error(`GPT-Control parent callbacks are disabled because the trusted Codex CLI was not found: ${requestedCommand}`);
		return false;
	}
	return { threadId: threadId || undefined, command, exec };
}

class CodexCallbackCoordinator {
	private timer?: ReturnType<typeof setTimeout>;
	private readonly pendingThreadIds = new Set<string>();

	constructor(
		private readonly options: CodexCallbackOptions,
		private readonly taskStore: DurableTaskStore,
	) {
		if (options.threadId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.threadId)) {
			throw new Error("Trusted CODEX_THREAD_ID must be a UUID before parent callbacks can be enabled.");
		}
		if (options.command.trim() === "") throw new Error("Trusted Codex callback command is empty.");
	}

	async register(taskId: string, requestedThreadId?: string): Promise<boolean> {
		const threadId = requestedThreadId ?? this.options.threadId;
		if (!threadId) return false;
		if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(threadId)) {
			throw new Error("Codex callback thread id must be a UUID.");
		}
		try {
			await this.taskStore.bindCodexParent(taskId, threadId);
			return true;
		} catch (error) {
			console.error(`GPT-Control could not bind parent callback for ${taskId}: ${callbackErrorDetail(errorMessage(error))}`);
			throw error;
		}
	}

	async recover(): Promise<void> {
		try {
			for (const threadId of await this.taskStore.listCodexParentThreadIds()) {
				if (await this.taskStore.reconcileCodexCallbacks(threadId) > 0) this.schedule(threadId);
			}
		} catch (error) {
			console.error(`GPT-Control could not recover parent callbacks: ${callbackErrorDetail(errorMessage(error))}`);
		}
	}

	async queue(taskId: string, runId: string | undefined, status: "completed" | "failed" | "cancelled" | "needs_user"): Promise<void> {
		try {
			if (!await this.taskStore.stageCodexCallback(taskId, runId, status)) return;
			const callback = await this.taskStore.getCodexParent(taskId);
			if (callback) this.schedule(callback.threadId);
		} catch (error) {
			console.error(`GPT-Control could not stage parent callback for ${taskId}: ${callbackErrorDetail(errorMessage(error))}`);
		}
	}

	private schedule(threadId: string): void {
		this.pendingThreadIds.add(threadId);
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush().catch((error) => {
				console.error(`GPT-Control parent callback flush failed: ${callbackErrorDetail(errorMessage(error))}`);
			});
		}, Math.max(0, this.options.delayMs ?? 250));
		this.timer.unref?.();
	}

	private async flush(): Promise<void> {
		const threadIds = [...this.pendingThreadIds];
		this.pendingThreadIds.clear();
		for (const threadId of threadIds) await this.flushThread(threadId);
		if (this.pendingThreadIds.size > 0) this.schedule(this.pendingThreadIds.values().next().value!);
	}

	private async flushThread(threadId: string): Promise<void> {
		const receipts = await this.taskStore.claimPendingCodexCallbacks(threadId);
		if (receipts.length === 0) return;
		const noun = receipts.length === 1 ? "worker" : "workers";
		const identities = receipts.map((receipt) =>
			`${receipt.taskId}${receipt.runId ? ` (${receipt.runId})` : ""}: ${receipt.status}`,
		).join(", ");
		const message = `${receipts.length === 1 ? "A" : receipts.length} GPT ${noun} finished. `
			+ `Collect the durable ${receipts.length === 1 ? "result" : "results"} with gpt_worker_get and update the user. ${identities}`;
		let result;
		try {
			result = await this.options.exec(this.options.command, [
				"queue", "--thread", threadId, "--message", message,
			], { timeout: 30_000 });
		} catch (error) {
			const detail = callbackErrorDetail(errorMessage(error));
			await this.taskStore.finishCodexCallbacks(receipts.map((receipt) => receipt.taskId), false, detail);
			console.error(`GPT-Control could not queue a parent completion receipt: ${detail}`);
			return;
		}
		const delivered = result.code === 0 && !result.killed;
		const detail = delivered ? undefined : callbackErrorDetail(result.stderr || `exit ${result.code}`);
		await this.taskStore.finishCodexCallbacks(receipts.map((receipt) => receipt.taskId), delivered, detail);
		if (!delivered) console.error(`GPT-Control could not queue a parent completion receipt: ${detail}`);
	}
}

export function createMcpServer(serviceOrOptions: GptControlService | GptMcpOptions = {}): McpServer {
	const options = serviceOrOptions instanceof GptControlService ? { service: serviceOrOptions } : serviceOrOptions;
	const service = options.service ?? new GptControlService(fallbackExec);
	const taskStore = options.taskStore ?? new DurableTaskStore(join(service.store.root, "mcp-tasks"), service.store);
	const tasksEnabled = options.taskSupport !== false;
	const codexCallback = options.codexCallback ? new CodexCallbackCoordinator(options.codexCallback, taskStore) : undefined;
	const monitors = new Map<string, Promise<void>>();
	const activationTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const protocolTaskStore = new ObservingTaskStore(taskStore, (taskId) => {
		scheduleTaskActivation(service, taskStore, monitors, activationTimers, taskId, codexCallback);
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
		: resumeDurableSubagents(service, taskStore, monitors, codexCallback).then(async () => {
			await codexCallback?.recover();
		}).catch((error) => {
			console.error(`GPT-Control task recovery failed: ${errorMessage(error)}`);
			throw error;
		});
	void recoveryReady.catch(() => undefined);

	registerCoreTools(server, service, taskStore);
	registerWorkerRecoveryTools(server, service, taskStore, monitors, codexCallback);
	registerWorkerRun(server, service, taskStore, monitors, activationTimers, tasksEnabled, recoveryReady, codexCallback);
	registerBackgroundWorkerTools(server, service, taskStore, monitors, activationTimers, recoveryReady, codexCallback);
	return server;
}

function registerCoreTools(server: McpServer, service: GptControlService, taskStore: DurableTaskStore): void {
	server.registerTool("gpt_models", {
		description: "Read the currently available ChatGPT model and effort choices from the live picker. No prompt is sent and the temporary owned tab is closed.",
		inputSchema: {},
		annotations: { readOnlyHint: true },
	}, async () => toolPayload("Live ChatGPT model catalog.", await service.listModels()));
	server.registerTool("gpt_projects", {
		description: "Read the currently available ChatGPT project names from the live sidebar. No prompt is sent and the temporary owned tab is closed.",
		inputSchema: {},
		annotations: { readOnlyHint: true },
	}, async () => toolPayload("Live ChatGPT project catalog.", await service.listProjects()));

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
			chatgpt_effort: ChatGptEffortSchema.optional(),
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
			chatgptEffort: params.chatgpt_effort,
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

	server.registerTool("gpt_conversation_attach", {
		description: "Attach an exact existing https://chatgpt.com/c/<id> conversation in a new GPT-Control-owned background tab. Does not send a message or adopt a foreground tab.",
		inputSchema: {
			conversation_url: z.string().optional(),
			provider_conversation_id: z.string().optional(),
			timeout_ms: z.number().int().positive().max(60_000).optional(),
		},
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params, extra) => {
		const conversation = await service.attachConversation({
			conversationUrl: params.conversation_url,
			providerConversationId: params.provider_conversation_id,
			timeoutMs: params.timeout_ms,
		}, extra.sessionId);
		return toolPayload(`Attached existing ChatGPT conversation ${conversation.providerConversationId}.`, {
			conversationId: conversation.id,
			providerConversationId: conversation.providerConversationId,
			providerConversationUrl: conversation.providerConversationUrl,
			localAssistantTurnCount: conversation.browserAssistantTurnCount,
		});
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

	server.registerTool("gpt_conversation_manage", {
		description: "Pin, unpin, rename, move, or archive one exact GPT-Control-owned ChatGPT conversation with live read-back. Archive also closes the local owned tab.",
		inputSchema: {
			conversation_id: z.string(),
			action: z.enum(["pin", "unpin", "rename", "move", "archive"]),
			title: z.string().min(1).max(128).optional(),
			project: z.string().min(1).max(128).optional(),
		},
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params, extra) => {
		const operation = params.action === "rename"
			? { action: "rename" as const, title: params.title ?? "" }
			: params.action === "move"
				? { action: "move" as const, project: params.project ?? "" }
				: { action: params.action } as const;
		const result = await service.manageConversation(params.conversation_id, operation, extra.sessionId);
		return toolPayload(`ChatGPT conversation ${params.conversation_id} ${params.action} verified.`, {
			conversationId: params.conversation_id,
			action: params.action,
			...result,
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

function registerWorkerRun(
	server: McpServer,
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	activationTimers: Map<string, ReturnType<typeof setTimeout>>,
	taskSupport: boolean,
	recoveryReady: Promise<void>,
	codexCallback?: CodexCallbackCoordinator,
): void {
	const config = {
		title: "Run GPT Worker",
		description: "Start one bounded GPT Worker in its own owned browser conversation. The live model and effort can be selected for each worker. Do not poll while the task result is pending.",
		inputSchema: SubagentSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		execution: { taskSupport: "optional" as const },
	};
	if (!taskSupport || typeof server.experimental.tasks.registerToolTask !== "function") {
		server.registerTool("gpt_worker_run", {
			...config,
			description: `${config.description} This runtime lacks MCP task registration, so the call returns exactly once when terminal.`,
		}, async (params, extra) => {
			await recoveryReady;
			return startPayload(await service.start(subagentRequest(params, true), { mcpSessionId: extra.sessionId }));
		});
		return;
	}

	server.experimental.tasks.registerToolTask("gpt_worker_run", config, {
		async createTask(params: SubagentParams, extra: CreateTaskRequestHandlerExtra) {
			await recoveryReady;
			const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl, pollInterval: SUBAGENT_TASK_POLL_INTERVAL_MS });
			await codexCallback?.register(task.taskId);
			let preparedRunId: string | undefined;
			const progressToken = readProgressToken(extra._meta?.progressToken);
			taskStore.setStatusListener(task.taskId, async (updated) => {
				await extra.sendNotification({ method: "notifications/tasks/status", params: updated });
			});
			// The tool request is only the durable worker's originating caller.
			// Cancelling or interrupting that request detaches the caller; it does
			// not cancel the task. Only tasks/cancel or gpt_worker_cancel can make
			// the durable worker terminal and request a provider Stop.
			await sendProgress(extra.sendNotification, progressToken, 0.05, "Creating owned GPT Worker.");
			try {
				const started = await service.start(subagentRequest(params, false), { deferExecution: true, mcpSessionId: extra.sessionId });
				preparedRunId = started.run.id;
				if (started.run.mcpTaskId && started.run.mcpTaskId !== task.taskId) {
					throw new Error("This idempotent GPT Worker is already owned by another durable MCP task.");
				}
				if (started.run.executionReady && !started.run.mcpTaskId) {
					throw new Error("This idempotent GPT Worker was created outside MCP task ownership and cannot be adopted.");
				}
				await taskStore.bindRun(task.taskId, started.run.id);
				const currentTask = await taskStore.getTask(task.taskId, extra.sessionId);
				if (currentTask?.status === "cancelled") {
					await service.cancelRun(started.run.id);
				} else {
					// Bind and return taskCreated before provider work is eligible. A short
					// activation grace lets an immediate protocol cancellation durably seal
					// the run before any browser submission; no status polling is required.
					await taskStore.updateTaskStatus(task.taskId, "working", `GPT Worker ${started.run.id} is prepared for activation after the cancellation grace.`);
					await sendProgress(extra.sendNotification, progressToken, 0.1, "Owned worker prepared; browser execution begins after taskCreated and the bounded cancellation grace.");
					scheduleTaskActivation(service, taskStore, monitors, activationTimers, task.taskId, codexCallback);
				}
			} catch (error) {
				const currentTask = await taskStore.getTask(task.taskId, extra.sessionId);
				if (currentTask?.status === "cancelled" && preparedRunId) {
					await service.cancelPreparedRunUnlessOwnedByAnotherTask(preparedRunId, task.taskId);
					taskStore.removeStatusListener(task.taskId);
					return { task };
				}
				await taskStore.storeTaskResult(task.taskId, "failed", toolPayload(`GPT Worker could not start: ${errorMessage(error)}`, {
					taskId: task.taskId,
					status: "failed",
					reason: errorMessage(error),
				}, true));
				await codexCallback?.queue(task.taskId, preparedRunId, "failed");
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

function registerBackgroundWorkerTools(
	server: McpServer,
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	activationTimers: Map<string, ReturnType<typeof setTimeout>>,
	recoveryReady: Promise<void>,
	codexCallback?: CodexCallbackCoordinator,
): void {
	const workerSchema = {
		...SubagentSchema,
		callback_thread_id: CodexThreadIdSchema.optional(),
	};
	server.registerTool("gpt_worker_start", {
		title: "Start GPT Worker",
		description: "Start one durable GPT Worker and return its task and run handles immediately. This ordinary tool does not wait for the ChatGPT result. Pass callback_thread_id from the current Codex shell's CODEX_THREAD_ID when the parent should receive one fixed completion receipt.",
		inputSchema: workerSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	}, async (params, extra) => {
		await recoveryReady;
		const started = await prepareBackgroundWorker(
			service, taskStore, monitors, activationTimers, params, extra.sessionId, codexCallback, "gpt_worker_start",
		);
		return backgroundStartPayload(started);
	});

	server.registerTool("gpt_worker_start_many", {
		title: "Start GPT Workers",
		description: "Prepare and start one through ten independent durable GPT Workers, then return every task and run handle immediately. The jobs share one optional Codex completion callback target and continue without keeping the parent turn open.",
		inputSchema: {
			workers: z.array(z.object(SubagentSchema)).min(1).max(10),
			callback_thread_id: CodexThreadIdSchema.optional(),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
	}, async (params, extra) => {
		await recoveryReady;
		const starts = [];
		for (const worker of params.workers) {
			starts.push(await prepareBackgroundWorker(
				service,
				taskStore,
				monitors,
				activationTimers,
				{ ...worker, callback_thread_id: params.callback_thread_id },
				extra.sessionId,
				codexCallback,
				"gpt_worker_start_many",
			));
		}
		return toolPayload(
			`Started ${starts.length} durable GPT Worker${starts.length === 1 ? "" : "s"}; the parent may yield immediately.`,
			{ workers: starts.map(publicBackgroundStart), callbackBound: starts.every((start) => start.callbackBound) },
			starts.some((start) => start.error !== undefined),
		);
	});
}

interface BackgroundStart {
	task?: Task;
	run?: RunRecord;
	callbackBound: boolean;
	callback?: Awaited<ReturnType<DurableTaskStore["getCodexParent"]>>;
	error?: string;
}

async function prepareBackgroundWorker(
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	activationTimers: Map<string, ReturnType<typeof setTimeout>>,
	params: BackgroundWorkerParams,
	sessionId: string | undefined,
	codexCallback: CodexCallbackCoordinator | undefined,
	toolName: "gpt_worker_start" | "gpt_worker_start_many",
): Promise<BackgroundStart> {
	if (params.callback_thread_id && !codexCallback) {
		throw new Error("Codex completion callback was requested, but the trusted Codex queue command is unavailable.");
	}
	let task: Task | undefined;
	let run: RunRecord | undefined;
	let callbackBound = false;
	try {
		const started = await service.start(subagentRequest(params, false), { deferExecution: true, mcpSessionId: sessionId });
		run = started.run;
		if (run.mcpTaskId) {
			const existingTask = await taskStore.getTask(run.mcpTaskId, sessionId);
			if (!existingTask) throw new Error("This idempotent GPT Worker is already owned by another MCP session.");
			const callback = await taskStore.getCodexParent(existingTask.taskId, sessionId);
			return { task: existingTask, run, callbackBound: callback !== undefined, callback };
		}
		const request = {
			method: "tools/call",
			params: { name: toolName, arguments: params },
		} as Request;
		task = await taskStore.createTask(
			{ ttl: null, pollInterval: SUBAGENT_TASK_POLL_INTERVAL_MS },
			randomUUID(),
			request,
			sessionId,
		);
		await taskStore.bindRun(task.taskId, run.id);
		callbackBound = await codexCallback?.register(task.taskId, params.callback_thread_id) ?? false;
		await taskStore.updateTaskStatus(task.taskId, "working", `GPT Worker ${run.id} is prepared for background activation.`);
		scheduleTaskActivation(service, taskStore, monitors, activationTimers, task.taskId, codexCallback);
		return {
			task: await taskStore.getTask(task.taskId, sessionId) ?? task,
			run: await service.getRun(run.id),
			callbackBound,
			callback: await taskStore.getCodexParent(task.taskId, sessionId),
		};
	} catch (error) {
		const reason = errorMessage(error);
		if (task) {
			await taskStore.storeTaskResult(task.taskId, "failed", toolPayload(`GPT Worker could not start: ${reason}`, {
				taskId: task.taskId,
				runId: run?.id,
				status: "failed",
				reason,
			}, true), sessionId).catch(() => undefined);
			await codexCallback?.queue(task.taskId, run?.id, "failed");
		}
		if (run) {
			if (task) await service.cancelPreparedRunUnlessOwnedByAnotherTask(run.id, task.taskId).catch(() => undefined);
			else await service.cancelRun(run.id).catch(() => undefined);
		}
		return { task, run, callbackBound, error: reason };
	}
}

function backgroundStartPayload(start: BackgroundStart): CallToolResult {
	return toolPayload(
		start.error
			? `GPT Worker${start.task ? ` ${start.task.taskId}` : ""} could not start: ${start.error}`
			: `GPT Worker ${start.task!.taskId} started in the background; the parent may yield immediately.`,
		publicBackgroundStart(start),
		start.error !== undefined,
	);
}

function publicBackgroundStart(start: BackgroundStart): Record<string, unknown> {
	return {
		task: start.task ? publicTask(start.task) : undefined,
		run: start.run ? publicRun(start.run) : undefined,
		callbackBound: start.callbackBound,
		callback: start.callback ? {
			targetThreadId: start.callback.threadId,
			state: start.callback.state,
			terminalStatus: start.callback.terminalStatus,
			error: start.callback.error,
		} : undefined,
		error: start.error,
	};
}

function registerWorkerRecoveryTools(
	server: McpServer,
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	codexCallback?: CodexCallbackCoordinator,
): void {
	server.registerTool("gpt_worker_get", {
		description: "Durable read-only lookup for one GPT Worker by run id or MCP task id. Use after reconnect, not as a polling loop.",
		inputSchema: { run_id: z.string().optional(), task_id: z.string().optional() },
		annotations: { readOnlyHint: true },
	}, async (params, extra) => {
		const identity = requireOneIdentity(params.run_id, params.task_id);
		const taskId = identity.taskId ?? await taskStore.findTaskIdByRun(identity.runId!, extra.sessionId);
		if (identity.runId && extra.sessionId !== undefined && !taskId) {
			throw new Error("No GPT Worker owned by this MCP session matched that run id.");
		}
		const runId = identity.runId ?? (taskId ? await taskStore.getRunId(taskId, extra.sessionId) : undefined);
		if (taskId) await activateTaskIfPending(service, taskStore, monitors, taskId, codexCallback);
		const task = taskId ? await taskStore.getTask(taskId, extra.sessionId) : null;
		const run = runId ? await service.getRun(runId) : undefined;
		if (!task && !run) throw new Error("No durable GPT Worker matched that identity.");
		const callback = taskId ? await taskStore.getCodexParent(taskId, extra.sessionId) : undefined;
		return toolPayload(run ? runText(run) : `Task ${taskId}: ${task?.status}.`, {
			task: task ? publicTask(task) : undefined,
			run: run ? publicRun(run) : undefined,
			callback: callback ? {
				targetThreadId: callback.threadId,
				state: callback.state,
				terminalStatus: callback.terminalStatus,
				error: callback.error,
			} : undefined,
		});
	});

	server.registerTool("gpt_worker_cancel", {
		description: "Cancel one GPT Worker independently by run id or MCP task id. Late completion cannot overwrite cancellation.",
		inputSchema: { run_id: z.string().optional(), task_id: z.string().optional() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params, extra) => {
		const identity = requireOneIdentity(params.run_id, params.task_id);
		const taskId = identity.taskId ?? await taskStore.findTaskIdByRun(identity.runId!, extra.sessionId);
		if (identity.runId && extra.sessionId !== undefined && !taskId) {
			throw new Error("No GPT Worker owned by this MCP session matched that run id.");
		}
		if (taskId) {
			const runId = identity.runId ?? await taskStore.getRunId(taskId, extra.sessionId);
			await taskStore.updateTaskStatus(taskId, "cancelled", "Cancelled through gpt_worker_cancel.", extra.sessionId);
			// Keep the tool's provider-Stop guarantee explicit. The task-store listener
			// also routes protocol tasks/cancel here; cancelRun is durable and idempotent.
			const run = runId ? await service.cancelRun(runId) : undefined;
			return toolPayload(
				`GPT Worker ${taskId} is cancelled. ChatGPT Stop cannot cancel connected-tool operations that already started; verify their external state independently.`,
				{
					taskId,
					run: run ? publicRun(run) : undefined,
					cancellationScope: "owned_chatgpt_turn_only",
					warning: "Connected-tool operations already started by ChatGPT can continue after Stop and require independent verification.",
				},
			);
		}
		if (!identity.runId) throw new Error("No run id was available to cancel.");
		return runPayload(await service.cancelRun(identity.runId));
	});

	server.registerTool("gpt_worker_list", {
		description: "Bounded overview of active GPT Workers. This is a recovery aid, not a polling requirement.",
		inputSchema: { limit: z.number().int().positive().max(100).optional(), include_terminal: z.boolean().optional() },
		annotations: { readOnlyHint: true },
	}, async (params, extra) => {
		const limit = params.limit ?? 20;
		const bindings = await taskStore.listBindings(100, extra.sessionId);
		const rows: Array<Record<string, unknown>> = [];
		for (const binding of bindings.sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt))) {
			if (!params.include_terminal && ["completed", "failed", "cancelled"].includes(binding.task.status)) continue;
			const run = binding.runId ? await service.getRun(binding.runId).catch(() => undefined) : undefined;
			const callback = await taskStore.getCodexParent(binding.task.taskId, extra.sessionId);
			rows.push({
				task: publicTask(binding.task),
				run: run ? publicRun(run) : undefined,
				callback: callback ? {
					targetThreadId: callback.threadId,
					state: callback.state,
					terminalStatus: callback.terminalStatus,
					error: callback.error,
				} : undefined,
			});
			if (rows.length >= limit) break;
		}
		return toolPayload(`${rows.length} GPT Worker${rows.length === 1 ? "" : "s"}.`, { workers: rows });
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
	codexCallback?: CodexCallbackCoordinator,
): void {
	if (timers.has(taskId) || monitors.has(taskId)) return;
	const timer = setTimeout(() => {
		timers.delete(taskId);
		void activateTaskIfPending(service, taskStore, monitors, taskId, codexCallback).catch(async (error) => {
			await taskStore.storeTaskResult(taskId, "failed", toolPayload(`GPT Worker activation failed: ${errorMessage(error)}`, {
				taskId, status: "failed", reason: errorMessage(error),
			}, true)).catch(() => undefined);
			await codexCallback?.queue(taskId, await taskStore.getRunId(taskId).catch(() => undefined), "failed");
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
	codexCallback?: CodexCallbackCoordinator,
): Promise<void> {
	const task = await taskStore.getTask(taskId);
	if (!task || task.status !== "working") return;
	const runId = await taskStore.getRunId(taskId);
	if (!runId) return;
	const run = await service.getRun(runId);
	if (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "needs_user") {
		startTaskMonitor(service, taskStore, monitors, taskId, runId, undefined, codexCallback);
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
	await taskStore.updateTaskStatus(taskId, "working", `GPT Worker ${runId} is running in an owned browser conversation.`);
	startTaskMonitor(service, taskStore, monitors, taskId, runId, undefined, codexCallback);
}

function startTaskMonitor(
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors: Map<string, Promise<void>>,
	taskId: string,
	runId: string,
	emitProgress?: (progress: number, message: string) => Promise<void>,
	codexCallback?: CodexCallbackCoordinator,
): Promise<void> {
	const existing = monitors.get(taskId);
	if (existing) return existing;
	const monitor = monitorTask(service, taskStore, taskId, runId, emitProgress, codexCallback)
		.catch(async (error) => {
			await taskStore.storeTaskResult(taskId, "failed", toolPayload(`GPT Worker monitor failed: ${errorMessage(error)}`, {
				taskId,
				runId,
				status: "failed",
				reason: errorMessage(error),
			}, true)).catch(() => undefined);
			await codexCallback?.queue(taskId, runId, "failed");
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
	codexCallback?: CodexCallbackCoordinator,
): Promise<void> {
	const initial = await service.getRun(runId);
	await emitProgress?.(0.45, "Watching the owned ChatGPT conversation without resubmitting or model-visible polling.");
	let run = await service.waitForRun(runId, (initial.timeoutMs ?? 600_000) + 120_000);
	if (run.status === "queued" || run.status === "running") {
		run = await service.markNeedsUser(runId, "The GPT Worker exceeded its bounded monitor deadline. The owned browser conversation and conversation identity were retained; the prompt was not resent.");
	}
	const task = await taskStore.getTask(taskId);
	if (task?.status === "cancelled") return;
	if (run.status === "completed") {
		await emitProgress?.(1, "Stable final assistant turn verified.");
		await taskStore.storeTaskResult(taskId, "completed", subagentResult(taskId, run));
		await codexCallback?.queue(taskId, runId, "completed");
		return;
	}
	if (run.status === "needs_user") {
		await taskStore.updateTaskStatus(taskId, "input_required", run.error ?? "The GPT Worker requires operator input.");
		await emitProgress?.(0.95, "GPT Worker needs operator input; delivering one terminal blocker result.");
		// MCP input_required is intentionally non-terminal. Keep it observable for
		// several declared poll intervals, then seal the task with one blocker result.
		await delay(INPUT_REQUIRED_DELIVERY_GRACE_MS);
		const current = await taskStore.getTask(taskId);
		if (current?.status === "cancelled") return;
		await taskStore.storeTaskResult(taskId, "failed", subagentResult(taskId, run, "input_required"));
		await codexCallback?.queue(taskId, runId, "needs_user");
		return;
	}
	if (run.status === "cancelled") {
		await taskStore.updateTaskStatus(taskId, "cancelled", run.error ?? "GPT Worker was cancelled.");
		return;
	}
	await taskStore.storeTaskResult(taskId, "failed", subagentResult(taskId, run));
	await codexCallback?.queue(taskId, runId, "failed");
}

export async function resumeDurableSubagents(
	service: GptControlService,
	taskStore: DurableTaskStore,
	monitors = new Map<string, Promise<void>>(),
	codexCallback?: CodexCallbackCoordinator,
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
			await taskStore.storeTaskResult(binding.task.taskId, "failed", toolPayload("GPT Worker task has no durable run binding; no prompt was resubmitted.", {
				taskId: binding.task.taskId,
				status: "failed",
				reason: "missing durable run binding",
			}, true));
			continue;
		}
		await service.schedulePreparedRun(runId);
		startTaskMonitor(service, taskStore, monitors, binding.task.taskId, runId, undefined, codexCallback);
	}
}

function subagentRequest(params: SubagentParams, wait: boolean): StartRequest {
	return {
		kind: "subagent",
		prompt: params.prompt,
		title: params.title,
		projectId: params.project_id,
		files: params.files,
		transport: "browser",
		chatgptModel: params.chatgpt_model ?? "pro",
		chatgptEffort: params.chatgpt_effort,
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
		chatgptEffort: params.chatgpt_effort as string | undefined,
		pinChat: params.pin_chat as boolean | undefined,
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
		connectorVerification: connectorVerification(run),
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

function connectorVerification(run: RunRecord): Record<string, unknown> | undefined {
	if (!run.connectorIntent) return undefined;
	const preflight = run.connectorPreflight;
	if (run.connectorIntent.mode !== "require") {
		return {
			status: "unverified",
			evidenceKind: "provider_prompt_intent_only",
			note: "Preferred connector intent was not preflighted. Verify connected-tool results independently.",
		};
	}
	if (preflight?.status === "passed") {
		return {
			status: "preflight_passed",
			evidenceKind: preflight.evidenceKind,
			responseSha256: preflight.responseSha256,
			toolCards: preflight.toolCards,
			verifiedAt: preflight.verifiedAt,
			note: preflight.evidenceKind === "browser_tool_card"
				? "The same conversation returned usable preflight payloads and browser-visible connector-named tool cards. Tool output remains untrusted evidence."
				: "The same conversation returned usable preflight payloads, but GPT-Control did not prove connector tool calls from browser cards. Verify important external facts independently.",
		};
	}
	return {
		status: preflight?.status ?? "required",
		evidenceKind: "none",
		error: preflight?.error,
		note: "The main assignment is blocked until the same-conversation connector preflight passes.",
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
	if (run.status === "completed") return run.resultText ?? "GPT Worker completed without text.";
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

function callbackErrorDetail(value: string): string {
	const normalized = value.trim() || "Codex queue command failed without an error message.";
	return normalized.slice(0, 2048);
}

function isDirectExecution(): boolean {
	const entry = process.argv[1];
	return typeof entry === "string" && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
	const service = new GptControlService(fallbackExec);
	const server = createMcpServer({ service, codexCallback: codexCallbackOptionsFromEnv(process.env, fallbackExec) });
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
