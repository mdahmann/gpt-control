import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHATGPT_ORIGIN,
	captureOwnedScreenshot,
	createSession,
	extractChatPageObservation,
	extractComposerModel,
	openChat,
	selectAndVerifyChatGptModel,
	verifyChatGptModelBeforeSend,
	waitForOwnedChatReady,
} from "./src/chatgpt";
import { FakeChromeBridge, makeChromeService } from "./test_helpers";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-chrome-"));
	roots.push(root);
	return root;
}
const oldPoll = process.env.GPT_CONTROL_POLL_MS;
beforeEach(() => { process.env.GPT_CONTROL_POLL_MS = "1"; });
afterEach(() => {
	if (oldPoll === undefined) delete process.env.GPT_CONTROL_POLL_MS;
	else process.env.GPT_CONTROL_POLL_MS = oldPoll;
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function readyFake(options: ConstructorParameters<typeof FakeChromeBridge>[0] = {}) {
	const bridge = new FakeChromeBridge(options);
	const sessionId = await createSession(bridge.exec, bridge.launcher, "gpt-control:test");
	const tabId = await openChat(bridge.exec, bridge.launcher, sessionId, CHATGPT_ORIGIN);
	await waitForOwnedChatReady(bridge.exec, bridge.launcher, sessionId, tabId, { timeoutMs: 200 });
	return { bridge, sessionId, tabId };
}

describe("observed Chrome failures", () => {
	test("waits through the chrome://newtab first-tab race before any origin-gated action", async () => {
		const workspace = scratch();
		const state = scratch();
		const bridge = new FakeChromeBridge({ firstTabRaceReads: 3 });
		const { service } = makeChromeService(state, workspace, bridge);
		const result = await service.start({ kind: "subagent", prompt: "race check", chatgptModel: "pro", timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["race check"]);
		expect(bridge.unsafeOriginActions).toEqual([]);
	});

	test("never certifies transient Pro thinking text while Stop answering is active", async () => {
		const workspace = scratch();
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), workspace, bridge);
		const result = await service.start({ kind: "subagent", prompt: "[false-completion] real answer", timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(result.run.resultText).toBe("final:[false-completion] real answer");
		expect(result.run.resultText).not.toBe("Pro thinking");
		expect(result.run.receipt.resultSha256).toHaveLength(64);
	});

	test("restores the exact same conversation after reload lands on Home without resubmitting", async () => {
		const workspace = scratch();
		const bridge = new FakeChromeBridge({ reloadToHome: true, conversationRenderNeedsReload: true });
		const { service } = makeChromeService(scratch(), workspace, bridge);
		const result = await service.start({ kind: "subagent", prompt: "same chat recovery", timeoutMs: 1500 });
		expect(result.run.status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["same chat recovery"]);
		expect(result.run.receipt.providerConversationUrl).toMatch(/^https:\/\/chatgpt\.com\/c\//);
		expect(result.run.receipt.recoveryAttempts?.some((attempt) => attempt.action === "restore_conversation_url")).toBe(true);
	});

	test("recovers a network error by explicit live Retry without duplicate prompt submission", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "[network-recover] continue", timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(bridge.submittedPrompts).toHaveLength(1);
		expect(result.run.receipt.recoveryAttempts?.some((attempt) => attempt.action === "retry")).toBe(true);
	});
});

describe("truthful composer model provenance", () => {
	test("records already-selected Pro from the actual composer selector", async () => {
		const bridge = new FakeChromeBridge({ initialModel: "Pro" });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "already Pro", timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(result.run.receipt).toMatchObject({ requestedModel: "Pro", observedModel: "Pro", modelVerified: true, modelEvidenceKind: "composer_selector" });
	});

	test("switches from Auto to Pro and reads the live selector back", async () => {
		const bridge = new FakeChromeBridge({ initialModel: "Auto" });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "switch Pro", timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(result.run.receipt.observedModel).toBe("Pro");
		expect(bridge.calls.some((call) => call.args.includes("text=Pro"))).toBe(true);
	});

	test("does not infer composer selection from the Miles Pro account-plan label", () => {
		const observation = extractComposerModel('<main><div data-testid="account-plan">Miles Pro</div><form data-testid="composer"><button data-testid="model-switcher-dropdown-button" aria-label="Model selector">Auto</button><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation?.label).toBe("Auto");
		expect(observation?.normalized).toBe("auto");
	});

	test("fails closed when the selector is absent", async () => {
		const { bridge, tabId } = await readyFake({ modelSelectorAbsent: true });
		await expect(selectAndVerifyChatGptModel(bridge.exec, bridge.launcher, tabId, "pro", undefined, 10)).rejects.toThrow("selector is absent");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("fails closed when Pro is unavailable", async () => {
		const { bridge, tabId } = await readyFake({ initialModel: "Auto", modelAvailable: false });
		await expect(selectAndVerifyChatGptModel(bridge.exec, bridge.launcher, tabId, "pro", undefined, 10)).rejects.toThrow("unavailable");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("fails closed on selector read-back mismatch", async () => {
		const { bridge, tabId } = await readyFake({ initialModel: "Auto", modelReadbackMismatch: true });
		await expect(selectAndVerifyChatGptModel(bridge.exec, bridge.launcher, tabId, "pro", undefined, 10)).rejects.toThrow("read-back mismatch");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("re-verifies immediately before send and refuses a model change", async () => {
		const bridge = new FakeChromeBridge({ initialModel: "Pro", modelChangesBeforeSend: true });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "must not send", timeoutMs: 500 });
		expect(result.run.status).toBe("failed");
		expect(result.run.error).toContain("changed before send");
		expect(bridge.submittedPrompts).toEqual([]);
	});
});

describe("honest terminal state and owned-tab boundaries", () => {
	test("persistent network errors exhaust bounded recovery as needs_user and never become completed later", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "[network-persistent] blocked", timeoutMs: 250 });
		expect(result.run.status).toBe("needs_user");
		expect(result.run.error).toMatch(/Recovery budget exhausted|Network error/);
		expect(bridge.submittedPrompts).toHaveLength(1);
		const late = await service.store.updateRun(result.run.id, { status: "completed", resultText: "late answer" });
		expect(late.status).toBe("needs_user");
		expect(late.resultText).toBeUndefined();
	});

	test("persistent Continue generating is a bounded input-required blocker, not a partial completion", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "[input-required] more", timeoutMs: 250 });
		expect(result.run.status).toBe("needs_user");
		expect(result.run.resultText).toBeUndefined();
		expect(result.run.error).toMatch(/Continue|Recovery budget exhausted/i);
		expect(bridge.submittedPrompts).toHaveLength(1);
	});

	test("a timeout remains needs_user even when the page later displays a final answer", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "[slow] timeout", timeoutMs: 40 });
		expect(result.run.status).toBe("needs_user");
		bridge.forceFinal();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await service.getRun(result.run.id)).status).toBe("needs_user");
	});

	test("uploads only broker-owned snapshots and never exposes prompt or original paths in argv", async () => {
		const workspace = scratch();
		const state = scratch();
		const original = join(workspace, "source.txt");
		writeFileSync(original, "approved bytes\n");
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(state, workspace, bridge);
		const prompt = "sensitive prompt body";
		const result = await service.start({ kind: "subagent", prompt, files: ["source.txt"], timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(bridge.uploadedFiles).toHaveLength(1);
		expect(bridge.uploadedFiles[0][0]).toStartWith(join(state, "snapshots"));
		expect(bridge.uploadedFiles[0][0]).not.toBe(original);
		const argv = bridge.calls.flatMap((call) => call.args).join(" ");
		expect(argv).not.toContain(prompt);
		expect(argv).not.toContain(original);
	});

	test("image fallback rechecks session ownership and current ChatGPT origin", async () => {
		const { bridge, sessionId, tabId } = await readyFake();
		bridge.setUrl("https://evil.invalid/");
		await expect(captureOwnedScreenshot(bridge.exec, bridge.launcher, sessionId, tabId, join(scratch(), "shot.png"))).rejects.toThrow("outside https://chatgpt.com");
		const foreignBridge = new FakeChromeBridge({ foreignSession: true });
		const foreignSessionId = await createSession(foreignBridge.exec, foreignBridge.launcher, "gpt-control:test");
		const foreignTabId = await openChat(foreignBridge.exec, foreignBridge.launcher, foreignSessionId, CHATGPT_ORIGIN);
		await expect(captureOwnedScreenshot(foreignBridge.exec, foreignBridge.launcher, foreignSessionId, foreignTabId, join(scratch(), "foreign.png"))).rejects.toThrow("foreign Chrome Bridge session");
	});

	test("active UI indicators prevent a markdown assistant turn from being final", () => {
		const observation = extractChatPageObservation('<main><div data-message-author-role="assistant"><div class="markdown"><p>partial</p></div></div><button data-testid="stop-button" aria-label="Stop answering">Stop</button><div role="status">Running tool</div><form data-testid="composer"><button data-testid="model-switcher-dropdown-button">Pro</button><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation.snapshot.text).toBe("partial");
		expect(observation.answering).toBe(true);
		expect(observation.toolRunning).toBe(true);
	});
});
