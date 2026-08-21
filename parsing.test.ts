import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachmentManifest, isSensitive, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "./src/files";
import { parseReviewReport } from "./src/review";
import { RunStore } from "./src/store";
import { STORAGE_VERSION, type ConversationRecord } from "./src/domain";
import { countAssistantTurns, extractAssistantTurn } from "./src/chatgpt";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-test-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("attachment manifest", () => {
	test("realpath-resolves relative files and records size and hashes", async () => {
		const root = scratch();
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		const manifest = await buildAttachmentManifest(["a.ts"], { workspaceRoot: root });
		expect(manifest.files[0]).toMatchObject({ relativePath: "a.ts", size: 20 });
		expect(manifest.files[0].sha256).toHaveLength(64);
		expect(manifest.sha256).toHaveLength(64);
	});

	test("rejects a symlink escape from the workspace", async () => {
		const root = scratch();
		const outside = scratch();
		writeFileSync(join(outside, "secret.txt"), "outside");
		symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
		await expect(buildAttachmentManifest(["link.txt"], { workspaceRoot: root })).rejects.toThrow("outside workspace");
	});

	test("requires explicit flags for outside and sensitive files", async () => {
		const root = scratch();
		const outside = scratch();
		writeFileSync(join(outside, ".env"), "KEY=value\n");
		await expect(buildAttachmentManifest([join(outside, ".env")], { workspaceRoot: root, allowOutsideWorkspace: true })).rejects.toThrow("sensitive");
		const manifest = await buildAttachmentManifest([join(outside, ".env")], { workspaceRoot: root, allowOutsideWorkspace: true, allowSensitiveFiles: true });
		expect(manifest.files).toHaveLength(1);
	});

	test("caps file count and aggregate bytes", async () => {
		const root = scratch();
		await expect(buildAttachmentManifest(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `f${i}`), { workspaceRoot: root })).rejects.toThrow("Attachment limit");
		writeFileSync(join(root, "large.bin"), Buffer.alloc(16));
		await expect(buildAttachmentManifest(["large.bin"], { workspaceRoot: root, maxBytes: 8 })).rejects.toThrow("byte limit");
		expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(0);
	});

	test("blocks obvious credential paths", () => {
		expect(isSensitive("/home/me/.ssh/id_ed25519")).toBe(true);
		expect(isSensitive("/repo/src/index.ts")).toBe(false);
	});
});

describe("structured review", () => {
	test("validates findings and evidence ranges", () => {
		const report = parseReviewReport(JSON.stringify({
			verdict: "request_changes",
			summary: "one issue",
			findings: [{ severity: "high", claim: "bug", evidence: { file: "a.ts", lineStart: 2, lineEnd: 3 }, confidence: 0.9, remediation: "fix it" }],
			openQuestions: [],
		}));
		expect(report.findings[0].evidence.file).toBe("a.ts");
	});

	test("rejects prose and invalid confidence", () => {
		expect(() => parseReviewReport("looks good")).toThrow("structured review JSON");
		expect(() => parseReviewReport(JSON.stringify({ verdict: "approve", summary: "ok", findings: [{ severity: "high", claim: "x", evidence: { file: "a", lineStart: 1, lineEnd: 1 }, confidence: 2, remediation: "x" }], openQuestions: [] }))).toThrow();
	});
});

describe("durable store", () => {
	test("round-trips a conversation and excludes arbitrary JSON", async () => {
		const store = new RunStore(scratch());
		await store.init();
		const now = new Date().toISOString();
		const conversation: ConversationRecord = { version: STORAGE_VERSION, id: `conv_${"a".repeat(32)}`, provider: "browser", workspaceRoot: "/tmp", createdAt: now, updatedAt: now };
		await store.putConversation(conversation);
		expect(await store.getConversation(conversation.id)).toEqual(conversation);
		writeFileSync(join(store.root, "conversations", "conv_bad.json"), '{"id":"conv_bad"}');
		await expect(store.getConversation("conv_bad")).rejects.toThrow();
	});

	test("serializes runs per conversation", async () => {
		const store = new RunStore(scratch());
		const order: string[] = [];
		let release!: () => void;
		let acquired!: () => void;
		const held = new Promise<void>((done) => { release = done; });
		const entered = new Promise<void>((done) => { acquired = done; });
		const first = store.withConversationLock("conv_lock", async () => {
			order.push("first-start");
			acquired();
			await held;
			order.push("first-end");
		});
		await entered;
		const second = store.withConversationLock("conv_lock", async () => {
			order.push("second-start");
		});
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "first-end", "second-start"]);
	});
});

describe("assistant snapshots", () => {
	test("extracts only the latest assistant message node", () => {
		const html = '<div data-message-author-role="assistant"><div class="markdown"><p>old</p></div></div><div data-message-author-role="assistant"><div class="markdown"><p>new</p></div><button>Copy</button></div><footer>ChatGPT can make mistakes</footer>';
		expect(countAssistantTurns(html)).toBe(2);
		expect(extractAssistantTurn(html).text).toBe("new");
	});
});
