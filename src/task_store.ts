import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TaskStore, CreateTaskOptions } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { RequestId, Request, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import { TASK_ID_PATTERN, nowIso, opaqueId } from "./domain";
import { assertTaskId, confinedPath, RunStore, secureDirectory } from "./store";

const TERMINAL = new Set<Task["status"]>(["completed", "failed", "cancelled"]);
const TRANSITIONS: Record<Task["status"], ReadonlySet<Task["status"]>> = {
	working: new Set(["working", "input_required", "completed", "failed", "cancelled"]),
	input_required: new Set(["input_required", "failed", "cancelled"]),
	completed: new Set(["completed"]),
	failed: new Set(["failed"]),
	cancelled: new Set(["cancelled"]),
};

interface DurableTaskRecord {
	task: Task;
	requestId: RequestId;
	requestHash: string;
	sessionId?: string;
	runId?: string;
	result?: Result;
	resultHash?: string;
	statusHistory: Array<{ status: Task["status"]; at: string; message?: string }>;
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
			statusMessage: "GPT-Control Pro worker is queued.",
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

	async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
		try {
			return (await this.readRecord(taskId)).task;
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	async storeTaskResult(
		taskId: string,
		status: "completed" | "failed",
		result: Result,
		_sessionId?: string,
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
			record.task = { ...record.task, status, lastUpdatedAt: timestamp, statusMessage: status === "completed" ? "Pro worker completed." : "Pro worker returned a blocker or failure." };
			record.result = result;
			record.resultHash = resultHash;
			record.statusHistory.push({ status, at: timestamp, message: record.task.statusMessage });
			notify = record.task;
			return record;
		});
		if (notify) await this.notify(taskId, notify);
	}

	async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
		const record = await this.readRecord(taskId);
		if (!TERMINAL.has(record.task.status) || record.result === undefined) {
			throw new Error(`Task ${taskId} has no terminal result.`);
		}
		return record.result;
	}

	async updateTaskStatus(
		taskId: string,
		status: Task["status"],
		statusMessage?: string,
		_sessionId?: string,
	): Promise<void> {
		let notify: Task | undefined;
		let cancelledRunId: string | undefined;
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
			if (status === "cancelled") {
				record.result = cancellationResult(taskId, record.runId, statusMessage);
				record.resultHash = jsonHash(record.result);
				cancelledRunId = record.runId;
			} else if ((status === "completed" || status === "failed") && record.result === undefined) {
				record.result = statusResult(taskId, status, statusMessage);
				record.resultHash = jsonHash(record.result);
			}
			notify = record.task;
			return record;
		});
		if (notify) await this.notify(taskId, notify);
		if (notify?.status === "cancelled") {
			await this.cancellationListener?.(taskId, cancelledRunId);
		}
	}

	async listTasks(cursor?: string, _sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
		await this.init();
		if (cursor !== undefined) assertTaskId(cursor);
		const names = (await readdir(this.root))
			.filter((name) => /^task_[a-f0-9]{32}\.json$/.test(name))
			.sort();
		const start = cursor ? Math.max(0, names.indexOf(`${cursor}.json`) + 1) : 0;
		const page = names.slice(start, start + 100);
		const tasks = await Promise.all(page.map((name) => this.readRecord(name.slice(0, -5)).then((record) => record.task)));
		const last = page.at(-1);
		return {
			tasks,
			nextCursor: start + page.length < names.length && last ? last.slice(0, -5) : undefined,
		};
	}

	async bindRun(taskId: string, runId: string): Promise<void> {
		await this.mutate(taskId, (record) => {
			if (record.runId && record.runId !== runId) throw new Error(`Task ${taskId} is already bound to another run.`);
			record.runId = runId;
			return record;
		});
	}

	async getRunId(taskId: string): Promise<string | undefined> {
		return (await this.readRecord(taskId)).runId;
	}

	async statusHistory(taskId: string): Promise<DurableTaskRecord["statusHistory"]> {
		return [...(await this.readRecord(taskId)).statusHistory];
	}

	async findTaskIdByRun(runId: string): Promise<string | undefined> {
		let cursor: string | undefined;
		do {
			const page = await this.listTasks(cursor);
			for (const task of page.tasks) {
				if ((await this.readRecord(task.taskId)).runId === runId) return task.taskId;
			}
			cursor = page.nextCursor;
		} while (cursor);
		return undefined;
	}

	async listBindings(limit = 100): Promise<Array<{ task: Task; runId?: string }>> {
		const values: Array<{ task: Task; runId?: string }> = [];
		let cursor: string | undefined;
		do {
			const page = await this.listTasks(cursor);
			for (const task of page.tasks) {
				const record = await this.readRecord(task.taskId);
				values.push({ task: record.task, runId: record.runId });
				if (values.length >= Math.max(1, Math.min(limit, 1000))) return values;
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

	private async mutate(taskId: string, update: (record: DurableTaskRecord) => DurableTaskRecord): Promise<void> {
		await this.lockStore.withTaskLock(taskId, async () => {
			const next = update(await this.readRecord(taskId));
			validateRecord(next, taskId);
			await atomicWrite(this.taskPath(taskId), next, false);
		});
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
	return record;
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
	return {
		content: [{ type: "text", text: JSON.stringify({ taskId, runId, status: "cancelled", reason: reason ?? "Client cancelled task execution." }) }],
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
