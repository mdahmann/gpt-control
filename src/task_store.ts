import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TaskStore, CreateTaskOptions } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { RequestId, Request, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import { TASK_ID_PATTERN, nowIso, opaqueId } from "./domain";
import { assertTaskId, confinedPath, RunStore, secureDirectory } from "./store";

const TERMINAL = new Set<Task["status"]>(["completed", "failed", "cancelled"]);
const MAX_CODEX_CALLBACK_ATTEMPTS = 3;
const TRANSITIONS: Record<Task["status"], ReadonlySet<Task["status"]>> = {
	working: new Set(["working", "input_required", "completed", "failed", "cancelled"]),
	input_required: new Set(["input_required", "failed", "cancelled"]),
	completed: new Set(["completed"]),
	failed: new Set(["failed"]),
	cancelled: new Set(["cancelled"]),
};

class TaskSessionAccessDenied extends Error {}

interface DurableTaskRecord {
	task: Task;
	requestId: RequestId;
	requestHash: string;
	sessionId?: string;
	runId?: string;
	result?: Result;
	resultHash?: string;
	parentCallback?: CodexParentCallback;
	statusHistory: Array<{ status: Task["status"]; at: string; message?: string }>;
}

export interface CodexParentCallback {
	threadId: string;
	state: "waiting" | "pending" | "attempted" | "delivered" | "failed";
	runId?: string;
	terminalStatus?: "completed" | "failed" | "cancelled" | "needs_user";
	createdAt: string;
	pendingAt?: string;
	attemptedAt?: string;
	finishedAt?: string;
	error?: string;
	attemptCount?: number;
}

export interface CodexCallbackReceipt {
	taskId: string;
	threadId: string;
	runId?: string;
	status: "completed" | "failed" | "cancelled" | "needs_user";
}

export type TaskStatusListener = (task: Task) => void | Promise<void>;
export type TaskCancellationListener = (taskId: string, runId?: string) => void | Promise<void>;

export class DurableTaskStore implements TaskStore {
	readonly root: string;
	private readonly listeners = new Map<string, TaskStatusListener>();
	private cancellationListener?: TaskCancellationListener;
	private readonly lockStore: RunStore;

	constructor(root: string, lockStore?: RunStore) {
		this.root = resolve(root);
		this.lockStore = lockStore ?? new RunStore(resolve(this.root, ".."));
	}

	async init(): Promise<void> {
		await secureDirectory(this.root);
	}

	setCancellationListener(listener: TaskCancellationListener): void {
		this.cancellationListener = listener;
	}

	setStatusListener(taskId: string, listener: TaskStatusListener): void {
		assertTaskId(taskId);
		this.listeners.set(taskId, listener);
	}

	removeStatusListener(taskId: string): void {
		this.listeners.delete(taskId);
	}

	async createTask(
		taskParams: CreateTaskOptions,
		requestId: RequestId,
		request: Request,
		sessionId?: string,
	): Promise<Task> {
		await this.init();
		const timestamp = nowIso();
		const task: Task = {
			taskId: opaqueId("task"),
			status: "working",
			ttl: normalizeTtl(taskParams.ttl),
			createdAt: timestamp,
			lastUpdatedAt: timestamp,
			pollInterval: normalizePollInterval(taskParams.pollInterval),
			statusMessage: "GPT Worker is queued.",
		};
		const record: DurableTaskRecord = {
			task,
			requestId,
			requestHash: jsonHash(request),
			sessionId,
			statusHistory: [{ status: "working", at: timestamp, message: task.statusMessage }],
		};
		await atomicWrite(this.taskPath(task.taskId), record, true);
		return task;
	}

	async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
		try {
			const record = await this.readRecord(taskId);
			return await this.withSessionAccess(record, sessionId, async () => record.task);
		} catch (error) {
			if (isMissing(error)) return null;
			if (error instanceof TaskSessionAccessDenied) return null;
			throw error;
		}
	}

	async storeTaskResult(
		taskId: string,
		status: "completed" | "failed",
		result: Result,
		sessionId?: string,
	): Promise<void> {
		const resultHash = jsonHash(result);
		let notify: Task | undefined;
		await this.mutate(taskId, (record) => {
			if (record.task.status === "cancelled") return record;
			if (TERMINAL.has(record.task.status)) {
				if (record.task.status === status && record.resultHash === resultHash) return record;
				throw new Error(`Task ${taskId} already has an immutable terminal result.`);
			}
			if (!TRANSITIONS[record.task.status].has(status)) throw new Error(`Invalid task transition ${record.task.status} -> ${status}.`);
			const timestamp = nowIso();
			record.task = { ...record.task, status, lastUpdatedAt: timestamp, statusMessage: status === "completed" ? "GPT Worker completed." : "GPT Worker returned a blocker or failure." };
			record.result = result;
			record.resultHash = resultHash;
			record.statusHistory.push({ status, at: timestamp, message: record.task.statusMessage });
			notify = record.task;
			return record;
		}, sessionId);
		if (notify) await this.notify(taskId, notify);
	}

	async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
		const record = await this.readRecord(taskId);
		return this.withSessionAccess(record, sessionId, async () => {
			if (!TERMINAL.has(record.task.status) || record.result === undefined) {
				throw new Error(`Task ${taskId} has no terminal result.`);
			}
			return record.result;
		});
	}

	async updateTaskStatus(
		taskId: string,
		status: Task["status"],
		statusMessage?: string,
		sessionId?: string,
	): Promise<void> {
		if (status === "cancelled") {
			await this.cancelTask(taskId, statusMessage, sessionId);
			return;
		}
		let notify: Task | undefined;
		await this.mutate(taskId, (record) => {
			if (record.task.status === status) {
				if (statusMessage === undefined || statusMessage === record.task.statusMessage) return record;
				const timestamp = nowIso();
				record.task = { ...record.task, lastUpdatedAt: timestamp, statusMessage };
				record.statusHistory.push({ status, at: timestamp, message: statusMessage });
				notify = record.task;
				return record;
			}
			if (TERMINAL.has(record.task.status)) return record;
			if (!TRANSITIONS[record.task.status].has(status)) {
				throw new Error(`Invalid task transition ${record.task.status} -> ${status}.`);
			}
			const timestamp = nowIso();
			record.task = { ...record.task, status, lastUpdatedAt: timestamp, statusMessage };
			record.statusHistory.push({ status, at: timestamp, message: statusMessage });
			if ((status === "completed" || status === "failed") && record.result === undefined) {
				record.result = statusResult(taskId, status, statusMessage);
				record.resultHash = jsonHash(record.result);
			}
			notify = record.task;
			return record;
		}, sessionId);
		if (notify) await this.notify(taskId, notify);
	}

	async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
		await this.init();
		if (cursor !== undefined) assertTaskId(cursor);
		const names = (await readdir(this.root))
			.filter((name) => /^task_[a-f0-9]{32}\.json$/.test(name))
			.sort();
		const start = cursor ? Math.max(0, names.indexOf(`${cursor}.json`) + 1) : 0;
		const tasks: Task[] = [];
		let lastReturnedIndex = -1;
		for (let index = start; index < names.length && tasks.length < 100; index += 1) {
			const record = await this.readRecord(names[index].slice(0, -5));
			try {
				await this.withSessionAccess(record, sessionId, async () => { tasks.push(record.task); });
			} catch (error) {
				if (error instanceof TaskSessionAccessDenied) continue;
				throw error;
			}
			lastReturnedIndex = index;
		}
		let hasMore = false;
		if (lastReturnedIndex >= 0) {
			for (let index = lastReturnedIndex + 1; index < names.length; index += 1) {
				try {
					await this.withSessionAccess(await this.readRecord(names[index].slice(0, -5)), sessionId, async () => undefined);
					hasMore = true;
					break;
				} catch (error) {
					if (error instanceof TaskSessionAccessDenied) continue;
					throw error;
				}
			}
		}
		const last = tasks.at(-1);
		return {
			tasks,
			nextCursor: hasMore && last ? last.taskId : undefined,
		};
	}

	async bindRun(taskId: string, runId: string): Promise<void> {
		await this.lockStore.withTaskLock(taskId, async () => {
			const record = await this.readRecord(taskId);
			if (TERMINAL.has(record.task.status)) {
				throw new Error(`Task ${taskId} is already ${record.task.status} and cannot be bound to a run.`);
			}
			if (record.runId && record.runId !== runId) throw new Error(`Task ${taskId} is already bound to another run.`);
			await this.lockStore.withRunTaskBindingLock(runId, async () => {
				const existingTaskId = await this.findTaskIdByRun(runId);
				if (existingTaskId && existingTaskId !== taskId) {
					throw new Error("This GPT Worker is already bound to another durable MCP task.");
				}
				await this.lockStore.claimMcpTask(runId, taskId);
				if (record.runId === runId) return;
				record.runId = runId;
				validateRecord(record, taskId);
				await atomicWrite(this.taskPath(taskId), record, false);
			});
		});
	}

	async bindCodexParent(taskId: string, threadId: string): Promise<void> {
		assertCodexThreadId(threadId);
		await this.mutate(taskId, (record) => {
			if (record.parentCallback) {
				if (record.parentCallback.threadId !== threadId) {
					throw new Error(`Task ${taskId} is already bound to another Codex parent thread.`);
				}
				return record;
			}
			record.parentCallback = { threadId, state: "waiting", createdAt: nowIso() };
			return record;
		});
	}

	async getCodexParent(taskId: string, sessionId?: string): Promise<CodexParentCallback | undefined> {
		const record = await this.readRecord(taskId);
		return this.withSessionAccess(record, sessionId, async () =>
			record.parentCallback ? { ...record.parentCallback } : undefined);
	}

	async listCodexParentThreadIds(): Promise<string[]> {
		await this.init();
		const names = (await readdir(this.root))
			.filter((name) => /^task_[a-f0-9]{32}\.json$/.test(name))
			.sort();
		const threadIds = new Set<string>();
		for (const name of names) {
			const record = await this.readRecord(name.slice(0, -5));
			if (record.parentCallback) threadIds.add(record.parentCallback.threadId);
		}
		return [...threadIds].sort();
	}

	async stageCodexCallback(
		taskId: string,
		runId: string | undefined,
		status: CodexCallbackReceipt["status"],
	): Promise<boolean> {
		let pending = false;
		await this.mutate(taskId, (record) => {
			const callback = record.parentCallback;
			if (!callback) return record;
			if (callback.state === "pending") {
				pending = true;
				return record;
			}
			if (callback.state !== "waiting") return record;
			if (!TERMINAL.has(record.task.status)) {
				throw new Error(`Task ${taskId} cannot queue a parent callback before terminal state.`);
			}
			const terminalStatus = record.task.status === "completed"
				? "completed"
				: record.task.status === "cancelled"
					? "cancelled"
					: status === "needs_user" ? "needs_user" : "failed";
			const timestamp = nowIso();
			record.parentCallback = { ...callback, state: "pending", runId, terminalStatus, pendingAt: timestamp };
			pending = true;
			return record;
		});
		return pending;
	}

	async reconcileCodexCallbacks(threadId: string): Promise<number> {
		assertCodexThreadId(threadId);
		await this.init();
		const names = (await readdir(this.root)).filter((name) => /^task_[a-f0-9]{32}\.json$/.test(name)).sort();
		let pending = 0;
		for (const name of names) {
			const taskId = name.slice(0, -5);
			const record = await this.readRecord(taskId);
			if (record.parentCallback?.threadId !== threadId) continue;
			if (record.parentCallback.state === "pending") {
				pending += 1;
				continue;
			}
			if ((record.parentCallback.state === "attempted" || record.parentCallback.state === "failed")
				&& (record.parentCallback.attemptCount ?? 0) < MAX_CODEX_CALLBACK_ATTEMPTS) {
				await this.mutate(taskId, (current) => {
					const callback = current.parentCallback;
					if (!callback || callback.threadId !== threadId
						|| (callback.state !== "attempted" && callback.state !== "failed")
						|| (callback.attemptCount ?? 0) >= MAX_CODEX_CALLBACK_ATTEMPTS) return current;
					current.parentCallback = { ...callback, state: "pending", pendingAt: nowIso() };
					return current;
				});
				pending += 1;
				continue;
			}
			if (record.parentCallback.state !== "waiting" || !TERMINAL.has(record.task.status)) continue;
			let status = callbackStatus(record.task.status, record.runId);
			if (record.runId) {
				const run = await this.lockStore.getRun(record.runId);
				if (run.status === "needs_user") status = "needs_user";
			}
			if (await this.stageCodexCallback(taskId, record.runId, status)) pending += 1;
		}
		return pending;
	}

	async claimPendingCodexCallbacks(threadId: string): Promise<CodexCallbackReceipt[]> {
		assertCodexThreadId(threadId);
		return this.lockStore.withCodexCallbackLock(threadId, async () => {
			await this.init();
			const names = (await readdir(this.root)).filter((name) => /^task_[a-f0-9]{32}\.json$/.test(name)).sort();
			const receipts: CodexCallbackReceipt[] = [];
			for (const name of names) {
				const taskId = name.slice(0, -5);
				let claimed: CodexCallbackReceipt | undefined;
				await this.mutate(taskId, (record) => {
					const callback = record.parentCallback;
					if (callback?.threadId !== threadId || callback.state !== "pending" || !callback.terminalStatus) return record;
					claimed = { taskId, threadId, runId: callback.runId, status: callback.terminalStatus };
					record.parentCallback = {
						...callback,
						state: "attempted",
						attemptedAt: nowIso(),
						attemptCount: (callback.attemptCount ?? 0) + 1,
					};
					return record;
				});
				if (claimed) receipts.push(claimed);
			}
			return receipts;
		});
	}

	async finishCodexCallbacks(taskIds: readonly string[], delivered: boolean, error?: string): Promise<void> {
		for (const taskId of taskIds) {
			await this.mutate(taskId, (record) => {
				const callback = record.parentCallback;
				if (!callback || callback.state !== "attempted") return record;
				record.parentCallback = {
					...callback,
					state: delivered ? "delivered" : "failed",
					finishedAt: nowIso(),
					error: delivered ? undefined : error,
				};
				return record;
			});
		}
	}

	async getRunId(taskId: string, sessionId?: string): Promise<string | undefined> {
		const record = await this.readRecord(taskId);
		return this.withSessionAccess(record, sessionId, async () => record.runId);
	}

	async statusHistory(taskId: string): Promise<DurableTaskRecord["statusHistory"]> {
		return [...(await this.readRecord(taskId)).statusHistory];
	}

	async findTaskIdByRun(runId: string, sessionId?: string): Promise<string | undefined> {
		let cursor: string | undefined;
		do {
			const page = await this.listTasks(cursor, sessionId);
			for (const task of page.tasks) {
				if ((await this.readRecord(task.taskId)).runId === runId) return task.taskId;
			}
			cursor = page.nextCursor;
		} while (cursor);
		return undefined;
	}

	async legacySessionOwnsRun(runId: string, sessionId: string): Promise<boolean> {
		await this.init();
		await this.lockStore.getRun(runId);
		const names = (await readdir(this.root)).filter((name) => /^task_[a-f0-9]{32}\.json$/.test(name));
		for (const name of names) {
			const record = await this.readRecord(name.slice(0, -5));
			if (record.runId === runId) return record.sessionId === sessionId;
		}
		return false;
	}

	async listBindings(limit?: number, sessionId?: string): Promise<Array<{ task: Task; runId?: string }>> {
		const values: Array<{ task: Task; runId?: string }> = [];
		const boundedLimit = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(limit, 1000));
		let cursor: string | undefined;
		do {
			const page = await this.listTasks(cursor, sessionId);
			for (const task of page.tasks) {
				const record = await this.readRecord(task.taskId);
				values.push({ task: record.task, runId: record.runId });
				if (values.length >= boundedLimit) return values;
			}
			cursor = page.nextCursor;
		} while (cursor);
		return values;
	}

	private taskPath(taskId: string): string {
		assertTaskId(taskId);
		return confinedPath(this.root, `${taskId}.json`);
	}

	private async readRecord(taskId: string): Promise<DurableTaskRecord> {
		await this.init();
		const path = this.taskPath(taskId);
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe task record: ${path}`);
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			return validateRecord(JSON.parse(await handle.readFile("utf8")), taskId);
		} finally {
			await handle.close();
		}
	}

	private async mutate(taskId: string, update: (record: DurableTaskRecord) => DurableTaskRecord, sessionId?: string): Promise<void> {
		await this.lockStore.withTaskLock(taskId, async () => {
			const current = await this.readRecord(taskId);
			await this.withSessionAccess(current, sessionId, async () => {
				const next = update(current);
				validateRecord(next, taskId);
				await atomicWrite(this.taskPath(taskId), next, false);
			});
		});
	}

	private async cancelTask(taskId: string, statusMessage?: string, sessionId?: string): Promise<void> {
		let notify: Task | undefined;
		await this.lockStore.withTaskLock(taskId, async () => {
			const record = await this.readRecord(taskId);
			await this.withSessionAccess(record, sessionId, async () => {
				if (record.task.status === "cancelled" || TERMINAL.has(record.task.status)) return;
				if (!TRANSITIONS[record.task.status].has("cancelled")) {
					throw new Error(`Invalid task transition ${record.task.status} -> cancelled.`);
				}
				const timestamp = nowIso();
				if (record.runId) {
				// The service owns browser cancellation. Invoke it while the task lock
				// prevents a competing task result, and before sealing this task, so the
				// active controller is aborted before an in-flight send can complete.
				await this.cancellationListener?.(taskId, record.runId);
				let run = await this.lockStore.getRun(record.runId);
				if (!this.cancellationListener && (run.status === "queued" || run.status === "running")) {
					run = await this.lockStore.updateRun(record.runId, {
						status: "cancelled",
						providerStopRequested: true,
						cancellationRequestedAt: timestamp,
						completedAt: timestamp,
						error: statusMessage ?? "Client cancelled task execution. Late provider completion is ignored.",
					});
				}
				// If provider completion won the run-record lock, do not discard that
				// immutable result by independently cancelling its still-working task.
					if (run.status !== "cancelled") return;
				}
				record.task = { ...record.task, status: "cancelled", lastUpdatedAt: timestamp, statusMessage };
				record.result = cancellationResult(taskId, record.runId, statusMessage);
				record.resultHash = jsonHash(record.result);
				record.statusHistory.push({ status: "cancelled", at: timestamp, message: statusMessage });
				validateRecord(record, taskId);
				await atomicWrite(this.taskPath(taskId), record, false);
				notify = record.task;
			});
		});
		if (notify) await this.notify(taskId, notify);
	}

	private async withSessionAccess<T>(
		record: DurableTaskRecord,
		sessionId: string | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		// Undefined is reserved for broker-internal recovery and single-session
		// transports. Once a task is bound, the conversation is the single durable
		// ownership authority for the task and all of its runs.
		if (sessionId === undefined) return operation();
		if (record.runId) {
			const run = await this.lockStore.getRun(record.runId);
			return this.lockStore.withConversationOwnershipLock(run.conversationId, async () => {
				const currentRun = await this.lockStore.getRun(record.runId!);
				if (currentRun.conversationId !== run.conversationId) throw new Error("Durable task run conversation identity changed.");
				const conversation = await this.lockStore.getConversation(run.conversationId);
				const allowed = conversation.mcpSessionId !== undefined
					? conversation.mcpSessionId === sessionId
					: record.sessionId !== undefined && record.sessionId === sessionId;
				if (!allowed) throw new TaskSessionAccessDenied(`Task ${record.task.taskId} is not owned by this MCP session.`);
				return operation();
			});
		}
		if (record.sessionId === undefined || record.sessionId !== sessionId) {
			throw new TaskSessionAccessDenied(`Task ${record.task.taskId} is not owned by this MCP session.`);
		}
		return operation();
	}

	private async notify(taskId: string, task: Task): Promise<void> {
		try {
			await this.listeners.get(taskId)?.(task);
		} catch {
			// Delivery is best effort. Durable tasks/get and tasks/result remain authoritative.
		}
	}
}

function validateRecord(value: unknown, expectedId: string): DurableTaskRecord {
	if (!value || typeof value !== "object") throw new Error(`Invalid task record ${expectedId}.`);
	const record = value as DurableTaskRecord;
	if (!record.task || record.task.taskId !== expectedId || !TASK_ID_PATTERN.test(record.task.taskId)) {
		throw new Error(`Task record identity mismatch for ${expectedId}.`);
	}
	if (!(record.task.status in TRANSITIONS)) throw new Error(`Invalid task status for ${expectedId}.`);
	if (!Array.isArray(record.statusHistory)) throw new Error(`Invalid task status history for ${expectedId}.`);
	if (record.parentCallback) validateCodexParentCallback(record.parentCallback, expectedId);
	return record;
}

function validateCodexParentCallback(callback: CodexParentCallback, taskId: string): void {
	assertCodexThreadId(callback.threadId);
	if (!new Set(["waiting", "pending", "attempted", "delivered", "failed"]).has(callback.state)) {
		throw new Error(`Invalid Codex callback state for ${taskId}.`);
	}
	if (callback.terminalStatus && !new Set(["completed", "failed", "cancelled", "needs_user"]).has(callback.terminalStatus)) {
		throw new Error(`Invalid Codex callback terminal status for ${taskId}.`);
	}
	if (callback.state !== "waiting" && !callback.terminalStatus) {
		throw new Error(`Codex callback ${taskId} is missing terminal status.`);
	}
	if (callback.attemptCount !== undefined
		&& (!Number.isInteger(callback.attemptCount) || callback.attemptCount < 0 || callback.attemptCount > MAX_CODEX_CALLBACK_ATTEMPTS)) {
		throw new Error(`Codex callback ${taskId} has an invalid attempt count.`);
	}
}

function assertCodexThreadId(threadId: string): void {
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(threadId)) {
		throw new Error("Invalid Codex parent thread id.");
	}
}

function callbackStatus(status: Task["status"], runId?: string): CodexCallbackReceipt["status"] {
	if (status === "completed" || status === "cancelled") return status;
	if (status === "failed") return "failed";
	throw new Error(`Task ${runId ?? "without a run"} is not terminal for a Codex callback.`);
}

async function atomicWrite(path: string, value: DurableTaskRecord, createOnly: boolean): Promise<void> {
	await secureDirectory(dirname(path));
	if (createOnly) {
		const handle = await open(path, "wx", 0o600);
		try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
		return;
	}
	const current = await lstat(path);
	if (current.isSymbolicLink() || !current.isFile()) throw new Error(`Refused unsafe task destination: ${path}`);
	const scratch = confinedPath(dirname(path), `.${randomUUID()}.tmp`);
	const handle = await open(scratch, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
	await rename(scratch, path);
}

function normalizeTtl(value: number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	if (!Number.isFinite(value) || value < 60_000) return 60_000;
	return Math.min(Math.floor(value), 7 * 24 * 60 * 60_000);
}

function normalizePollInterval(value: number | undefined): number {
	if (!Number.isFinite(value) || value === undefined) return 1000;
	return Math.max(250, Math.min(Math.floor(value), 10_000));
}

function cancellationResult(taskId: string, runId?: string, reason?: string): Result {
	const details = {
		taskId,
		runId,
		status: "cancelled" as const,
		reason: reason ?? "Client cancelled task execution.",
		cancellationScope: "owned_chatgpt_turn_only",
		warning: "Connected-tool operations already started by ChatGPT can continue after Stop and require independent verification.",
	};
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		structuredContent: details,
		isError: true,
	};
}

function statusResult(taskId: string, status: "completed" | "failed", message?: string): Result {
	return {
		content: [{ type: "text", text: JSON.stringify({ taskId, status, message }) }],
		isError: status === "failed",
	};
}

function jsonHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
