#!/usr/bin/env bun
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ProgressToken, Task } from "@modelcontextprotocol/sdk/types.js";
import type { CreateTaskRequestHandlerExtra, TaskRequestHandlerExtra } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import { z } from "zod";
import { fallbackExec } from "./host";
import { PACKAGE_VERSION, type RunKind, type RunRecord } from "./domain";
import { GptControlService, type StartRequest } from "./service";
import { DurableTaskStore } from "./task_store";

const TransportSchema = z.enum(["chrome_bridge", "codex", "responses"]);
const ChatGptModelSchema = z.literal("pro");
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const CommonSchema = {
	conversation_id: z.string().optional(),
	files: z.array(z.string()).max(32).optional(),
	transport: TransportSchema.optional(),
	chatgpt_model: ChatGptModelSchema.optional(),
	provider_model: z.string().min(1).optional(),
	idempotency_key: IdempotencyKeySchema.optional(),
	wait: z.boolean().optional(),
	timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
};
const INPUT_REQUIRED_DELIVERY_GRACE_MS = 500;
const SUBAGENT_TASK_POLL_INTERVAL_MS = 100;

const SubagentSchema = {
	prompt: z.string().min(1),
	files: z.array(z.string()).max(32).optional(),
	idempotency_key: IdempotencyKeySchema,
	timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
};

interface SubagentParams {
	prompt: string;
	files?: string[];
	idempotency_key: string;
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
	const server = new McpServer(
		{ name: "gpt-control", version: PACKAGE_VERSION },
		{
			taskStore,
			defaultTaskPollInterval: 1000,
			capabilities: tasksEnabled ? {
				tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
			} : {},
		},
	);
	const monitors = new Map<string, Promise<void>>();

	taskStore.setCancellationListener(async (_taskId, runId) => {
		if (runId) await service.cancelRun(runId);
	});

	registerCoreTools(server, service);
	registerSubagentRecoveryTools(server, service, taskStore);
	registerSubagentRun(server, service, taskStore, monitors, tasksEnabled);

	if (options.recover !== false) {
		void resumeDurableSubagents(service, taskStore, monitors).catch((error) => {
			console.error(`GPT-Control task recovery failed: ${errorMessage(error)}`);
		});
	}
	return server;
}

function registerCoreTools(server: McpServer, service: GptControlService): void {
	server.registerTool("gpt_consult", {
		description: "Request a bounded independent review. Attachment and provider authority come only from trusted operator policy.",
		inputSchema: { question: z.string().min(1), ...CommonSchema },
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params) => startPayload(await service.start(toRequest(params, "consult", params.question))));

	server.registerTool("gpt_chat", {
		description: "Start or continue one provider conversation. Each submission receives a durable run id and truthful provenance.",
		inputSchema: { prompt: z.string().min(1), ...CommonSchema },
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params) => startPayload(await service.start(toRequest(params, "chat", params.prompt))));

	server.registerTool("gpt_image", {
		description: "Generate an image in an owned ChatGPT tab. Returns verified run provenance and provider artifact URLs; local writes remain policy-confined.",
		inputSchema: {
			prompt: z.string().min(1),
			conversation_id: z.string().optional(),
			files: z.array(z.string()).max(32).optional(),
			chatgpt_model: ChatGptModelSchema.optional(),
			idempotency_key: IdempotencyKeySchema.optional(),
			timeout_ms: z.number().int().positive().max(60 * 60_000).optional(),
		},
		annotations: { readOnlyHint: false, destructiveHint: false },
	}, async (params) => startPayload(await service.start({
		kind: "image",
		prompt: params.prompt,
		files: params.files,
		conversationId: params.conversation_id,
		transport: "chrome_bridge",
		chatgptModel: params.chatgpt_model,
		idempotencyKey: params.idempotency_key,
		timeoutMs: params.timeout_ms,
	})));

	server.registerTool("gpt_run", {
		description: "Read one exact durable run. Internal polling never submits a prompt and is not required for task-based subagents.",
		inputSchema: { action: z.enum(["status", "wait", "result"]), run_id: z.string(), timeout_ms: z.number().int().positive().optional() },
		annotations: { readOnlyHint: true },
	}, async (params) => {
		const run = params.action === "wait" ? await service.waitForRun(params.run_id, params.timeout_ms) : await service.getRun(params.run_id);
		return runPayload(run);
	});

	server.registerTool("gpt_run_cancel", {
		description: "Cancel one durable run. Terminal state is monotonic; late provider completion cannot overwrite cancellation.",
		inputSchema: { run_id: z.string() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params) => runPayload(await service.cancelRun(params.run_id)));

	server.registerTool("gpt_conversation_close", {
		description: "Close one GPT-Control conversation locally. Provider-side history and uploads are not deleted.",
		inputSchema: { conversation_id: z.string() },
		annotations: { readOnlyHint: false, destructiveHint: true },
	}, async (params) => {
		const conversation = await service.closeConversation(params.conversation_id);
		return toolPayload(`Closed ${conversation.id} locally. Provider-side data was not deleted.`, {
			conversationId: conversation.id,
			closedAt: conversation.closedAt,
		});
	});

	server.registerTool("gpt_diagnose", {
		description: "Passively report discovered transports and trusted policy. Does not execute Bridge, Oracle, Codex, or a model.",
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
	taskSupport: boolean,
): void {
	const config = {
		title: "Run ChatGPT Pro worker",
		description: "Start one bounded ChatGPT Pro worker in its own owned tab. Codex remains the orchestrator. Do not poll while the task result is pending.",
		inputSchema: SubagentSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		execution: { taskSupport: "optional" as const },
	};
	if (!taskSupport || typeof server.experimental.tasks.registerToolTask !== "function") {
		server.registerTool("gpt_subagent_run", {
			...config,
			description: `${config.description} This runtime lacks MCP task registration, so the call returns exactly once when terminal.`,
		}, async (params) => startPayload(await service.start(subagentRequest(params, true))));
		return;
	}

	server.experimental.tasks.registerToolTask("gpt_subagent_run", config, {
		async createTask(params: SubagentParams, extra: CreateTaskRequestHandlerExtra) {
			const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl, pollInterval: SUBAGENT_TASK_POLL_INTERVAL_MS });
			const progressToken = readProgressToken(extra._meta?.progressToken);
			taskStore.setStatusListener(task.taskId, async (updated) => {
				await extra.sendNotification({ method: "notifications/tasks/status", params: updated });
			});
			extra.signal.addEventListener("abort", () => {
				void taskStore.updateTaskStatus(task.taskId, "cancelled", "Originating MCP request was cancelled.");
			}, { once: true });
			await sendProgress(extra.sendNotification, progressToken, 0.05, "Creating owned Pro worker.");
			try {
				const started = await service.start(subagentRequest(params, false), { deferExecution: true });
				await taskStore.bindRun(task.taskId, started.run.id);
				if (!started.run.mcpTaskId) await service.store.updateRun(started.run.id, { mcpTaskId: task.taskId });
				const currentTask = await taskStore.getTask(task.taskId);
				if (currentTask?.status === "cancelled") {
					await service.cancelRun(started.run.id);
				} else {
					await service.schedulePreparedRun(started.run.id);
					await taskStore.updateTaskStatus(task.taskId, "working", `Pro worker ${started.run.id} is running in an owned tab.`);
					await sendProgress(extra.sendNotification, progressToken, 0.2, "Owned worker scheduled; live Pro selector verification is pending.");
					startTaskMonitor(service, taskStore, monitors, task.taskId, started.run.id, (progress, message) =>
						sendProgress(extra.sendNotification, progressToken, progress, message));
				}
			} catch (error) {
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
			return await extra.taskStore.getTask(extra.taskId);
		},
		async getTaskResult(_params: SubagentParams, extra: TaskRequestHandlerExtra) {
			return await extra.taskStore.getTaskResult(extra.taskId) as CallToolResult;
		},
	});
}

function registerSubagentRecoveryTools(server: McpServer, service: GptControlService, taskStore: DurableTaskStore): void {
	server.registerTool("gpt_subagent_get", {
		description: "Durable read-only lookup for one Pro worker by run id or MCP task id. Use after reconnect, not as a polling loop.",
		inputSchema: { run_id: z.string().optional(), task_id: z.string().optional() },
		annotations: { readOnlyHint: true },
	}, async (params) => {
		const identity = requireOneIdentity(params.run_id, params.task_id);
		const taskId = identity.taskId ?? await taskStore.findTaskIdByRun(identity.runId!);
		const runId = identity.runId ?? (taskId ? await taskStore.getRunId(taskId) : undefined);
		const task = taskId ? await taskStore.getTask(taskId) : null;
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
	}, async (params) => {
		const identity = requireOneIdentity(params.run_id, params.task_id);
		const taskId = identity.taskId ?? await taskStore.findTaskIdByRun(identity.runId!);
		if (taskId) {
			await taskStore.updateTaskStatus(taskId, "cancelled", "Cancelled through gpt_subagent_cancel.");
			const runId = identity.runId ?? await taskStore.getRunId(taskId);
			const run = runId ? await service.getRun(runId) : undefined;
			return toolPayload(`Pro worker ${taskId} is cancelled.`, { taskId, run: run ? publicRun(run) : undefined });
		}
		if (!identity.runId) throw new Error("No run id was available to cancel.");
		return runPayload(await service.cancelRun(identity.runId));
	});

	server.registerTool("gpt_subagent_list", {
		description: "Bounded overview of active Pro workers. This is a recovery aid, not a polling requirement.",
		inputSchema: { limit: z.number().int().positive().max(100).optional(), include_terminal: z.boolean().optional() },
		annotations: { readOnlyHint: true },
	}, async (params) => {
		const limit = params.limit ?? 20;
		const bindings = await taskStore.listBindings(100);
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
		run = await service.markNeedsUser(runId, "The Pro worker exceeded its bounded monitor deadline. The owned tab and conversation identity were retained; the prompt was not resent.");
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
	await service.recoverActiveRuns();
	for (const binding of await taskStore.listBindings(100)) {
		if (["completed", "failed", "cancelled"].includes(binding.task.status)) continue;
		if (!binding.runId) {
			await taskStore.storeTaskResult(binding.task.taskId, "failed", toolPayload("Pro worker task has no durable run binding; no prompt was resubmitted.", {
				taskId: binding.task.taskId,
				status: "failed",
				reason: "missing durable run binding",
			}, true));
			continue;
		}
		await service.schedulePreparedRun(binding.runId);
		startTaskMonitor(service, taskStore, monitors, binding.task.taskId, binding.runId);
	}
}

function subagentRequest(params: SubagentParams, wait: boolean): StartRequest {
	return {
		kind: "subagent",
		prompt: params.prompt,
		files: params.files,
		transport: "chrome_bridge",
		chatgptModel: "pro",
		idempotencyKey: params.idempotency_key,
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
		providerModel: params.provider_model as string | undefined,
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

if (import.meta.main) {
	await createMcpServer().connect(new StdioServerTransport());
}
