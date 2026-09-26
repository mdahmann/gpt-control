import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { resumeDurableSubagents } from "./src/mcp";
import { RunStore } from "./src/store";
import { DurableTaskStore } from "./src/task_store";
import { FakeChromeBridge, makeChromeService } from "./test_helpers";

const roots: string[] = [];
const oldPoll = process.env.GPT_CONTROL_POLL_MS;
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-run-owner-"));
	roots.push(root);
	return root;
}
async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(2);
	}
	throw new Error("condition did not become true before timeout");
}
function owners(root: string): string[] {
	return readdirSync(join(root, "locks")).filter((name) => name.startsWith("run-owner-"));
}
async function taskFor(store: DurableTaskStore) {
	return store.createTask({ ttl: 600_000, pollInterval: 100 }, 1,
		{ method: "tools/call", params: { name: "gpt_worker_run", arguments: {} } });
}
beforeEach(() => { process.env.GPT_CONTROL_POLL_MS = "1"; });
afterEach(() => {
	if (oldPoll === undefined) delete process.env.GPT_CONTROL_POLL_MS;
	else process.env.GPT_CONTROL_POLL_MS = oldPoll;
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("run owner recovery isolation", () => {
	test("different-policy recovery leaves a live submitted owner and task untouched", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const second = makeChromeService(root, workspace, bridge, { allowSensitiveFiles: true });
		const tasks = new DurableTaskStore(join(root, "mcp-tasks"), first.store);
		const task = await taskFor(tasks);
		const started = await first.service.start({ kind: "subagent", prompt: "[slow] live owner", wait: false, timeoutMs: 5000 });
		await tasks.bindRun(task.taskId, started.run.id);
		await first.store.claimMcpTask(started.run.id, task.taskId);
		await waitUntil(async () => (await first.service.getRun(started.run.id)).submissionState === "submitted");
		try {
			expect(first.service.policy.fingerprint).not.toBe(second.service.policy.fingerprint);
			expect(await second.service.recoverActiveRuns()).toEqual({ resumed: [], blocked: [], deferred: [started.run.id] });
			const monitors = new Map<string, Promise<void>>();
			await resumeDurableSubagents(second.service, tasks, monitors);
			expect(monitors.size).toBe(0);
			expect((await tasks.getTask(task.taskId))?.status).toBe("working");
			expect((await second.service.schedulePreparedRun(started.run.id)).status).toBe("running");
			expect(bridge.stopClicks).toEqual([]);
		} finally {
			bridge.release();
			expect((await first.service.waitForRun(started.run.id, 5000)).status).toBe("completed");
		}
		expect(bridge.submittedPrompts).toEqual(["[slow] live owner"]);
		expect(owners(root)).toEqual([]);
	});

	test("recovery defers a live owner waiting for provider admission", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge, { maxActiveGenerations: 1 });
		const second = makeChromeService(root, workspace, bridge, { maxActiveGenerations: 1 });
		const holder = await first.service.start({ kind: "chat", prompt: "[slow] holder", wait: false, timeoutMs: 5000 });
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		const queued = await first.service.start({ kind: "subagent", prompt: "queued owner", wait: false, timeoutMs: 5000 });
		try {
			await Bun.sleep(25);
			expect(await second.service.recoverActiveRuns()).toEqual({ resumed: [], blocked: [], deferred: expect.arrayContaining([holder.run.id, queued.run.id]) });
			expect((await first.service.getRun(queued.run.id)).submissionState).toBe("not_submitted");
			expect(await second.store.namedLeaseIsLive(`run-owner-${queued.run.id}`)).toBe(true);
			expect(bridge.submittedPrompts).toEqual(["[slow] holder"]);
		} finally {
			bridge.release();
			await first.service.waitForRun(holder.run.id, 5000);
			expect((await first.service.waitForRun(queued.run.id, 5000)).status).toBe("completed");
		}
		expect(bridge.submittedPrompts).toEqual(["[slow] holder", "queued owner"]);
		expect(owners(root)).toEqual([]);
	});

	test("deferred activation is owned even with an unreadable recovery payload", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const second = makeChromeService(root, workspace, bridge, { allowSensitiveFiles: true });
		const prepared = await first.service.start({ kind: "subagent", prompt: "deferred owner", wait: false }, { deferExecution: true });
		const tasks = new DurableTaskStore(join(root, "mcp-tasks"), first.store);
		const task = await taskFor(tasks);
		await tasks.bindRun(task.taskId, prepared.run.id);
		await first.store.deleteRunRequest(prepared.run.id);
		const monitors = new Map<string, Promise<void>>();
		await resumeDurableSubagents(second.service, tasks, monitors);
		expect((await first.service.getRun(prepared.run.id))).toMatchObject({ status: "queued", executionReady: false });
		expect(monitors.size).toBe(0);
		await first.store.updateRun(prepared.run.id, { executionReady: true });
		expect((await second.service.recoverActiveRuns()).deferred).toEqual([prepared.run.id]);
		await first.service.cancelRun(prepared.run.id);
		expect(owners(root)).toEqual([]);
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("unbound tasks get five minutes from creation, but old orphans still fail", async () => {
		const root = scratch();
		const { service, store } = makeChromeService(root, scratch(), new FakeChromeBridge());
		const tasks = new DurableTaskStore(join(root, "mcp-tasks"), store);
		const fresh = await taskFor(tasks);
		const old = await taskFor(tasks);
		const path = join(tasks.root, `${old.taskId}.json`);
		const record = JSON.parse(readFileSync(path, "utf8"));
		record.task.createdAt = new Date(Date.now() - 301_000).toISOString();
		writeFileSync(path, JSON.stringify(record));
		await resumeDurableSubagents(service, tasks, new Map());
		expect((await tasks.getTask(fresh.taskId))?.status).toBe("working");
		expect((await tasks.getTask(old.taskId))?.status).toBe("failed");
	});

	test("an old unbound task claimed by a live owner is neither rebound nor failed", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const second = makeChromeService(root, workspace, bridge);
		const prepared = await first.service.start({ kind: "subagent", prompt: "binding gap", wait: false }, { deferExecution: true });
		const tasks = new DurableTaskStore(join(root, "mcp-tasks"), first.store);
		const task = await taskFor(tasks);
		await first.store.claimMcpTask(prepared.run.id, task.taskId);
		const path = join(tasks.root, `${task.taskId}.json`);
		const record = JSON.parse(readFileSync(path, "utf8"));
		record.task.createdAt = new Date(Date.now() - 301_000).toISOString();
		writeFileSync(path, JSON.stringify(record));
		await resumeDurableSubagents(second.service, tasks, new Map());
		expect(await tasks.getRunId(task.taskId)).toBeUndefined();
		expect((await tasks.getTask(task.taskId))?.status).toBe("working");
		await first.service.cancelRun(prepared.run.id);
		expect(owners(root)).toEqual([]);
	});

	test("overlapping local recovery scopes retain ownership until both settle", async () => {
		const root = scratch();
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const first = makeChromeService(root, workspace, bridge);
		const second = makeChromeService(root, workspace, bridge);
		const prepared = await first.service.start({ kind: "chat", prompt: "overlap", wait: false }, { deferExecution: true });
		await first.service.suspendActiveRunsForRestart();
		const releaseA = Promise.withResolvers<void>();
		const releaseB = Promise.withResolvers<void>();
		let entered = 0;
		const a = first.service.withRunRecoveryOwnership(prepared.run.id, async () => { entered++; await releaseA.promise; });
		const b = first.service.withRunRecoveryOwnership(prepared.run.id, async () => { entered++; await releaseB.promise; });
		try {
			await waitUntil(() => entered === 2);
			releaseA.resolve();
			await a;
			expect(await second.service.withRunRecoveryOwnership(prepared.run.id, async () => {
				throw new Error("another recovery still owns the run");
			})).toBe(false);
		} finally {
			releaseA.resolve();
			releaseB.resolve();
			await Promise.all([a, b]);
		}
		expect(owners(root)).toEqual([]);
		await first.service.cancelRun(prepared.run.id);
	});

	test("a stale dead owner is recoverable and inactive policy mismatch still refuses", async () => {
		for (const differentPolicy of [false, true]) {
			const root = scratch();
			const workspace = scratch();
			const bridge = new FakeChromeBridge();
			const first = makeChromeService(root, workspace, bridge);
			const prepared = await first.service.start({ kind: "subagent", prompt: "dead owner", wait: false, timeoutMs: 3000 }, { deferExecution: true });
			await first.store.updateRun(prepared.run.id, { executionReady: true });
			await first.service.suspendActiveRunsForRestart();
			const name = `run-owner-${prepared.run.id}`;
			const dead = await first.store.acquireNamedLease(name, { heartbeatMs: 60_000 });
			const path = join(root, "locks", `${name}.lock`, "owner.json");
			const record = JSON.parse(readFileSync(path, "utf8"));
			record.pid = 2147483647;
			record.hostname = hostname();
			record.heartbeatAt = new Date(Date.now() - 121_000).toISOString();
			writeFileSync(path, JSON.stringify(record));
			expect(await first.store.namedLeaseIsLive(name)).toBe(false);
			try {
				const second = makeChromeService(root, workspace, bridge, { allowSensitiveFiles: differentPolicy });
				const recovered = await second.service.recoverActiveRuns();
				if (differentPolicy) {
					expect(recovered.blocked).toEqual([prepared.run.id]);
					expect((await second.service.getRun(prepared.run.id)).status).toBe("needs_user");
					expect(bridge.submittedPrompts).toEqual([]);
				} else {
					expect(recovered.resumed).toEqual([prepared.run.id]);
					expect((await second.service.waitForRun(prepared.run.id, 4000)).status).toBe("completed");
					expect(bridge.submittedPrompts).toEqual(["dead owner"]);
				}
				expect(owners(root)).toEqual([]);
			} finally { await dead.release(); }
		}
	});

	test("releases ownership after failure, active cancellation, and unscheduled refusal", async () => {
		const root = scratch();
		const bridge = new FakeChromeBridge();
		const { service, store } = makeChromeService(root, scratch(), bridge);
		const failed = await service.start({ kind: "subagent", prompt: "[fail-start] failure", timeoutMs: 1000 });
		expect(failed.run.status).toBe("failed");
		expect(owners(root)).toEqual([]);
		const active = await service.start({ kind: "subagent", prompt: "[slow] cancel", wait: false, timeoutMs: 3000 });
		await waitUntil(() => bridge.submittedPrompts.length === 1);
		await service.cancelRun(active.run.id);
		expect((await service.waitForRun(active.run.id, 3000)).status).toBe("cancelled");
		expect(owners(root)).toEqual([]);
		const prepared = await service.start({ kind: "subagent", prompt: "refused", wait: false }, { deferExecution: true });
		await store.updateConversation(prepared.conversation.id, { policyFingerprint: "changed" });
		expect((await service.schedulePreparedRun(prepared.run.id)).status).toBe("needs_user");
		expect(owners(root)).toEqual([]);
	});

	test("named leases heartbeat, recognize live processes, and release only their token", async () => {
		const root = scratch();
		const store = new RunStore(root);
		const lease = await store.acquireNamedLease("run-owner-test", { staleMs: 30, heartbeatMs: 5 });
		const path = join(root, "locks", "run-owner-test.lock", "owner.json");
		const initial = JSON.parse(readFileSync(path, "utf8"));
		await waitUntil(() => JSON.parse(readFileSync(path, "utf8")).heartbeatAt !== initial.heartbeatAt);
		expect(await store.namedLeaseIsLive("run-owner-test", { staleMs: 0 })).toBe(true);
		const freshDead = { ...initial, pid: 2147483647, heartbeatAt: new Date().toISOString() };
		writeFileSync(path, JSON.stringify(freshDead));
		expect(await store.namedLeaseIsLive("run-owner-test")).toBe(true);
		writeFileSync(path, JSON.stringify(initial));
		await expect(store.acquireNamedLease("run-owner-test", { timeoutMs: 0, staleMs: 0 })).rejects.toThrow("live owner");
		await lease.release();
		const replacement = await store.acquireNamedLease("run-owner-test");
		await lease.release();
		expect(await store.namedLeaseIsLive("run-owner-test")).toBe(true);
		await replacement.release();
		expect(await store.namedLeaseIsLive("run-owner-test")).toBe(false);
		expect(owners(root)).toEqual([]);
	});
});
