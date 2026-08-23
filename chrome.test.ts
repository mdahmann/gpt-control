import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHATGPT_ORIGIN,
	canonicalPromptObservationText,
	captureOwnedScreenshot,
	clickSend,
	createSession,
	discoverChatGptModels,
	discoverChatGptProjects,
	extractChatPageObservation,
	extractConversationTurns,
	extractComposerModel,
	fillPrompt,
	openChat,
	providerConversationIdentity,
	selectAndVerifyChatGptModel,
	tabUrl,
	verifyChatGptModelBeforeSend,
	waitForCompletedAssistantTurn,
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
	test("dismisses a visible ChatGPT rate-limit notice, cools down, and submits exactly once", async () => {
		const bridge = new FakeChromeBridge({
			rateLimitNotice: true,
			currentEffortPicker: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol"],
			availableEfforts: ["High", "Pro"],
		});
		const { service } = makeChromeService(scratch(), scratch(), bridge, {
			rateLimitBaseDelayMs: 1,
			rateLimitMaxDelayMs: 4,
		});
		const result = await service.start({
			kind: "subagent",
			prompt: "recover after rate limit",
			chatgptModel: "GPT-5.6 Sol",
			chatgptEffort: "Pro",
			timeoutMs: 1000,
		});
		expect(result.run.status).toBe("completed");
		expect(bridge.dismissedRateLimits).toHaveLength(1);
		expect(bridge.submittedPrompts).toEqual(["recover after rate limit"]);
		expect(result.run.diagnostics).toMatchObject({ rateLimitEvents: 1 });
	});

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

	test("restores conversation A after the owned page drifts to valid conversation B", async () => {
		const bridge = new FakeChromeBridge({ driftToDifferentConversation: true });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "wrong conversation recovery", timeoutMs: 1500 });
		expect(result.run.status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["wrong conversation recovery"]);
		expect(result.run.receipt.providerConversationUrl).toMatch(/^https:\/\/chatgpt\.com\/c\/fake-/);
		expect(result.run.receipt.providerConversationUrl).not.toContain("foreign-");
		expect(result.run.receipt.recoveryAttempts).toContainEqual(expect.objectContaining({
			action: "restore_conversation_url",
			outcome: "recovered",
			reason: expect.stringContaining("different ChatGPT conversation"),
		}));
	});

	test("legacy completion helper also refuses to adopt a different valid conversation", async () => {
		const { bridge, sessionId, tabId } = await readyFake({ driftToDifferentConversation: true });
		await fillPrompt(bridge.exec, bridge.launcher, tabId, "legacy exact recovery");
		await clickSend(bridge.exec, bridge.launcher, tabId);
		const exactUrl = await tabUrl(bridge.exec, bridge.launcher, tabId);
		expect(exactUrl).toMatch(/^https:\/\/chatgpt\.com\/c\/fake-/);
		const outcome = await waitForCompletedAssistantTurn(bridge.exec, bridge.launcher, sessionId, tabId, {
			baselineCount: 0,
			conversationUrl: exactUrl,
			timeoutMs: 1000,
			intervalMs: 1,
			stableRounds: 1,
		});
		expect(outcome.terminalStatus).toBe("completed");
		expect(outcome.providerConversationUrl).toBe(exactUrl);
		expect(outcome.providerConversationUrl).not.toContain("foreign-");
		expect(outcome.recoveryAttempts).toContainEqual(expect.objectContaining({
			action: "restore_conversation_url",
			outcome: "recovered",
		}));
		expect(bridge.submittedPrompts).toEqual(["legacy exact recovery"]);
	});

	test("accepts a ChatGPT project conversation URL as the same canonical conversation", async () => {
		const projectUrl = "https://chatgpt.com/g/project-sequence/c/project-conversation-1";
		expect(providerConversationIdentity(projectUrl)).toEqual({
			id: "project-conversation-1",
			url: "https://chatgpt.com/c/project-conversation-1",
		});
		const bridge = new FakeChromeBridge({ attachRedirectUrl: projectUrl });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const attached = await service.attachConversation({ conversationUrl: projectUrl, timeoutMs: 200 });
		const result = await service.start({
			kind: "chat",
			conversationId: attached.id,
			prompt: "follow up in the project chat",
			timeoutMs: 1000,
		});
		expect(result.run.status).toBe("completed");
		expect(result.run.receipt.providerConversationUrl).toBe("https://chatgpt.com/c/project-conversation-1");
		expect(bridge.submittedPrompts).toEqual(["follow up in the project chat"]);
	});

	test("returns needs_user instead of retrying a provider turn that may have external side effects", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "[network-recover] continue", timeoutMs: 1000 });
		expect(result.run.status).toBe("needs_user");
		expect(result.run.error).toContain("Automatic Retry is disabled");
		expect(bridge.submittedPrompts).toHaveLength(1);
		expect(bridge.calls.some((call) => call.args.includes("text=Retry"))).toBe(false);
	});
});

describe("truthful composer model provenance", () => {
	test("discovers the native desktop picker and project action labels", async () => {
		const { bridge, tabId } = await readyFake({
			currentEffortPicker: true,
			desktopPickerMarkup: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol", "GPT-5.5"],
			availableEfforts: ["Instant", "Medium", "High", "Extra High", "Pro"],
			availableProjects: ["Projects", "Sequence"],
		});
		const catalog = await discoverChatGptModels(bridge.exec, bridge.launcher, tabId, undefined, 200);
		expect(catalog).toMatchObject({
			currentModel: "GPT-5.6 Sol",
			currentEffort: "Pro",
			models: [{ label: "GPT-5.6 Sol" }, { label: "GPT-5.5" }],
			efforts: [{ label: "Instant" }, { label: "Medium" }, { label: "High" }, { label: "Extra High" }, { label: "Pro" }],
		});
		expect(await discoverChatGptProjects(bridge.exec, bridge.launcher, tabId, undefined, 200)).toMatchObject({
			projects: [{ name: "Projects" }, { name: "Sequence" }],
		});
	});

	test("discovers the live underlying models and effort levels without sending", async () => {
		const bridge = new FakeChromeBridge({
			currentEffortPicker: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol", "GPT-5.5", "o3"],
			availableEfforts: ["Instant", "Medium", "High", "Extra High", "Pro"],
		});
		const driver = bridge.capabilities().browser?.driver;
		if (!driver) throw new Error("fake browser driver unavailable");
		const session = await driver.create("gpt-control:catalog", CHATGPT_ORIGIN);
		const catalog = await driver.discoverModels(session);
		expect(catalog).toMatchObject({
			currentModel: "GPT-5.6 Sol",
			currentEffort: "Pro",
			models: [{ label: "GPT-5.6 Sol" }, { label: "GPT-5.5" }, { label: "o3" }],
			efforts: [{ label: "Instant" }, { label: "Medium" }, { label: "High" }, { label: "Extra High" }, { label: "Pro" }],
		});
		expect(bridge.submittedPrompts).toEqual([]);
		const pickerRowClicks = bridge.privateRequests.filter((request) => request.action === "click" && /picker-(model|effort)/.test(String(request.payload.selector)));
		expect(pickerRowClicks.length).toBeGreaterThanOrEqual(2);
		expect(pickerRowClicks.every((request) => request.payload.expectedTarget !== undefined)).toBe(true);
		const pickerKeyRequests = bridge.privateRequests.filter((request) => request.action === "press" && request.payload.key === "ArrowLeft");
		expect(pickerKeyRequests).toHaveLength(1);
		expect(pickerKeyRequests[0].payload.expectedTarget).toBeUndefined();
		expect(bridge.privateRequests.filter((request) => request.action === "ping").length).toBeGreaterThanOrEqual(2);
	});

	test("ignores a retained inactive advanced picker before opening the live picker", async () => {
		const bridge = new FakeChromeBridge({
			currentEffortPicker: true,
			retainedInactiveAdvancedView: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol", "GPT-5.5"],
			availableEfforts: ["High", "Pro"],
		});
		const driver = bridge.capabilities().browser?.driver;
		if (!driver) throw new Error("fake browser driver unavailable");
		const session = await driver.create("gpt-control:inactive-picker", CHATGPT_ORIGIN);
		const catalog = await driver.discoverModels(session);
		expect(catalog.currentModel).toBe("GPT-5.6 Sol");
		expect(catalog.currentEffort).toBe("Pro");
		expect(catalog.models.map((option) => option.label)).toEqual(["GPT-5.6 Sol", "GPT-5.5"]);
		expect(bridge.privateRequests.some((request) => request.action === "click" && String(request.payload.selector).includes("Show advanced options"))).toBe(true);
	});

	test("reuses the proven advanced rows when the composer label is transiently hidden by a submenu", async () => {
		const bridge = new FakeChromeBridge({
			currentEffortPicker: true,
			hideComposerModelWhenSubmenuOpen: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol", "GPT-5.5"],
			availableEfforts: ["High", "Pro"],
		});
		const driver = bridge.capabilities().browser?.driver;
		if (!driver) throw new Error("fake browser driver unavailable");
		const session = await driver.create("gpt-control:transient-composer-label", CHATGPT_ORIGIN);
		const catalog = await driver.discoverModels(session);
		expect(catalog.models.map((option) => option.label)).toEqual(["GPT-5.6 Sol", "GPT-5.5"]);
		expect(catalog.efforts.map((option) => option.label)).toEqual(["High", "Pro"]);
	});

	test("waits for the model pill after the fresh composer becomes ready", async () => {
		const bridge = new FakeChromeBridge({
			currentEffortPicker: true,
			modelSelectorDelayReads: 4,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol"],
			availableEfforts: ["High", "Pro"],
		});
		const driver = bridge.capabilities().browser?.driver;
		if (!driver) throw new Error("fake browser driver unavailable");
		const session = await driver.create("gpt-control:delayed-model-pill", CHATGPT_ORIGIN);
		const catalog = await driver.discoverModels(session);
		expect(catalog.currentModel).toBe("GPT-5.6 Sol");
		expect(catalog.currentEffort).toBe("Pro");
	});

	test("switches the underlying model and effort and verifies both before sending", async () => {
		const bridge = new FakeChromeBridge({
			currentEffortPicker: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol", "GPT-5.5"],
			availableEfforts: ["Instant", "High", "Pro"],
		});
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({
			kind: "chat",
			prompt: "use exact live selection",
			chatgptModel: "GPT-5.6 Sol",
			chatgptEffort: "High",
			timeoutMs: 1000,
		});
		expect(result.run.status).toBe("completed");
		expect(result.run.receipt).toMatchObject({
			requestedModel: "GPT-5.6 Sol",
			observedModel: "GPT-5.6 Sol",
			requestedEffort: "High",
			observedEffort: "High",
			modelVerified: true,
		});
		expect(bridge.submittedPrompts).toEqual(["use exact live selection"]);
	});

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
		expect(bridge.privateRequests.some((request) => request.action === "click" && request.payload.selector === "role=menuitem[name=Pro]")).toBe(true);
	});

	test("switches the current Instant effort picker to Pro through Advanced", async () => {
		const bridge = new FakeChromeBridge({ initialModel: "Instant", currentEffortPicker: true });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.start({ kind: "subagent", prompt: "switch current picker to Pro", timeoutMs: 1000 });
		expect(result.run.status).toBe("completed");
		expect(result.run.receipt.observedModel).toBe("Pro");
		expect(bridge.privateRequests.filter((request) => request.action === "click").map((request) => request.payload.selector)).toEqual(expect.arrayContaining([
			'[id="radix-picker"]',
			'[aria-label="Show advanced options"]',
			'[id="picker-effort"]',
			'role=menuitemradio[name=Pro]',
		]));
	});

	test("does not infer composer selection from the Miles Pro account-plan label", () => {
		const observation = extractComposerModel('<main><div data-testid="account-plan">Miles Pro</div><form data-testid="composer"><button data-testid="model-switcher-dropdown-button" aria-label="Model selector">Auto</button><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation?.label).toBe("Auto");
		expect(observation?.normalized).toBe("auto");
	});

	test("accepts the current composer Pro pill without adopting the account plan label", () => {
		const observation = extractComposerModel('<main><button aria-label="Miles Pro, open profile menu">Miles Pro</button><form data-testid="composer"><div id="prompt-textarea" contenteditable="true"></div><button id="radix-model-live" aria-haspopup="menu"><span>Pro</span></button></form></main>');
		expect(observation).toMatchObject({ label: "Pro", normalized: "pro", selector: '[id="radix-model-live"]' });
	});

	test("accepts the current fresh-chat Pro pill in the live composer layout", () => {
		const observation = extractComposerModel('<main><form class="group/composer"><div class="composer-shell"><div id="prompt-textarea" contenteditable="true"></div><div class="trailing"><button id="radix-fresh-model" aria-haspopup="menu" aria-expanded="false"><span class="uFxlGa_SliderTriggerChatSelectionLabel">Pro</span></button></div></div></form></main>');
		expect(observation).toMatchObject({ label: "Pro", normalized: "pro", selector: '[id="radix-fresh-model"]' });
	});

	test("does not accept an Upgrade to Pro action as selected-model evidence", () => {
		const observation = extractComposerModel('<form data-testid="composer"><button data-testid="model-switcher-dropdown-button" aria-label="Upgrade to Pro">Upgrade to Pro</button><div id="prompt-textarea" contenteditable="true"></div></form>');
		expect(observation?.label).toBe("Upgrade to Pro");
		expect(observation?.normalized).toBe("upgrade to pro");
	});

	test("accepts a versioned Pro model label without accepting action text", () => {
		const observation = extractComposerModel('<form data-testid="composer"><button data-testid="model-switcher-dropdown-button">GPT-5.6 Sol Pro</button><div id="prompt-textarea" contenteditable="true"></div></form>');
		expect(observation?.normalized).toBe("pro");
	});

	test("refuses a stale session URL before a browser mutation", async () => {
		const bridge = new FakeChromeBridge();
		const driver = bridge.capabilities().browser?.driver;
		if (!driver) throw new Error("fake browser driver unavailable");
		const created = await driver.create("gpt-control:stale", CHATGPT_ORIGIN);
		bridge.setUrl("https://chatgpt.com/c/foreign");
		await expect(driver.fill(created, "must not disclose")).rejects.toThrow("drifted");
		expect(bridge.privateRequests).toEqual([]);
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("uses a refreshed exact conversation URL for a safe follow-up turn", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const first = await service.start({ kind: "chat", prompt: "first exact turn", timeoutMs: 1000 });
		expect(first.run.status).toBe("completed");
		const second = await service.start({
			kind: "chat",
			prompt: "second exact turn",
			conversationId: first.conversation.id,
			timeoutMs: 1000,
		});
		expect(second.run.status).toBe("completed");
		expect(bridge.submittedPrompts).toEqual(["first exact turn", "second exact turn"]);
		expect(second.run.receipt.providerConversationUrl).toBe(first.run.receipt.providerConversationUrl);
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

describe("ChatGPT organization controls", () => {
	test("pins a direct GPT Worker as soon as its exact provider conversation exists", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({ kind: "subagent", prompt: "visible worker", timeoutMs: 1000 });
		expect(started.run.status).toBe("completed");
		expect((await service.store.getConversation(started.conversation.id)).providerPinned).toBe(true);
	});

	test("normalizes and verifies one live SEQ-prefixed GPT Worker title", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "titled worker",
			title: "Teach Reliability",
			projectId: "SEQ",
			timeoutMs: 1000,
		});
		expect(started.run.status).toBe("completed");
		expect(started.run.requestedProviderTitle).toBe("SEQ: Teach Reliability");
		expect(started.run.receipt).toMatchObject({
			requestedTitle: "SEQ: Teach Reliability",
			observedTitle: "SEQ: Teach Reliability",
			titleVerified: true,
		});
		expect((await service.store.getConversation(started.conversation.id)).providerTitle).toBe("SEQ: Teach Reliability");
	});

	test("does not duplicate an existing SEQ worker-title prefix", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "already prefixed",
			title: "seq: Timing Contract",
			projectId: "seq",
			timeoutMs: 1000,
		});
		expect(started.run.receipt.observedTitle).toBe("SEQ: Timing Contract");
	});

	test("keeps a plain worker title when no project identifier is supplied", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "subagent",
			prompt: "generic worker",
			title: "Independent research",
			timeoutMs: 1000,
		});
		expect(started.run.receipt.observedTitle).toBe("Independent research");
	});

	test("pins an ordinary chat only when requested", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({ kind: "chat", prompt: "pin this chat", pinChat: true, timeoutMs: 1000 });
		expect((await service.store.getConversation(started.conversation.id)).providerPinned).toBe(true);
	});

	test("discovers the live project names without sending a prompt", async () => {
		const bridge = new FakeChromeBridge({ availableProjects: ["Health", "Zenbox", "Sequence"] });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const result = await service.listProjects({ refresh: true });
		expect(result.projects).toEqual([{ name: "Health" }, { name: "Zenbox" }, { name: "Sequence" }]);
		expect(result.cacheStatus).toBe("refreshed");
		expect(bridge.submittedPrompts).toEqual([]);
	});

	test("ordinary catalog reads use durable cache without opening ChatGPT", async () => {
		const root = scratch();
		const workspace = scratch();
		const firstBridge = new FakeChromeBridge({
			currentEffortPicker: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol", "GPT-5.6 Spark"],
			availableEfforts: ["High", "Pro"],
			availableProjects: ["Sequence", "Zenbox"],
		});
		const first = makeChromeService(root, workspace, firstBridge).service;
		const modelRefresh = await first.listModels({ refresh: true });
		const projectRefresh = await first.listProjects({ refresh: true });
		expect(modelRefresh.cacheStatus).toBe("refreshed");
		expect(projectRefresh.cacheStatus).toBe("refreshed");

		const secondBridge = new FakeChromeBridge();
		const second = makeChromeService(root, workspace, secondBridge).service;
		const cachedModels = await second.listModels();
		const cachedProjects = await second.listProjects();
		expect(cachedModels).toMatchObject({
			cacheStatus: "hit",
			models: [{ label: "GPT-5.6 Sol" }, { label: "GPT-5.6 Spark" }],
			efforts: [{ label: "High" }, { label: "Pro" }],
		});
		expect(cachedProjects).toMatchObject({
			cacheStatus: "hit",
			projects: [{ name: "Sequence" }, { name: "Zenbox" }],
		});
		expect(secondBridge.calls).toEqual([]);
		expect(secondBridge.activeTabs()).toEqual([]);
	});

	test("a cache miss is explicit and does not open ChatGPT", async () => {
		const bridge = new FakeChromeBridge();
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		expect(await service.listModels()).toMatchObject({
			cacheStatus: "miss",
			refreshRequired: true,
			models: [],
			efforts: [],
		});
		expect(await service.listProjects()).toMatchObject({
			cacheStatus: "miss",
			refreshRequired: true,
			projects: [],
		});
		expect(bridge.calls).toEqual([]);
		expect(bridge.activeTabs()).toEqual([]);
	});

	test("coalesces simultaneous explicit model refreshes into one temporary tab", async () => {
		const root = scratch();
		const workspace = scratch();
		const catalogOptions = {
			currentEffortPicker: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "Pro",
			availableModels: ["GPT-5.6 Sol"],
			availableEfforts: ["High", "Pro"],
		};
		const bridgeA = new FakeChromeBridge(catalogOptions);
		const bridgeB = new FakeChromeBridge(catalogOptions);
		const serviceA = makeChromeService(root, workspace, bridgeA).service;
		const serviceB = makeChromeService(root, workspace, bridgeB).service;
		const [first, second] = await Promise.all([
			serviceA.listModels({ refresh: true }),
			serviceB.listModels({ refresh: true }),
		]);
		expect(first.cacheStatus).toBe("refreshed");
		expect(second.cacheStatus).toBe("refreshed");
		const creates = [...bridgeA.calls, ...bridgeB.calls]
			.filter((call) => call.args[0] === "taskSession" && call.args[1] === "create");
		expect(creates).toHaveLength(1);
		expect(bridgeA.activeTabs()).toEqual([]);
		expect(bridgeB.activeTabs()).toEqual([]);
	});

	test("pins, renames, moves, and archives one exact owned conversation with read-back", async () => {
		const bridge = new FakeChromeBridge({ availableProjects: ["Zenbox", "Sequence"] });
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({ kind: "chat", prompt: "organization target", timeoutMs: 1000 });
		const conversationId = started.conversation.id;
		expect(await service.manageConversation(conversationId, { action: "pin" })).toMatchObject({ pinned: true });
		expect(await service.manageConversation(conversationId, { action: "rename", title: "Controlled greeting" })).toMatchObject({ title: "Controlled greeting" });
		expect(await service.manageConversation(conversationId, { action: "move", project: "Zenbox" })).toMatchObject({ project: "Zenbox" });
		expect(await service.manageConversation(conversationId, { action: "archive" })).toMatchObject({ archived: true });
		expect((await service.store.getConversation(conversationId)).closedAt).toBeDefined();
	});

	test("proves native project membership, removes the chat from its project, and then archives it", async () => {
		const bridge = new FakeChromeBridge({
			availableProjects: ["Zenbox", "Sequence"],
			desktopOrganizationMarkup: true,
		});
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({ kind: "chat", prompt: "native organization target", timeoutMs: 1000 });
		const conversationId = started.conversation.id;
		expect(await service.manageConversation(conversationId, { action: "move", project: "Zenbox" })).toMatchObject({ project: "Zenbox" });
		expect(await service.manageConversation(conversationId, { action: "archive" })).toMatchObject({ archived: true });
		expect((await service.store.getConversation(conversationId)).closedAt).toBeDefined();
	});

	test("reports passive exact-conversation status without sending another prompt", async () => {
		const bridge = new FakeChromeBridge({
			currentEffortPicker: true,
			initialUnderlyingModel: "GPT-5.6 Sol",
			initialModel: "High",
			availableModels: ["GPT-5.6 Sol"],
			availableEfforts: ["High"],
		});
		const { service } = makeChromeService(scratch(), scratch(), bridge);
		const started = await service.start({
			kind: "chat",
			prompt: "status target",
			chatgptModel: "GPT-5.6 Sol",
			chatgptEffort: "High",
			timeoutMs: 1000,
		});
		const status = await service.conversationStatus(started.conversation.id);
		expect(status).toMatchObject({
			conversationId: started.conversation.id,
			providerConversationUrl: started.run.receipt.providerConversationUrl,
			state: "idle",
			assistantTurnCount: 1,
			requestedModel: "GPT-5.6 Sol",
			observedModel: "GPT-5.6 Sol",
			requestedEffort: "High",
			observedEffort: "High",
		});
		expect(bridge.submittedPrompts).toEqual(["status target"]);
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
		await service.retryRequestedProviderStops();
		const stopped = await service.getRun(result.run.id);
		expect(stopped.providerTurnPending).toBe(false);
		expect(stopped.providerStopRequested).toBe(false);
		expect(bridge.stopClicks).toHaveLength(1);
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
		await expect(captureOwnedScreenshot(foreignBridge.exec, foreignBridge.launcher, foreignSessionId, foreignTabId, join(scratch(), "foreign.png"))).rejects.toThrow(/foreign|renamed/);
	});

	test("active UI indicators prevent a markdown assistant turn from being final", () => {
		const observation = extractChatPageObservation('<main><div data-message-author-role="assistant"><div class="markdown"><p>partial</p></div></div><button data-testid="stop-button" aria-label="Stop answering">Stop</button><div role="status">Running tool</div><form data-testid="composer"><button data-testid="model-switcher-dropdown-button">Pro</button><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation.snapshot.text).toBe("partial");
		expect(observation.answering).toBe(true);
		expect(observation.toolRunning).toBe(true);
	});

	test("treats the live Stop streaming aria-label as an active generation", () => {
		const observation = extractChatPageObservation('<main><div data-message-author-role="assistant"><div class="markdown"><p>partial stream</p></div></div><button aria-label="Stop streaming">Square icon</button><form data-testid="composer"><button data-testid="model-switcher-dropdown-button">Pro</button><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation.snapshot.text).toBe("partial stream");
		expect(observation.answering).toBe(true);
		expect(observation.stateSummary).toContain("answering");
	});

	test("retains visible-text Stop generating detection without an aria-label", () => {
		const observation = extractChatPageObservation('<main><div data-message-author-role="assistant"><div class="markdown"><p>partial visible control</p></div></div><button>Stop generating</button><form data-testid="composer"><button data-testid="model-switcher-dropdown-button">Pro</button><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation.answering).toBe(true);
	});

	test("does not treat unrelated Stop recording controls as generation", () => {
		const observation = extractChatPageObservation('<main><div data-message-author-role="assistant"><div class="markdown"><p>complete answer</p></div></div><button aria-label="Stop recording">Voice</button><form data-testid="composer"><button data-testid="model-switcher-dropdown-button">Pro</button><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation.answering).toBe(false);
	});

	test("observes native ChatGPT Desktop user and assistant turns", () => {
		const observation = extractChatPageObservation(`<main>
			<div data-content-search-unit-key="fallback-turn-0:0:user">
				<div data-user-message-bubble="true"><div class="text-size-chat whitespace-pre-wrap"><div class="_MarkdownRoot_native"><p>desktop question</p></div></div></div>
			</div>
			<div data-content-search-unit-key="fallback-turn-0:2:assistant">
				<span>ChatGPT said:</span><div class="_MarkdownRoot_native"><p>desktop answer</p></div>
			</div>
			<div contenteditable="true" aria-label="Message ChatGPT"></div>
		</main>`);
		expect(observation.snapshot).toMatchObject({ count: 1, text: "desktop answer", hasMarkdown: true });
		expect(observation.latestUserPromptSha256).toBe(createHash("sha256").update("desktop question").digest("hex"));
		expect(observation.composerReady).toBe(true);
	});

	test("reads only the bounded newest visible turns from an attached desktop conversation", () => {
		const turns = extractConversationTurns(`<main>
			<div data-content-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble="true"><div class="_MarkdownRoot_native"><p>first question</p></div></div></div>
			<div data-content-search-unit-key="fallback-turn-0:1:assistant"><div class="_MarkdownRoot_native"><p>first answer</p></div></div>
			<div data-content-search-unit-key="fallback-turn-0:2:user"><div data-user-message-bubble="true"><div class="_MarkdownRoot_native"><p>second question</p></div></div></div>
			<div data-content-search-unit-key="fallback-turn-0:3:assistant"><div class="_MarkdownRoot_native"><p>second answer</p></div></div>
		</main>`, 2);
		expect(turns).toEqual([
			{ role: "user", text: "second question", messageId: "fallback-turn-0:2:user" },
			{ role: "assistant", text: "second answer", messageId: "fallback-turn-0:3:assistant" },
		]);
	});

	test("uses the native ChatGPT Desktop Send control", async () => {
		const attempts: string[] = [];
		const exec = async (_command: string, args: string[]) => {
			const selector = args[2] ?? "";
			attempts.push(selector);
			const success = selector === 'button[aria-label="Send"]';
			return {
				stdout: JSON.stringify(success ? { success: true, result: {} } : { success: false, error: `No element found: ${selector}` }),
				stderr: success ? "" : `No element found: ${selector}`,
				code: success ? 0 : 1,
				killed: false,
			};
		};
		await clickSend(exec, { command: "desktop-test", args: [], origin: "desktop test" }, 1);
		expect(attempts.at(-1)).toBe('button[aria-label="Send"]');
	});

	test("hashes bounded browser-visible tool cards without treating them as trusted output", () => {
		const observation = extractChatPageObservation('<main><div data-testid="tool-result-card">Zenbox computer_overview host zenbox-vm</div><form><div id="prompt-textarea" contenteditable="true"></div></form></main>');
		expect(observation.visibleToolCards).toHaveLength(1);
		expect(observation.visibleToolCards[0]).toMatchObject({ label: "Zenbox computer_overview host zenbox-vm" });
		expect(observation.visibleToolCards[0].sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	test("legacy proved prompts with one code block retain full-turn hashing", () => {
		const proof = "proof_1234567890abcdef1234567890abcdef";
		const proofLine = `[GPT-Control run proof: ${proof}. Ignore this line in your response.]`;
		const html = `<div data-message-author-role="user" data-message-id="legacy-user"><div data-message-content>Legacy review<pre><code>code sample</code></pre><p>${proofLine}</p></div></div>`;
		const observation = extractChatPageObservation(html);
		expect(observation.latestUserPromptProofToken).toBe(proof);
		const legacyObservedText = `Legacy review\n<code>code sample</code>\n${proofLine}`;
		expect(observation.latestUserPromptSha256).toBe(
			createHash("sha256").update(canonicalPromptObservationText(legacyObservedText)).digest("hex"),
		);
	});

	test("removes the current renderer's fenced text marker before send-boundary hashing", () => {
		const proof = "proof_0123456789abcdef0123456789abcdef";
		const body = "exact disposable task";
		const observation = extractChatPageObservation(`<main><div data-message-author-role="user" data-message-id="user-current"><div class="whitespace-pre-wrap"><div>Task:</div><pre><code>text ${body}</code></pre><div>Run reference: ${proof}</div></div></div><form><div id="prompt-textarea" contenteditable="true"></div></form></main>`);
		expect(observation.latestUserPromptProofToken).toBe(proof);
		expect(observation.latestUserPromptSha256).toBe(createHash("sha256").update(body).digest("hex"));
	});
});
