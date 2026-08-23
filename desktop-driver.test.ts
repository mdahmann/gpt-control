import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	handleDesktopDriverRequest,
	closeDesktopDriverSessionOffline,
	DesktopTargetCreationError,
	type DesktopCdpAction,
	type DesktopCdpEnvironment,
	type DesktopCdpTarget,
	type DesktopCdpTargetReceipt,
} from "./src/desktop-driver";
import {
	MacDesktopCdpEnvironment,
	CdpProtocolError,
	commandLineHasExactArgument,
	dedicatedProfileWindowId,
	isMissingBrowserWindowError,
	parseCdpTargetList,
	parseLoopbackEndpoint,
	resolveDesktopShellProviderUrl,
	selectDesktopListenerOwner,
} from "./src/desktop-cdp-macos";
import {
	assertLaneCanLaunch,
	assertMinimizedWindowReceipt,
	assertRestoredFrontmostPid,
	assertShutdownProcessMembership,
	addPoolLaneReceipt,
	descendantProcessIds,
	laneHasExactlyOneReadyShell,
	loadPoolConfig,
	listenerProcessPids,
	poolLanes,
	profileAssociatedProcessPids,
	requestRequiresPoolAllocationLock,
	requestSessionId,
	roundRobinLaneOrder,
	withPoolAllocationLock,
	withReservedFreePoolLane,
} from "./src/desktop-pool-driver-cli";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-control-desktop-driver-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

class FakeDesktopCdp implements DesktopCdpEnvironment {
	readonly targets = new Map<string, DesktopCdpTarget>();
	readonly actions: Array<{ targetId: string; action: DesktopCdpAction }> = [];
	readonly selectorQueries: string[] = [];
	readonly closedTargets: string[] = [];
	readonly windowIds = new Map<string, number>();
	private nextTarget = 1;
	private nextWindow = 1;
	browserInstanceId = "fake-browser-instance-1";
	failNextSend = false;
	nativeSendOnly = false;
	failCreateTarget = false;
	failCreateAfterTarget = false;
	failWaitForTarget = false;
	restartAfterCreateTarget = false;
	failCloseTarget = false;
	failCloseAfterDelete = false;
	replaceAfterClose = false;
	omitCreatedWindowId = false;
	html: string | undefined;
	createdSurface: DesktopCdpTarget["surface"];
	conversationCatalog = [
		{
			providerConversationId: "6a89fbb8-03a4-83ea-9d51-4b08b96a690a",
			providerConversationUrl: "https://chatgpt.com/c/6a89fbb8-03a4-83ea-9d51-4b08b96a690a",
			title: "SEQ: T1 Timing Contract Independent Acceptance",
			pinned: true,
		},
	];

	async verifyHost() {
		return {
			appPath: "/Applications/ChatGPT.app",
			bundleId: "com.openai.codex",
			teamId: "2DC432GLL2",
			listenerPid: 1234,
			endpoint: "http://127.0.0.1:9236",
			browserVersion: "Chrome/151.0.7922.170",
			browserInstanceId: this.browserInstanceId,
		};
	}

	async listTargets(): Promise<DesktopCdpTarget[]> {
		return [...this.targets.values()].map((target) => ({ ...target }));
	}

	async findConversations() {
		return { conversations: this.conversationCatalog, discoveredAt: "2026-08-22T20:00:00.000Z" };
	}

	async createTarget(url: string): Promise<DesktopCdpTargetReceipt> {
		if (this.failCreateTarget) throw new DesktopTargetCreationError("signed desktop capacity exhausted", "unknown");
		const id = `target-${this.nextTarget++}`;
		const target = { id, type: "page" as const, title: "ChatGPT", url, browserInstanceId: this.browserInstanceId, ...(this.createdSurface ? { surface: this.createdSurface } : {}) };
		this.targets.set(id, target);
		if (!this.omitCreatedWindowId) this.windowIds.set(id, this.nextWindow++);
		if (this.failCreateAfterTarget) throw new DesktopTargetCreationError("renderer creation receipt transport failed", "unknown");
		const receipt = { id, browserInstanceId: this.browserInstanceId };
		if (this.restartAfterCreateTarget) this.browserInstanceId = "fake-browser-instance-after-create";
		return receipt;
	}

	async waitForTarget(targetId: string, browserInstanceId: string): Promise<DesktopCdpTarget> {
		if (this.failWaitForTarget) throw new Error("desktop renderer readiness failed");
		if (browserInstanceId !== this.browserInstanceId) throw new Error("desktop browser instance changed before readiness");
		return { ...this.requireTarget(targetId), browserInstanceId };
	}

	async windowId(targetId: string, browserInstanceId?: string): Promise<number | undefined> {
		if (browserInstanceId && browserInstanceId !== this.browserInstanceId) throw new Error("desktop browser instance changed before native window lookup");
		return this.windowIds.get(targetId);
	}

	async navigateTarget(targetId: string, url: string): Promise<DesktopCdpTarget> {
		const target = this.requireTarget(targetId);
		target.url = url;
		return { ...target };
	}

	async readHtml(targetId: string): Promise<string> {
		this.requireTarget(targetId);
		if (this.html !== undefined) return this.html;
		if (this.nativeSendOnly) return '<main><div contenteditable="true" aria-label="Message ChatGPT"></div><button aria-label="Send">Send</button></main>';
		return '<main><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></main>';
	}

	async elementExists(targetId: string, selector: string): Promise<boolean> {
		this.requireTarget(targetId);
		this.selectorQueries.push(selector);
		if (this.nativeSendOnly) return selector === 'button[aria-label="Send"]';
		return selector === 'button[data-testid="send-button"]';
	}

	async act(targetId: string, action: DesktopCdpAction): Promise<unknown> {
		this.requireTarget(targetId);
		this.actions.push({ targetId, action });
		if (this.nativeSendOnly && action.kind === "click" && action.selector !== 'button[aria-label="Send"]') {
			throw new Error(`No element found: ${action.selector}`);
		}
		if (action.kind === "click" && (action.selector.includes("send-button") || action.selector === 'button[aria-label="Send"]') && this.failNextSend) {
			this.failNextSend = false;
			throw new Error("ambiguous CDP send failure");
		}
		return { success: true };
	}

	async screenshot(targetId: string): Promise<string> {
		this.requireTarget(targetId);
		return Buffer.from("fake-png").toString("base64");
	}

	async closeTarget(targetId: string, browserInstanceId?: string): Promise<void> {
		this.closedTargets.push(targetId);
		if (browserInstanceId && browserInstanceId !== this.browserInstanceId) throw new Error("desktop browser instance changed");
		if (this.failCloseTarget) throw new Error("desktop target close failed");
		if (!this.targets.has(targetId)) throw new Error(`missing target ${targetId}`);
		const windowId = this.windowIds.get(targetId);
		const closed = this.targets.get(targetId);
		this.targets.delete(targetId);
		this.windowIds.delete(targetId);
		if (this.failCloseAfterDelete) throw new Error("ambiguous desktop target close failure");
		if (this.replaceAfterClose && windowId !== undefined && closed) {
			this.replaceAfterClose = false;
			const replacement = { ...closed, id: `target-${this.nextTarget++}` };
			this.targets.set(replacement.id, replacement);
			this.windowIds.set(replacement.id, windowId);
		}
	}

	private requireTarget(targetId: string): DesktopCdpTarget {
		const target = this.targets.get(targetId);
		if (!target) throw new Error(`missing target ${targetId}`);
		return target;
	}

	replaceTarget(targetId: string, url: string): DesktopCdpTarget {
		const windowId = this.windowIds.get(targetId);
		this.targets.delete(targetId);
		this.windowIds.delete(targetId);
		const replacement = { id: `target-${this.nextTarget++}`, type: "page" as const, title: "ChatGPT", url };
		this.targets.set(replacement.id, replacement);
		if (windowId !== undefined) this.windowIds.set(replacement.id, windowId);
		return { ...replacement };
	}
}

const request = (action: string, params: Record<string, unknown> = {}) => ({ version: 2 as const, action, params });

describe("ChatGPT Desktop protocol-v2 adapter", () => {
	test("finds exact existing desktop conversations without creating or claiming a renderer", async () => {
		const environment = new FakeDesktopCdp();
		const response = await handleDesktopDriverRequest(request("find_conversations", {
			query: "Timing Contract",
			pinned: true,
			limit: 10,
		}), {
			environment,
			stateRoot: scratch(),
			allowCreateTarget: false,
		});
		expect(response).toMatchObject({
			ok: true,
			result: {
				conversations: [{
					providerConversationId: "6a89fbb8-03a4-83ea-9d51-4b08b96a690a",
					title: "SEQ: T1 Timing Contract Independent Acceptance",
					pinned: true,
				}],
			},
		});
		expect(environment.targets.size).toBe(0);
	});

	test("probes one verified official loopback ChatGPT Desktop host", async () => {
		const environment = new FakeDesktopCdp();
		const response = await handleDesktopDriverRequest(request("probe"), {
			environment,
			stateRoot: scratch(),
			allowCreateTarget: false,
		});
		expect(response).toEqual({
			version: 2,
			ok: true,
			result: {
				ready: true,
				driver: "chatgpt-desktop-cdp/v1",
				driverVersion: "0.5.0-alpha.4",
				stateWriterVersion: 2,
				secureInput: true,
				protocolVersion: 2,
				host: await environment.verifyHost(),
			},
		});
	});

	test("refuses a desktop-local WEB identity as a provider conversation URL", async () => {
		const environment = new FakeDesktopCdp();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:synthetic-provider-id",
			url: "https://chatgpt.com/c/WEB:cdaa87bb-2edb-4768-b8b0-f3d0ea013e09",
		}), { environment, stateRoot: scratch(), allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("synthetic or invalid");
		expect(environment.targets.size).toBe(0);
	});

	test("creates and durably shows one exact independently owned renderer", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-one",
			url: "https://chatgpt.com/",
		}), options);
		expect(created.ok).toBe(true);
		const session = created.result as { sessionId: string; pageId: number; name: string; url: string };
		expect(session).toMatchObject({ name: "gpt-control:chat:desktop-one", url: "https://chatgpt.com/" });

		const shown = await handleDesktopDriverRequest(request("show", { sessionId: session.sessionId }), options);
		expect(shown).toEqual(created);
		expect(environment.targets.size).toBe(1);
	});

	test("releases one exact durable session after its native process is proved offline", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:offline-close",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(created.ok).toBe(true);
		const sessionId = (created.result as { sessionId: string }).sessionId;
		await closeDesktopDriverSessionOffline(stateRoot, sessionId);
		expect(Object.keys(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions)).toEqual([]);
		await expect(closeDesktopDriverSessionOffline(stateRoot, sessionId)).rejects.toThrow("Unknown ChatGPT Desktop session");
	});

	test("refuses to adopt the signed desktop shell used by the user", async () => {
		const environment = new FakeDesktopCdp();
		environment.targets.set("desktop-shell", {
			id: "desktop-shell",
			type: "page",
			title: "Codex",
			url: "https://chatgpt.com/",
			surface: "desktop_shell",
			runtimeUrl: "app://-/index.html",
		});
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: false };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-shell",
			url: "https://chatgpt.com/",
		}), options);
		expect(created.ok).toBe(false);
		expect(created.error).toContain("dedicated owned window");
		expect(environment.closedTargets).toEqual([]);
		expect(environment.targets.has("desktop-shell")).toBe(true);
		expect(Object.keys(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions)).toHaveLength(0);
	});

	test("attaches an exact conversation only in a newly created renderer", async () => {
		const environment = new FakeDesktopCdp();
		environment.targets.set("user-webview", {
			id: "user-webview",
			type: "webview",
			title: "ChatGPT",
			url: "https://chatgpt.com/",
			surface: "web",
		});
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const attached = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:attached:exact-conversation",
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		}), options);

		expect(attached.ok).toBe(true);
		const session = attached.result as { sessionId: string; url: string };
		const durable = JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8"));
		expect(durable.sessions[session.sessionId]).toMatchObject({
			targetId: "target-1",
			createdTarget: true,
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		});
		expect(environment.targets.get("user-webview")?.url).toBe("https://chatgpt.com/");
	});

	test("fails closed instead of attaching an exact conversation to an existing renderer", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		environment.targets.set("user-webview", {
			id: "user-webview",
			type: "webview",
			title: "ChatGPT",
			url: "https://chatgpt.com/",
			surface: "web",
		});
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:attached:no-window-authority",
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		}), { environment, stateRoot, allowCreateTarget: false });

		expect(response.ok).toBe(false);
		expect(response.error).toContain("target creation is disabled");
		expect(environment.targets.get("user-webview")?.url).toBe("https://chatgpt.com/");
		expect(Object.keys(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions)).toHaveLength(0);
	});

	test("refuses durable ownership when Desktop restarts during renderer creation", async () => {
		const environment = new FakeDesktopCdp();
		environment.restartAfterCreateTarget = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:attached:restart-race",
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		}), { environment, stateRoot, allowCreateTarget: true });

		expect(response.ok).toBe(false);
		expect(response.error).toContain("browser instance changed");
		const retained = Object.values(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions) as Array<Record<string, unknown>>;
		expect(retained).toHaveLength(1);
		expect(retained[0]).toMatchObject({ targetId: "target-1", creationPhase: "target_created", createdTarget: true });
	});

	test("refuses to adopt a user-owned webview", async () => {
		const environment = new FakeDesktopCdp();
		environment.targets.set("user-webview", {
			id: "user-webview",
			type: "webview",
			title: "ChatGPT",
			url: "https://chatgpt.com/",
			surface: "web",
		});
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: false };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:adopted-webview",
			url: "https://chatgpt.com/",
		}), options);
		expect(created.ok).toBe(false);
		expect(created.error).toContain("target creation is disabled");
		expect(environment.closedTargets).toEqual([]);
		expect(environment.targets.has("user-webview")).toBe(true);
	});

	test("closes only a desktop-shell window that the driver created", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:created-desktop-window",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(true);
		expect(environment.closedTargets).toEqual(["target-1"]);
	});

	test("retains durable ownership when a created target cannot be closed", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:close-retry",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		environment.failCloseTarget = true;

		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("desktop target close failed");
		const durable = JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8"));
		expect(durable.sessions[session.sessionId]).toMatchObject({
			targetId: "target-1",
			createdTarget: true,
			closeState: "close_dispatched",
		});
		expect(environment.targets.has("target-1")).toBe(true);

		environment.failCloseTarget = false;
		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(true);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions[session.sessionId]).toBeUndefined();
		expect(environment.targets.has("target-1")).toBe(false);
	});

	test("recovers a close that succeeded across an ambiguous persistence boundary", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:ambiguous-close",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		environment.failCloseAfterDelete = true;

		const first = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(first.ok).toBe(false);
		expect(first.error).toContain("ambiguous desktop target close failure");
		expect(environment.targets.has("target-1")).toBe(false);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions[session.sessionId])
			.toMatchObject({ closeState: "close_dispatched", createdTarget: true });

		const shown = await handleDesktopDriverRequest(request("show", { sessionId: session.sessionId }), options);
		expect(shown.ok).toBe(false);
		expect(shown.error).toContain("closing");

		environment.failCloseAfterDelete = false;
		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(true);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions[session.sessionId]).toBeUndefined();
	});

	test("closes a replacement renderer only when it remains in the owned native window", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:replacement-close",
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		}), options);
		const session = created.result as { sessionId: string; url: string };
		const replacement = environment.replaceTarget("target-1", session.url);

		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(true);
		expect(environment.closedTargets).toEqual([replacement.id]);
		expect(environment.targets.has(replacement.id)).toBe(false);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions[session.sessionId]).toBeUndefined();
	});

	test("closes a renderer replacement created after the first close dispatch", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:post-close-replacement",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		environment.replaceAfterClose = true;
		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(true);
		expect(environment.closedTargets).toEqual(["target-1", "target-2"]);
		expect(environment.targets.size).toBe(0);
	});

	test("does not close a user window showing the same chat after an ambiguous owned close", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const conversationUrl = "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc";
		environment.targets.set("user-window", {
			id: "user-window",
			type: "page",
			title: "ChatGPT",
			url: conversationUrl,
			surface: "desktop_shell",
		});
		environment.windowIds.set("user-window", 900);
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:ambiguous-close-with-user-window",
			url: conversationUrl,
		}), options);
		const session = created.result as { sessionId: string };
		environment.failCloseAfterDelete = true;

		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(false);
		environment.failCloseAfterDelete = false;
		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(true);
		expect(environment.targets.has("user-window")).toBe(true);
		expect(environment.closedTargets).not.toContain("user-window");
	});

	test("retains ownership when the exact renderer remains live under a different native window", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:window-drift",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		environment.windowIds.set("target-1", 999);

		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("native window identity changed");
		expect(environment.targets.has("target-1")).toBe(true);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions[session.sessionId]).toBeDefined();
	});

	test("retains old ownership instead of certifying closure after a Desktop restart", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const conversationUrl = "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-restart-close",
			url: conversationUrl,
		}), options);
		const session = created.result as { sessionId: string };
		environment.targets.delete("target-1");
		environment.windowIds.delete("target-1");
		environment.browserInstanceId = "fake-browser-instance-2";
		environment.targets.set("target-1", {
			id: "target-1",
			type: "page",
			title: "ChatGPT",
			url: conversationUrl,
			surface: "desktop_shell",
		});
		environment.windowIds.set("target-1", 1);

		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("different ChatGPT Desktop browser instance");
		expect(environment.targets.has("target-1")).toBe(true);
		expect(environment.closedTargets).toEqual([]);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions[session.sessionId]).toBeDefined();
	});

	test("retains a legacy created session when browser ownership cannot be proved", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:legacy-close",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		const statePath = join(stateRoot, "state.json");
		const legacy = JSON.parse(readFileSync(statePath, "utf8"));
		delete legacy.sessions[session.sessionId].browserInstanceId;
		delete legacy.sessions[session.sessionId].windowId;
		writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`);

		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("legacy");
		expect(environment.targets.has("target-1")).toBe(true);
		expect(JSON.parse(readFileSync(statePath, "utf8")).sessions[session.sessionId]).toBeDefined();
	});

	test("does not certify exact renderer close when native window identity is unavailable", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:native-no-window-id",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		const statePath = join(stateRoot, "state.json");
		const durable = JSON.parse(readFileSync(statePath, "utf8"));
		delete durable.sessions[session.sessionId].windowId;
		writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("replacement-window absence cannot be proved");
		expect(environment.closedTargets).toContain("target-1");
		expect(environment.targets.has("target-1")).toBe(false);
		expect(JSON.parse(readFileSync(statePath, "utf8")).sessions[session.sessionId]).toMatchObject({
			closeState: "close_dispatched",
		});
	});

	test("retains ownership when a renderer changes without native window identity", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:native-unproved-replacement",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		const statePath = join(stateRoot, "state.json");
		const durable = JSON.parse(readFileSync(statePath, "utf8"));
		delete durable.sessions[session.sessionId].windowId;
		writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);
		environment.targets.delete("target-1");
		environment.windowIds.delete("target-1");

		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("no native window identity");
		expect(JSON.parse(readFileSync(statePath, "utf8")).sessions[session.sessionId]).toBeDefined();
	});

	test("does not certify an ambiguous close retry without native window identity", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:ambiguous-no-window",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string };
		const durable = JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8"));
		delete durable.sessions[session.sessionId].windowId;
		durable.sessions[session.sessionId].closeState = "close_dispatched";
		writeFileSync(join(stateRoot, "state.json"), JSON.stringify(durable), { mode: 0o600 });
		environment.targets.delete("target-1");
		environment.windowIds.delete("target-1");
		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options);
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("no native window identity");
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions[session.sessionId]).toBeDefined();
	});

	test("does not close a replacement renderer claimed by another durable session", async () => {
		const environment = new FakeDesktopCdp();
		environment.createdSurface = "desktop_shell";
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const first = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:first-owner",
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		}), options);
		const firstSession = first.result as { sessionId: string; url: string };
		const replacement = environment.replaceTarget("target-1", firstSession.url);
		const statePath = join(stateRoot, "state.json");
		const beforeClose = JSON.parse(readFileSync(statePath, "utf8"));
		const secondSessionId = "desktop-second-owner";
		beforeClose.sessions[secondSessionId] = {
			...beforeClose.sessions[firstSession.sessionId],
			sessionId: secondSessionId,
			name: "gpt-control:chat:replacement-owner",
			tabId: beforeClose.nextTabId++,
			targetId: replacement.id,
			createdTarget: false,
		};
		writeFileSync(statePath, `${JSON.stringify(beforeClose, null, 2)}\n`);

		expect((await handleDesktopDriverRequest(request("close", { sessionId: firstSession.sessionId }), options)).ok).toBe(true);
		expect(environment.targets.has(replacement.id)).toBe(true);
		expect(environment.closedTargets).not.toContain(replacement.id);
		const durable = JSON.parse(readFileSync(statePath, "utf8"));
		expect(durable.sessions[firstSession.sessionId]).toBeUndefined();
		expect(durable.sessions[secondSessionId].targetId).toBe(replacement.id);
	});

	test("refuses a stale exact target before prompt mutation", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-stale",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string; pageId: number; name: string; url: string };
		const [target] = environment.targets.values();
		target.url = "https://chatgpt.com/c/foreign";

		const filled = await handleDesktopDriverRequest(request("fill", { session, prompt: "must not be sent" }), options);
		expect(filled.ok).toBe(false);
		expect(filled.error).toContain("exact target");
		expect(environment.actions).toEqual([]);
	});

	test("persists an attempted send before an ambiguous click and never replays it", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-send",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string; pageId: number; name: string; url: string };
		expect((await handleDesktopDriverRequest(request("fill", { session, prompt: "send once" }), options)).ok).toBe(true);
		environment.failNextSend = true;
		const first = await handleDesktopDriverRequest(request("send", { session }), options);
		expect(first.ok).toBe(false);
		expect(first.error).toContain("ambiguous CDP send failure");
		const second = await handleDesktopDriverRequest(request("send", { session }), options);
		expect(second.ok).toBe(false);
		expect(second.error).toContain("already attempted");
		expect(environment.actions.filter(({ action }) => action.kind === "click")).toHaveLength(1);
	});

	test("releases an attempted follow-up only after a newer terminal assistant turn is observed", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		environment.html = '<main><div data-message-author-role="assistant"><div class="markdown"><p>First answer</p></div></div><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></main>';
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-follow-up",
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		}), options);
		const session = created.result as { sessionId: string; pageId: number; name: string; url: string };
		expect((await handleDesktopDriverRequest(request("fill", { session, prompt: "Could you give one example?" }), options)).ok).toBe(true);
		expect((await handleDesktopDriverRequest(request("send", { session }), options)).ok).toBe(true);
		expect((await handleDesktopDriverRequest(request("fill", { session, prompt: "Too early" }), options)).error).toContain("remains ambiguous");
		environment.html = '<main><div data-message-author-role="assistant"><div class="markdown"><p>First answer</p></div></div><div data-message-author-role="assistant"><div class="markdown"><p>Second answer</p></div></div><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></main>';
		expect((await handleDesktopDriverRequest(request("observe", { session }), options)).ok).toBe(true);
		expect((await handleDesktopDriverRequest(request("fill", { session, prompt: "Now allowed" }), options)).ok).toBe(true);
	});

	test("resolves the native Send selector before sealing the ambiguous-send boundary", async () => {
		const environment = new FakeDesktopCdp();
		environment.nativeSendOnly = true;
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-native-send",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string; pageId: number; name: string; url: string };
		expect((await handleDesktopDriverRequest(request("fill", { session, prompt: "send once natively" }), options)).ok).toBe(true);
		environment.failNextSend = true;
		const first = await handleDesktopDriverRequest(request("send", { session }), options);
		expect(first.ok).toBe(false);
		expect(first.error).toContain("ambiguous CDP send failure");
		expect(environment.selectorQueries).toEqual([
			'button[data-testid="send-button"]',
			'button[aria-label="Send prompt"]',
			'button[data-testid="composer-send-button"]',
			'button[aria-label="Send"]',
		]);
		expect(environment.actions.filter(({ action }) => action.kind === "click")).toHaveLength(1);
		const second = await handleDesktopDriverRequest(request("send", { session }), options);
		expect(second.ok).toBe(false);
		expect(second.error).toContain("already attempted");
	});

	test("persists only a prompt hash and never plaintext prompt content", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-private",
			url: "https://chatgpt.com/",
		}), options);
		const session = created.result as { sessionId: string; pageId: number; name: string; url: string };
		const prompt = "private prompt that must never reach durable state";
		expect((await handleDesktopDriverRequest(request("fill", { session, prompt }), options)).ok).toBe(true);
		const durable = readFileSync(join(stateRoot, "state.json"), "utf8");
		expect(durable).not.toContain(prompt);
		expect(durable).toMatch(/"promptSha256": "[a-f0-9]{64}"/);
	});

	test("rebinds one exact provider conversation after a renderer restart", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const options = { environment, stateRoot, allowCreateTarget: true };
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-rebind",
			url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		}), options);
		const session = created.result as { sessionId: string; pageId: number; name: string; url: string };
		const oldTarget = [...environment.targets.keys()][0];
		const replacement = environment.replaceTarget(oldTarget, session.url);

		const shown = await handleDesktopDriverRequest(request("show", { sessionId: session.sessionId }), options);
		expect(shown.ok).toBe(true);
		expect(shown.result).toEqual(session);
		const durable = JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8"));
		expect(durable.sessions[session.sessionId].targetId).toBe(replacement.id);
	});

	test("recovers a state lock only when its local owner process is dead", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const lock = join(stateRoot, "state.lock");
		mkdirSync(lock, { mode: 0o700 });
		writeFileSync(join(lock, "owner.json"), JSON.stringify({
			token: "dead-owner-token",
			pid: 99999999,
			hostname: hostname(),
			createdAt: new Date(0).toISOString(),
		}), { mode: 0o600 });
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-dead-lock",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(true);
	});

	test("refuses an ownerless state lock instead of stealing it", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const lock = join(stateRoot, "state.lock");
		mkdirSync(lock, { mode: 0o700 });
		utimesSync(lock, new Date(0), new Date(0));
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:desktop-ownerless-lock",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("ownerless desktop state lock");
	});

	test("assigns distinct renderer identities and returns a clean capacity blocker", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const createOptions = { environment, stateRoot, allowCreateTarget: true };
		const first = await handleDesktopDriverRequest(request("create", { name: "gpt-control:worker:one", url: "https://chatgpt.com/" }), createOptions);
		const second = await handleDesktopDriverRequest(request("create", { name: "gpt-control:worker:two", url: "https://chatgpt.com/" }), createOptions);
		expect((first.result as { pageId: number }).pageId).not.toBe((second.result as { pageId: number }).pageId);
		expect(environment.targets.size).toBe(2);

		const blocked = await handleDesktopDriverRequest(request("create", { name: "gpt-control:worker:three", url: "https://chatgpt.com/" }), {
			environment,
			stateRoot,
			allowCreateTarget: false,
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.error).toContain("target creation is disabled");
		expect(environment.targets.size).toBe(2);
	});

	test("retains pre-creation intent when no exact renderer receipt is returned", async () => {
		const environment = new FakeDesktopCdp();
		environment.failCreateTarget = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:no-capacity",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("capacity exhausted");
		expect(response.error).toContain("call close with this session ID");
		const durable = JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8"));
		const sessions = Object.values(durable.sessions) as Array<Record<string, unknown>>;
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ targetId: "", creationPhase: "intent_recorded" });
		const retried = await handleDesktopDriverRequest(request("navigate", {
			session: { sessionId: sessions[0].sessionId, pageId: sessions[0].tabId, name: sessions[0].name, url: "https://chatgpt.com/" },
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(retried.ok).toBe(false);
		expect(retried.error).toContain("no replacement window");
		const recovered = await handleDesktopDriverRequest(request("close", { sessionId: sessions[0].sessionId }), {
			environment,
			stateRoot,
			allowCreateTarget: true,
		});
		expect(recovered.ok).toBe(true);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions).toEqual({});
		environment.failCreateTarget = false;
		const replacement = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:replacement-after-recovery",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(replacement.ok).toBe(true);
		expect(environment.targets.size).toBe(1);
	});

	test("retains an uncertain creation when a post-intent renderer remains", async () => {
		const environment = new FakeDesktopCdp();
		environment.failCreateAfterTarget = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:unknown-created-window",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		const sessions = Object.values(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions) as Array<Record<string, unknown>>;
		expect(sessions).toHaveLength(1);
		const recovered = await handleDesktopDriverRequest(request("close", { sessionId: sessions[0].sessionId }), {
			environment,
			stateRoot,
			allowCreateTarget: true,
		});
		expect(recovered.ok).toBe(false);
		expect(recovered.error).toContain("post-intent renderer candidate");
		expect(environment.targets.size).toBe(1);
	});

	test("closes an exact journaled renderer after a crash before state promotion", async () => {
		const environment = new FakeDesktopCdp();
		environment.failCreateAfterTarget = true;
		const stateRoot = scratch();
		await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:journal-crash-recovery",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		const durable = JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8"));
		const session = Object.values(durable.sessions)[0] as Record<string, string>;
		const receipts = join(stateRoot, "creation-receipts");
		mkdirSync(receipts, { mode: 0o700 });
		writeFileSync(join(receipts, `${session.creationOperationId}.json`), JSON.stringify({
			version: 1,
			operationId: session.creationOperationId,
			targetId: "target-1",
			browserInstanceId: environment.browserInstanceId,
			recordedAt: "2026-08-23T09:00:00.000Z",
		}), { mode: 0o600 });

		const closed = await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), {
			environment,
			stateRoot,
			allowCreateTarget: true,
		});
		expect(closed.ok).toBe(true);
		expect(environment.closedTargets).toEqual(["target-1"]);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions).toEqual({});
	});

	test("cleans the exact renderer when receipt journaling is unavailable", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		writeFileSync(join(stateRoot, "creation-receipts"), "not-a-directory", { mode: 0o600 });
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:journal-unavailable",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("cleanup was proved");
		expect(environment.closedTargets).toEqual(["target-1"]);
		expect(environment.targets.size).toBe(0);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions).toEqual({});
	});

	test("rejects and cleans a created renderer without native window identity", async () => {
		const environment = new FakeDesktopCdp();
		environment.omitCreatedWindowId = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:no-window-identity",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("native window identity");
		expect(environment.closedTargets).toEqual(["target-1"]);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions).toEqual({});
	});

	test("migrates legacy version-one state and accepts an older version-two driver label", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const legacySession = {
			sessionId: "desktop-legacy-session",
			name: "gpt-control:chat:legacy",
			tabId: 1,
			targetId: "target-legacy",
			windowId: 1,
			browserInstanceId: environment.browserInstanceId,
			createdTarget: true,
			closeState: "target_closed",
			url: "https://chatgpt.com/",
			state: "working",
			sendState: "prepared",
			createdAt: "2026-08-22T20:00:00.000Z",
		};
		writeFileSync(join(stateRoot, "state.json"), JSON.stringify({ version: 1, nextTabId: 2, sessions: { [legacySession.sessionId]: legacySession } }), { mode: 0o600 });
		const closed = await handleDesktopDriverRequest(request("close", { sessionId: legacySession.sessionId }), {
			environment,
			stateRoot,
			allowCreateTarget: true,
		});
		expect(closed.ok).toBe(true);

		writeFileSync(join(stateRoot, "state.json"), JSON.stringify({
			version: 2,
			writerVersion: 2,
			driverVersion: "0.5.0-alpha.1",
			nextTabId: 1,
			sessions: {},
		}), { mode: 0o600 });
		const created = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:chat:upgraded-v2",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: false });
		expect(created.ok).toBe(false);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).driverVersion).toBe("0.5.0-alpha.4");
	});

	test("refuses actions on a migrated legacy renderer that was not driver-created", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		environment.targets.set("user-target", {
			id: "user-target",
			type: "page",
			title: "ChatGPT",
			url: "https://chatgpt.com/",
		});
		environment.windowIds.set("user-target", 42);
		const session = {
			sessionId: "desktop-legacy-adopted",
			name: "gpt-control:chat:legacy-adopted",
			tabId: 1,
			targetId: "user-target",
			windowId: 42,
			browserInstanceId: environment.browserInstanceId,
			createdTarget: false,
			url: "https://chatgpt.com/",
			state: "working",
			sendState: "prepared",
			createdAt: "2026-08-22T20:00:00.000Z",
		};
		writeFileSync(join(stateRoot, "state.json"), JSON.stringify({ version: 1, nextTabId: 2, sessions: { [session.sessionId]: session } }), { mode: 0o600 });
		const shown = await handleDesktopDriverRequest(request("show", { sessionId: session.sessionId }), {
			environment,
			stateRoot,
			allowCreateTarget: true,
		});
		expect(shown.ok).toBe(false);
		expect(shown.error).toContain("does not own a dedicated renderer");
		expect(environment.targets.has("user-target")).toBe(true);
	});

	test("refuses migration while a legacy close owner may still be active", async () => {
		const environment = new FakeDesktopCdp();
		const stateRoot = scratch();
		const session = {
			sessionId: "desktop-legacy-active-close",
			name: "gpt-control:chat:legacy-active-close",
			tabId: 1,
			targetId: "target-legacy",
			windowId: 1,
			browserInstanceId: environment.browserInstanceId,
			createdTarget: true,
			closeState: "requested",
			closeOwnerToken: "legacy-close-owner",
			closeOwnerPid: process.pid,
			closeOwnerHostname: hostname(),
			url: "https://chatgpt.com/",
			state: "working",
			sendState: "prepared",
			createdAt: "2026-08-22T20:00:00.000Z",
		};
		writeFileSync(join(stateRoot, "state.json"), JSON.stringify({ version: 1, nextTabId: 2, sessions: { [session.sessionId]: session } }), { mode: 0o600 });
		const response = await handleDesktopDriverRequest(request("show", { sessionId: session.sessionId }), {
			environment,
			stateRoot,
			allowCreateTarget: true,
		});
		expect(response.ok).toBe(false);
		expect(response.error).toContain("migration is refused");
	});

	test("cleans a provisionally recorded target when readiness fails", async () => {
		const environment = new FakeDesktopCdp();
		environment.failWaitForTarget = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:readiness-cleanup",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("readiness failed");
		expect(environment.closedTargets).toEqual(["target-1"]);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions).toEqual({});
	});

	test("cleans a replacement renderer during provisional readiness failure", async () => {
		const environment = new FakeDesktopCdp();
		environment.failWaitForTarget = true;
		environment.replaceAfterClose = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:readiness-replacement-cleanup",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(environment.closedTargets).toEqual(["target-1", "target-2"]);
		expect(environment.targets.size).toBe(0);
		expect(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions).toEqual({});
	});

	test("retains the exact provisional receipt when readiness and cleanup both fail", async () => {
		const environment = new FakeDesktopCdp();
		environment.failWaitForTarget = true;
		environment.failCloseTarget = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:readiness-retained",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("remains durably journaled");
		const sessions = Object.values(JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8")).sessions) as Array<Record<string, unknown>>;
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ targetId: "target-1", creationPhase: "target_created", createdTarget: true });
	});
});

describe("ChatGPT Desktop endpoint policy", () => {
	test("builds a bounded deterministic native worker pool", () => {
		const config = loadPoolConfig({
			HOME: "/tmp/home",
			GPT_CONTROL_DRIVER_DESKTOP_POOL_ROOT: "/tmp/gpt-control-pool",
			GPT_CONTROL_DRIVER_DESKTOP_POOL_START_PORT: "9400",
			GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE: "3",
		});
		const lanes = poolLanes(config);
		expect(lanes.map((lane) => lane.endpoint)).toEqual([
			"http://127.0.0.1:9400",
			"http://127.0.0.1:9401",
			"http://127.0.0.1:9402",
		]);
		expect(new Set(lanes.map((lane) => lane.profileRoot)).size).toBe(3);
		expect(config.allowInteractiveBootstrap).toBe(false);
		expect(loadPoolConfig({ GPT_CONTROL_DRIVER_DESKTOP_ALLOW_INTERACTIVE_BOOTSTRAP: "1" }).allowInteractiveBootstrap).toBe(true);
		expect(() => loadPoolConfig({ GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE: "11" })).toThrow("pool size");
		expect(() => loadPoolConfig({ GPT_CONTROL_DRIVER_DESKTOP_POOL_START_PORT: "65535", GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE: "2" })).toThrow("port range");
		expect(() => loadPoolConfig({ GPT_CONTROL_DRIVER_DESKTOP_POOL_ROOT: "/tmp/pool with spaces" })).toThrow("whitespace");
	});

	test("routes pool actions only through an exact session id", () => {
		expect(requestSessionId({ version: 2, action: "show", params: { sessionId: "session-a" } })).toBe("session-a");
		expect(requestSessionId({ version: 2, action: "fill", params: { session: { sessionId: "session-b" } } })).toBe("session-b");
		expect(requestSessionId({ version: 2, action: "create", params: {} })).toBeUndefined();
	});

	test("adds a non-sensitive exact lane receipt to successful pool results", () => {
		expect(addPoolLaneReceipt({ version: 2, ok: true, result: { sessionId: "session-a", pageId: "target-1" } }, 4)).toEqual({
			version: 2,
			ok: true,
			result: { sessionId: "session-a", pageId: "target-1", desktopPoolLane: 4 },
		});
		expect(addPoolLaneReceipt({ version: 2, ok: false, error: "blocked" }, 4)).toEqual({ version: 2, ok: false, error: "blocked" });
	});

	test("keeps slow create work outside the global lock while serializing discovery and close", () => {
		expect(requestRequiresPoolAllocationLock("create")).toBe(false);
		expect(requestRequiresPoolAllocationLock("find_conversations")).toBe(true);
		expect(requestRequiresPoolAllocationLock("close")).toBe(true);
		expect(requestRequiresPoolAllocationLock("show")).toBe(false);
	});

	test("orders free-lane checks from a durable round-robin cursor", () => {
		const lanes = [{ index: 1 }, { index: 2 }, { index: 3 }];
		expect(roundRobinLaneOrder(lanes, 2).map(({ index }) => index)).toEqual([2, 3, 1]);
		expect(roundRobinLaneOrder(lanes, 3).map(({ index }) => index)).toEqual([3, 1, 2]);
		expect(() => roundRobinLaneOrder(lanes, 4)).toThrow("cursor");
	});

	test("reserves six cold lanes concurrently without holding the global lock during slow work", async () => {
		const root = realpathSync(scratch());
		const config = loadPoolConfig({
			HOME: root,
			GPT_CONTROL_DRIVER_DESKTOP_POOL_ROOT: join(root, "pool"),
			GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE: "6",
		});
		const lanes = poolLanes(config);
		const assigned = await Promise.all(Array.from({ length: 6 }, (_, index) =>
			withReservedFreePoolLane(config, lanes, async (lane) => {
				if (index === 0) await new Promise((resolve) => setTimeout(resolve, 100));
				return lane.index;
			})));
		expect(new Set(assigned).size).toBe(6);
		expect(assigned.sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	test("waits for one exact ready shell and refuses replacement under durable work", () => {
		expect(laneHasExactlyOneReadyShell([])).toBe(false);
		expect(laneHasExactlyOneReadyShell([{ surface: "web" }, { surface: "desktop_shell" }])).toBe(true);
		expect(() => laneHasExactlyOneReadyShell([{ surface: "desktop_shell" }, { surface: "desktop_shell" }])).toThrow("ambiguous");
		expect(() => assertLaneCanLaunch(2, ["desktop-existing"])).toThrow("durable work");
		expect(assertLaneCanLaunch(2, [])).toBeUndefined();
	});

	test("serializes same-process pool allocations with unique lock ownership", async () => {
		const root = scratch();
		let active = 0;
		let maximum = 0;
		await Promise.all([1, 2].map((value) => withPoolAllocationLock(root, async () => {
			active += 1;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active -= 1;
			return value;
		})));
		expect(maximum).toBe(1);
	});

	test("recovers a pool allocation lock only after its exact local owner dies", async () => {
		const root = scratch();
		const lock = join(root, "allocation.lock");
		mkdirSync(lock, { mode: 0o700 });
		writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
			version: 1,
			token: "dead-owner-token",
			pid: 999_999,
			hostname: hostname(),
			processStartId: "Mon Jan  1 00:00:00 2001",
			startedAt: "2001-01-01T00:00:00.000Z",
		})}\n`, { mode: 0o600 });
		expect(await withPoolAllocationLock(root, async () => "recovered")).toBe("recovered");
	});

	test("refuses an ownerless pool allocation lock", async () => {
		const root = scratch();
		mkdirSync(join(root, "allocation.lock"), { mode: 0o700 });
		await expect(withPoolAllocationLock(root, async () => "unsafe")).rejects.toThrow("ownerless or invalid");
	});

	test("fences a replaced pool lock before work and preserves the foreign lock", async () => {
		const root = scratch();
		let entered = false;
		await expect(withPoolAllocationLock(root, async () => {
			entered = true;
		}, {
			afterPublish: async (lockRoot) => {
				rmSync(lockRoot, { recursive: true, force: true });
				mkdirSync(lockRoot, { mode: 0o700 });
				writeFileSync(join(lockRoot, "foreign-marker"), "foreign\n", { mode: 0o600 });
			},
		})).rejects.toThrow("identity changed");
		expect(entered).toBe(false);
		expect(readFileSync(join(root, "allocation.lock", "foreign-marker"), "utf8")).toBe("foreign\n");
	});

	test("downgrades only the exact known no-window CDP error", () => {
		expect(isMissingBrowserWindowError(new CdpProtocolError(-32000, "Browser window not found"))).toBe(true);
		expect(isMissingBrowserWindowError(new CdpProtocolError(-32000, "Permission denied"))).toBe(false);
		expect(isMissingBrowserWindowError(new Error("Browser window not found"))).toBe(false);
	});

	test("searches every eligible desktop shell and deduplicates exact matching evidence", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
		};
		transport.targetDescriptors = async () => ["shell-one", "shell-two"].map((id) => ({
			id, type: "page", title: "ChatGPT", url: id === "shell-one" ? "app://-/index.html" : "https://chatgpt.com/c/WEB:12345678-1234-1234-1234-123456789abc", webSocketDebuggerUrl: `ws://127.0.0.1:9236/devtools/page/${id}`,
		}));
		const record = {
			providerConversationId: "12345678-1234-1234-1234-123456789abc",
			providerConversationUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
			title: "Sequence review",
			pinned: true,
		};
		transport.evaluate = async (targetId) => [{
			...record,
			pinned: targetId === "shell-two",
			...(targetId === "shell-one" ? { current: true } : {}),
		}];
		const catalog = await environment.findConversations({ query: "Sequence", limit: 20 });
		expect(catalog.conversations).toEqual([{ ...record, current: true }]);
	});

	test("fails closed when desktop shells disagree about one conversation identity", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
		};
		transport.targetDescriptors = async () => ["shell-one", "shell-two"].map((id) => ({
			id, type: "page", title: "ChatGPT", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:9236/devtools/page/${id}`,
		}));
		transport.evaluate = async (targetId) => [{
			providerConversationId: "12345678-1234-1234-1234-123456789abc",
			providerConversationUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
			title: targetId === "shell-one" ? "Sequence review" : "Conflicting title",
			pinned: true,
		}];
		await expect(environment.findConversations({ limit: 20 })).rejects.toThrow("conflicting identity evidence");
	});

	test("double-clicks one exact native header title", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
		let evaluation = 0;
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
			cdp: (targetId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
		};
		transport.targetDescriptors = async () => [{
			id: "native-shell",
			type: "page",
			title: "ChatGPT",
			url: "app://-/index.html",
			webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/native-shell",
		}];
		transport.evaluate = async () => (++evaluation === 1 ? { x: 320, y: 22 } : "allowed");
		transport.cdp = async (_targetId, method, params) => { cdpCalls.push({ method, params }); return {}; };

		expect(await environment.act("native-shell", {
			kind: "doubleClick",
			selector: "text=Improve Keyboard Navigation",
			expectedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		})).toEqual({ success: true });
		expect(cdpCalls.filter(({ method }) => method === "Input.dispatchMouseEvent"))
			.toContainEqual(expect.objectContaining({ params: expect.objectContaining({ clickCount: 2 }) }));
	});

	test("fills one exact native composer through CDP and reads the text back", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const prompt = "How would you improve this signup form?";
		const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
		let evaluation = 0;
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
			cdp: (targetId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
			withCdpSession: <T>(targetId: string, work: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>) => Promise<T>;
		};
		transport.targetDescriptors = async () => [{
			id: "native-shell",
			type: "page",
			title: "ChatGPT",
			url: "app://-/index.html",
			webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/native-shell",
		}];
		transport.evaluate = async () => ({ success: true });
		transport.withCdpSession = async (_targetId, work) => work(async (method, params) => {
			cdpCalls.push({ method, params });
			if (method === "Runtime.evaluate") return { result: { value: ++evaluation === 1 ? { success: true } : prompt } };
			return {};
		});
		transport.cdp = async () => { throw new Error("native composer focus and insertion must share one CDP session"); };

		expect(await environment.act("native-shell", {
			kind: "fill",
			selector: '[aria-label="Message ChatGPT"]',
			text: prompt,
			expectedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		})).toEqual({ success: true });
		expect(cdpCalls).toContainEqual({ method: "Input.insertText", params: { text: prompt } });
	});

	test("uses the exact guarded control when the native ViewTrack layer covers its physical hit points", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const cdpCalls: string[] = [];
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
			cdp: (targetId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
			withCdpSession: <T>(targetId: string, work: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>) => Promise<T>;
		};
		transport.targetDescriptors = async () => [{
			id: "native-shell",
			type: "page",
			title: "ChatGPT",
			url: "app://-/index.html",
			webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/native-shell",
		}];
		transport.evaluate = async () => ({ synthetic: true });
		transport.cdp = async (_targetId, method) => {
			cdpCalls.push(method);
			throw new Error("a guarded native-shell control must not click through ViewTrack");
		};

		expect(await environment.act("native-shell", {
			kind: "click",
			selector: '[id="picker-model-row"]',
			expectedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		})).toEqual({ success: true });
		expect(cdpCalls).toEqual([]);
	});

	test("reloads the exact native conversation without a separate unguarded navigation", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const calls: string[] = [];
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
			cdp: (targetId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
			withCdpSession: <T>(targetId: string, work: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>) => Promise<T>;
		};
		transport.targetDescriptors = async () => [{
			id: "native-shell",
			type: "page",
			title: "ChatGPT",
			url: "app://-/index.html",
			webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/native-shell",
		}];
		transport.evaluate = async (_targetId, expression) => {
			calls.push(expression);
			return { success: true };
		};
		transport.cdp = async (_targetId, method) => {
			calls.push(method);
			throw new Error("native reload must not use an unguarded CDP navigation command");
		};

		expect(await environment.act("native-shell", {
			kind: "reload",
			expectedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		})).toEqual({ success: true });
		expect(calls).toHaveLength(1);
	});

	test("uploads to one marked native composer only while the exact conversation remains proven", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
			cdp: (targetId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
			withCdpSession: <T>(targetId: string, work: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>) => Promise<T>;
		};
		transport.targetDescriptors = async () => [{
			id: "native-shell",
			type: "page",
			title: "ChatGPT",
			url: "app://-/index.html",
			webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/native-shell",
		}];
		transport.evaluate = async () => ({ success: true });
		transport.withCdpSession = async (_targetId, work) => work(async (method, params) => {
			cdpCalls.push({ method, params });
			if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
			if (method === "DOM.querySelector") return { nodeId: 2 };
			return {};
		});
		transport.cdp = async () => { throw new Error("upload node IDs must remain in one CDP session"); };

		expect(await environment.act("native-shell", {
			kind: "upload",
			selector: 'input[type="file"]',
			files: ["/private/tmp/gpt-control-snapshot.txt"],
			expectedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		})).toEqual({ success: true });
		expect(cdpCalls.filter(({ method }) => method === "DOM.setFileInputFiles")).toEqual([{
			method: "DOM.setFileInputFiles",
			params: { nodeId: 2, files: ["/private/tmp/gpt-control-snapshot.txt"] },
		}]);
	});

	test("dispatches one guarded native-shell key only for the exact conversation", async () => {
		const environment = new MacDesktopCdpEnvironment("http://127.0.0.1:9236");
		const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
		let evaluation = 0;
		const transport = environment as unknown as {
			targetDescriptors: () => Promise<Array<{ id: string; type: "page"; title: string; url: string; webSocketDebuggerUrl: string }>>;
			evaluate: (targetId: string, expression: string) => Promise<unknown>;
			cdp: (targetId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
		};
		transport.targetDescriptors = async () => [{
			id: "native-shell",
			type: "page",
			title: "ChatGPT",
			url: "app://-/index.html",
			webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/native-shell",
		}];
		transport.evaluate = async () => (++evaluation === 1 ? true : "allowed");
		transport.cdp = async (_targetId, method, params) => {
			cdpCalls.push({ method, params });
			return {};
		};

		expect(await environment.act("native-shell", {
			kind: "press",
			key: "Escape",
			expectedUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
		})).toEqual({ success: true });
		expect(cdpCalls).toEqual([
			{ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Escape" } },
			{ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Escape" } },
		]);
	});

	test("maps only one ready signed app shell to its exact provider conversation", () => {
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: false,
			turnCount: 0,
			conversationIds: [],
		})).toBe("https://chatgpt.com/");
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "https://chatgpt.com/c/WEB:cdaa87bb-2edb-4768-b8b0-f3d0ea013e09",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: false,
			turnCount: 0,
			conversationIds: ["WEB:cdaa87bb-2edb-4768-b8b0-f3d0ea013e09"],
		})).toBe("https://chatgpt.com/");
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: true,
			turnCount: 2,
			conversationIds: ["6a8a2fcb-8fa8-83ea-bdb7-0f5a8f12d565"],
		})).toBe("https://chatgpt.com/c/6a8a2fcb-8fa8-83ea-bdb7-0f5a8f12d565");
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: false,
			modelSelectorReady: false,
			conversationActionsPresent: true,
			turnCount: 2,
			conversationIds: ["6a8a2fcb-8fa8-83ea-bdb7-0f5a8f12d565"],
		})).toBe("https://chatgpt.com/c/6a8a2fcb-8fa8-83ea-bdb7-0f5a8f12d565");
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: false,
			modelSelectorReady: false,
			conversationActionsPresent: false,
			turnCount: 0,
			conversationIds: [],
		})).toBeUndefined();
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html?initialRoute=%2Favatar-overlay",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: false,
			turnCount: 0,
			conversationIds: [],
		})).toBeUndefined();
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: true,
			turnCount: 2,
			conversationIds: [],
		})).toBeUndefined();
		expect(resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: false,
			turnCount: 1,
			conversationIds: [],
		})).toBeUndefined();
		expect(() => resolveDesktopShellProviderUrl({
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: true,
			turnCount: 2,
			conversationIds: ["6a8a2fcb-8fa8-83ea-bdb7-0f5a8f12d565", "7b9b3fcb-8fa8-83ea-bdb7-0f5a8f12d566"],
		})).toThrow("ambiguous");
	});

	test("accepts only an explicit loopback HTTP origin with a port", () => {
		expect(parseLoopbackEndpoint("http://127.0.0.1:9236").origin).toBe("http://127.0.0.1:9236");
		expect(() => parseLoopbackEndpoint("http://0.0.0.0:9236")).toThrow("loopback");
		expect(() => parseLoopbackEndpoint("https://127.0.0.1:9236")).toThrow("loopback");
		expect(() => parseLoopbackEndpoint("http://127.0.0.1:9236/json/list")).toThrow("loopback");
	});

	test("requires exact process arguments instead of profile-path prefixes", () => {
		const expected = "--user-data-dir=/Users/test/.gpt-control/desktop-worker-pool/lanes/01/profile";
		expect(commandLineHasExactArgument(`/Applications/ChatGPT.app/Contents/MacOS/ChatGPT ${expected} --remote-debugging-port=9237`, expected)).toBe(true);
		expect(commandLineHasExactArgument(`/Applications/ChatGPT.app/Contents/MacOS/ChatGPT ${expected}-other --remote-debugging-port=9237`, expected)).toBe(false);
		expect(commandLineHasExactArgument(`/Applications/ChatGPT.app/Contents/MacOS/ChatGPT ${expected} ${expected}-other`, expected)).toBe(false);
		expect(() => commandLineHasExactArgument("ChatGPT --user-data-dir=/tmp/a b", "--user-data-dir=/tmp/a b")).toThrow("whitespace");
	});

	test("finds only processes using the exact dedicated profile argument", () => {
		const profile = "/Users/test/.gpt-control/desktop-worker-pool/lanes/01/profile";
		const processList = [
			` 101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=${profile} --remote-debugging-port=9237`,
			` 102 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=${profile}-other --remote-debugging-port=9238`,
			" 103 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9239",
		].join("\n");
		expect(profileAssociatedProcessPids(`${processList}\n 104 browser_crashpad_handler --database=${profile}/Crashpad`, profile)).toEqual([101, 104]);
		expect(listenerProcessPids("p101\np104\np101\n")).toEqual([101, 104]);
	});

	test("collects only the exact native worker process tree", () => {
		const processList = [
			" 100 1",
			" 101 100",
			" 102 101",
			" 200 1",
			" 201 200",
		].join("\n");
		expect(descendantProcessIds(processList, 100)).toEqual([100, 101, 102]);
	});

	test("refuses shutdown authority for foreign profile and listener processes", () => {
		expect(() => assertShutdownProcessMembership(1, new Set([100, 101]), new Set([100, 200]), new Set([101]))).toThrow("unproved");
		expect(() => assertShutdownProcessMembership(1, new Set([100, 101]), new Set([100]), new Set([101, 201]))).toThrow("unproved");
		expect(assertShutdownProcessMembership(1, new Set([100, 101]), new Set([100]), new Set([101]))).toBeUndefined();
	});

	test("requires minimized-window and restored-focus read-back", () => {
		expect(assertMinimizedWindowReceipt(100, "2,0\n")).toBeUndefined();
		expect(() => assertMinimizedWindowReceipt(100, "2,1\n")).toThrow("unminimized");
		expect(() => assertMinimizedWindowReceipt(100, "unknown\n")).toThrow("invalid native-window receipt");
		expect(assertRestoredFrontmostPid(200, 200)).toBeUndefined();
		expect(() => assertRestoredFrontmostPid(200, 201)).toThrow("restore frontmost");
	});

	test("derives a stable reserved window identity for one dedicated profile lane", () => {
		const endpoint = new URL("http://127.0.0.1:9237");
		const first = dedicatedProfileWindowId(endpoint, "/tmp/gpt-control/lane-01/profile");
		expect(first).toBe(dedicatedProfileWindowId(endpoint, "/tmp/gpt-control/lane-01/profile"));
		expect(first).not.toBe(dedicatedProfileWindowId(new URL("http://127.0.0.1:9238"), "/tmp/gpt-control/lane-01/profile"));
		expect(first).toBeGreaterThanOrEqual(2 ** 48);
		expect(first).toBeLessThan(2 ** 49);
	});

	test("accepts one verified app listener with an OpenAI-signed descendant holding the inherited socket", () => {
		const executable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
		expect(selectDesktopListenerOwner([
			{ pid: 100, executable, teamId: "2DC432GLL2", ancestry: [1], names: ["127.0.0.1:9236"] },
			{
				pid: 101,
				executable: "/Users/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
				teamId: "2DC432GLL2",
				ancestry: [100, 1],
				names: ["127.0.0.1:9236"],
			},
		], executable, "9236")).toBe(100);
	});

	test("rejects an unrelated or unsigned process holding the desktop listener", () => {
		const executable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
		const app = { pid: 100, executable, teamId: "2DC432GLL2", ancestry: [1], names: ["127.0.0.1:9236"] };
		expect(() => selectDesktopListenerOwner([
			app,
			{ pid: 900, executable: "/tmp/foreign", teamId: "FOREIGN", ancestry: [1], names: ["127.0.0.1:9236"] },
		], executable, "9236")).toThrow("unverified listener holder");
	});

	test("ignores unrelated CDP workers but rejects unsafe eligible target sockets", () => {
		const targets = parseCdpTargetList([
			{ id: "worker-1", type: "service_worker", title: "worker", url: "https://chatgpt.com/sw.js" },
			{
				id: "page-loading",
				type: "page",
				title: "",
				url: "",
				webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/page-loading",
			},
			{
				id: "page-1",
				type: "page",
				title: "ChatGPT",
				url: "https://chatgpt.com/",
				webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/page-1",
			},
		], "9236");
		expect(targets.map(({ id, url }) => ({ id, url }))).toEqual([
			{ id: "page-loading", url: "" },
			{ id: "page-1", url: "https://chatgpt.com/" },
		]);
		expect(() => parseCdpTargetList([{
			id: "page-2",
			type: "page",
			title: "ChatGPT",
			url: "https://chatgpt.com/",
			webSocketDebuggerUrl: "ws://192.0.2.4:9236/devtools/page/page-2",
		}], "9236")).toThrow("non-loopback");
	});
});
