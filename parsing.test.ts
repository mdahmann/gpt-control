import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachmentManifest, isSensitive, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "./src/files";
import { parseReviewReport } from "./src/review";
import { RunStore } from "./src/store";
import { STORAGE_VERSION, nowIso, type AttachmentManifest, type ConversationRecord, type RunRecord } from "./src/domain";

const roots: string[] = [];
function scratch(prefix = "gpt-control-security-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("least-privilege attachment snapshots", () => {
	test("snapshots exact approved bytes once and binds hashes and line counts to the snapshot", async () => {
		const workspace = scratch();
		const snapshots = scratch();
		writeFileSync(join(workspace, "a.ts"), "one\ntwo\n");
		const manifest = await buildAttachmentManifest(["a.ts"], { workspaceRoot: workspace, snapshotRoot: snapshots });
		writeFileSync(join(workspace, "a.ts"), "replacement\n");
		expect(readFileSync(manifest.files[0].path, "utf8")).toBe("one\ntwo\n");
		expect(manifest.files[0]).toMatchObject({ relativePath: "a.ts", size: 8, lineCount: 2 });
		expect(manifest.files[0].sha256).toHaveLength(64);
		expect(manifest.sha256).toHaveLength(64);
		expect(manifest.files[0].path.startsWith(snapshots)).toBe(true);
		expect(manifest.files[0].path).not.toBe(join(workspace, "a.ts"));
	});

	test("rejects symlinks, non-regular files, and replacement races", async () => {
		const workspace = scratch();
		const outside = scratch();
		writeFileSync(join(outside, "secret.txt"), "outside");
		symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
		await expect(buildAttachmentManifest(["link.txt"], { workspaceRoot: workspace, snapshotRoot: scratch() })).rejects.toThrow("symlink");
		mkdirSync(join(workspace, "directory"));
		await expect(buildAttachmentManifest(["directory"], { workspaceRoot: workspace, snapshotRoot: scratch() })).rejects.toThrow();

		writeFileSync(join(workspace, "race.txt"), "approved bytes");
		await expect(buildAttachmentManifest(["race.txt"], {
			workspaceRoot: workspace,
			snapshotRoot: scratch(),
			testAfterOpen: () => {
				renameSync(join(workspace, "race.txt"), join(workspace, "old.txt"));
				writeFileSync(join(workspace, "race.txt"), "attacker replacement");
			},
		})).rejects.toThrow("replaced");
	});

	test("removes partial snapshot bytes after a failed request", async () => {
		const workspace = scratch();
		const snapshots = scratch();
		writeFileSync(join(workspace, "first.txt"), "approved");
		await expect(buildAttachmentManifest(["first.txt", "missing.txt"], {
			workspaceRoot: workspace,
			snapshotRoot: snapshots,
		})).rejects.toThrow();
		expect(readdirSync(snapshots)).toEqual([]);
	});

	test("requires trusted policy for outside and sensitive files", async () => {
		const workspace = scratch();
		const outside = scratch();
		writeFileSync(join(outside, ".env.local"), "TOKEN=value\n");
		await expect(buildAttachmentManifest([join(outside, ".env.local")], {
			workspaceRoot: workspace,
			snapshotRoot: scratch(),
			allowOutsideWorkspace: true,
		})).rejects.toThrow("sensitive");
		const manifest = await buildAttachmentManifest([join(outside, ".env.local")], {
			workspaceRoot: workspace,
			snapshotRoot: scratch(),
			allowOutsideWorkspace: true,
			allowSensitiveFiles: true,
		});
		expect(manifest.files[0].relativePath).toMatch(/^external\//);
	});

	test("covers common secret stores without unsafe basename loopholes", () => {
		for (const path of [
			"/repo/.env.local",
			"/repo/.env.production",
			"/home/me/.npmrc",
			"/home/me/.netrc",
			"/home/me/.git-credentials",
			"/home/me/.aws/credentials",
			"/home/me/.config/gcloud/application_default_credentials.json",
			"/home/me/.ssh/id_ed25519",
			"/home/me/.docker/config.json",
			"/repo/service-account-prod.json",
		]) expect(isSensitive(path)).toBe(true);
		expect(isSensitive("/repo/src/credentials-view.tsx")).toBe(true); // documented conservative false positive; only trusted policy may override
		expect(isSensitive("/repo/src/index.ts")).toBe(false);
	});

	test("caps file count and total approved bytes", async () => {
		const workspace = scratch();
		await expect(buildAttachmentManifest(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => `f${index}`), {
			workspaceRoot: workspace,
			snapshotRoot: scratch(),
		})).rejects.toThrow("Attachment limit");
		writeFileSync(join(workspace, "large.bin"), Buffer.alloc(16));
		await expect(buildAttachmentManifest(["large.bin"], { workspaceRoot: workspace, snapshotRoot: scratch(), maxBytes: 8 })).rejects.toThrow("byte limit");
		expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(0);
	});
});

describe("verifiable structured findings", () => {
	const manifest: AttachmentManifest = {
		workspaceRoot: "/private/workspace",
		files: [{ path: "/private/snapshot/a.ts", relativePath: "a.ts", size: 12, sha256: "a".repeat(64), lineCount: 3 }],
		totalBytes: 12,
		sha256: "b".repeat(64),
		snapshotRoot: "/private/snapshot",
		snapshotId: "snapshot-test",
	};

	test("accepts evidence only against actual snapshotted names and physical line counts", () => {
		const report = parseReviewReport(JSON.stringify({
			verdict: "request_changes",
			summary: "one issue",
			findings: [{ severity: "high", claim: "bug", evidence: { file: "a.ts", lineStart: 2, lineEnd: 3 }, confidence: 0.9, remediation: "fix it" }],
			openQuestions: [],
		}), manifest);
		expect(report.findings[0].evidence.file).toBe("a.ts");
	});

	test("rejects unknown files, impossible lines, prose, and invalid confidence", () => {
		const base = { verdict: "request_changes", summary: "issue", openQuestions: [] };
		expect(() => parseReviewReport(JSON.stringify({ ...base, findings: [{ severity: "high", claim: "x", evidence: { file: "other.ts", lineStart: 1, lineEnd: 1 }, confidence: 1, remediation: "x" }] }), manifest)).toThrow("not snapshotted");
		expect(() => parseReviewReport(JSON.stringify({ ...base, findings: [{ severity: "high", claim: "x", evidence: { file: "a.ts", lineStart: 4, lineEnd: 4 }, confidence: 1, remediation: "x" }] }), manifest)).toThrow("outside");
		expect(() => parseReviewReport("looks good", manifest)).toThrow("structured review JSON");
		expect(() => parseReviewReport(JSON.stringify({ ...base, findings: [{ severity: "high", claim: "x", evidence: { file: "a.ts", lineStart: 1, lineEnd: 1 }, confidence: 2, remediation: "x" }] }), manifest)).toThrow();
	});
});

describe("confined durable records and ownership-aware locks", () => {
	test("blocks schema-v3 startup while legacy schema-v2 state remains", async () => {
		const parent = scratch();
		mkdirSync(join(parent, "runs"), { recursive: true });
		writeFileSync(join(parent, "runs", `run_${"a".repeat(32)}.json`), JSON.stringify({ version: 2 }));
		const store = new RunStore(join(parent, "v3"));
		await expect(store.init()).rejects.toThrow(/Legacy or unknown GPT-Control durable state/);
		await expect(store.init()).rejects.toThrow(/UPGRADE_V2/);
	});

	function records(root: string): { conversation: ConversationRecord; run: RunRecord } {
		const timestamp = nowIso();
		const conversation: ConversationRecord = {
			version: STORAGE_VERSION,
			id: `conv_${"1".repeat(32)}`,
			provider: "browser",
			workspaceRoot: root,
			policyFingerprint: "policy",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const manifest: AttachmentManifest = {
			workspaceRoot: root,
			files: [],
			totalBytes: 0,
			sha256: "0".repeat(64),
			snapshotRoot: join(root, "snapshots", "empty"),
			snapshotId: "empty",
		};
		const run: RunRecord = {
			version: STORAGE_VERSION,
			id: `run_${"2".repeat(32)}`,
			conversationId: conversation.id,
			kind: "chat",
			status: "running",
			executionReady: true,
			promptSha256: "3".repeat(64),
			attachmentManifest: manifest,
			receipt: {
				provider: "browser",
				promptSha256: "3".repeat(64),
				attachments: [],
				startedAt: timestamp,
				conversationId: conversation.id,
				runId: `run_${"2".repeat(32)}`,
			},
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		return { conversation, run };
	}

	test("uses strict complete-match public IDs and refuses traversal and encoded separators", async () => {
		const store = new RunStore(scratch());
		for (const id of ["../conv_" + "1".repeat(32), "conv_" + "1".repeat(32) + "/x", "conv_%2e%2e", "conv_" + "1".repeat(32) + "\\x", "conv_" + "1".repeat(31)]) {
			await expect(store.getConversation(id)).rejects.toThrow("Invalid conversation id");
		}
		for (const id of ["../run_" + "2".repeat(32), "run_" + "2".repeat(32) + ".json/../x", "run_%2f", "run_" + "2".repeat(32) + "\\x"]) {
			await expect(store.getRun(id)).rejects.toThrow("Invalid run id");
		}
	});

	test("refuses symlinked GPT_CONTROL_HOME and symlinked record files", async () => {
		const real = scratch();
		const parent = scratch();
		const linked = join(parent, "linked-home");
		symlinkSync(real, linked, "dir");
		await expect(new RunStore(linked).init()).rejects.toThrow("symlink");

		const root = scratch();
		const store = new RunStore(root);
		await store.init();
		const { run } = records(root);
		const outside = join(scratch(), "outside.json");
		writeFileSync(outside, JSON.stringify(run));
		symlinkSync(outside, join(root, "runs", `${run.id}.json`));
		await expect(store.getRun(run.id)).rejects.toThrow("unsafe record path");
	});

	test("terminal state is monotonic and late completion cannot overwrite cancellation", async () => {
		const root = scratch();
		const store = new RunStore(root);
		const { conversation, run } = records(root);
		await store.putConversation(conversation);
		await store.putRun(run);
		const cancelled = await store.updateRun(run.id, { status: "cancelled", error: "cancelled", completedAt: nowIso() });
		expect(cancelled.status).toBe("cancelled");
		const late = await store.updateRun(run.id, { status: "completed", resultText: "late answer" });
		expect(late.status).toBe("cancelled");
		expect(late.resultText).toBeUndefined();
	});

	test("a valid long-running owner keeps exclusivity past the stale threshold", async () => {
		const root = scratch();
		const one = new RunStore(root);
		const two = new RunStore(root);
		const conversationId = `conv_${"4".repeat(32)}`;
		let enteredSecond = false;
		const first = one.withConversationLock(conversationId, async () => {
			await new Promise((resolve) => setTimeout(resolve, 90));
			return "first";
		}, { staleMs: 20, heartbeatMs: 5, timeoutMs: 200 });
		await new Promise((resolve) => setTimeout(resolve, 35));
		await expect(two.withConversationLock(conversationId, async () => {
			enteredSecond = true;
		}, { staleMs: 20, heartbeatMs: 5, timeoutMs: 30, pollMs: 5 })).rejects.toThrow("live owner");
		expect(enteredSecond).toBe(false);
		expect(await first).toBe("first");
	});

	test("recovers an explicitly stale dead owner without stealing a live lease", async () => {
		const root = scratch();
		const store = new RunStore(root);
		await store.init();
		const conversationId = `conv_${"5".repeat(32)}`;
		const lock = join(root, "locks", `conversation-${conversationId}.lock`);
		mkdirSync(lock, { mode: 0o700 });
		writeFileSync(join(lock, "owner.json"), JSON.stringify({
			token: "dead",
			pid: 999999,
			hostname: hostname(),
			createdAt: "2000-01-01T00:00:00.000Z",
			heartbeatAt: "2000-01-01T00:00:00.000Z",
		}));
		const result = await store.withConversationLock(conversationId, async () => "recovered", { staleMs: 1, timeoutMs: 100, pollMs: 1 });
		expect(result).toBe("recovered");
	});
});
