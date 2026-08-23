import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	handleDesktopDriverRequest,
	type DesktopCdpAction,
	type DesktopCdpEnvironment,
	type DesktopCdpTarget,
} from "./src/desktop-driver";
import {
	parseCdpTargetList,
	parseLoopbackEndpoint,
	resolveDesktopShellProviderUrl,
	selectDesktopListenerOwner,
} from "./src/desktop-cdp-macos";

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
	private nextTarget = 1;
	failNextSend = false;
	nativeSendOnly = false;
	failCreateTarget = false;

	async verifyHost() {
		return {
			appPath: "/Applications/ChatGPT.app",
			bundleId: "com.openai.codex",
			teamId: "2DC432GLL2",
			listenerPid: 1234,
			endpoint: "http://127.0.0.1:9236",
			browserVersion: "Chrome/151.0.7922.170",
		};
	}

	async listTargets(): Promise<DesktopCdpTarget[]> {
		return [...this.targets.values()].map((target) => ({ ...target }));
	}

	async createTarget(url: string): Promise<DesktopCdpTarget> {
		if (this.failCreateTarget) throw new Error("signed desktop capacity exhausted");
		const id = `target-${this.nextTarget++}`;
		const target = { id, type: "page" as const, title: "ChatGPT", url };
		this.targets.set(id, target);
		return { ...target };
	}

	async navigateTarget(targetId: string, url: string): Promise<DesktopCdpTarget> {
		const target = this.requireTarget(targetId);
		target.url = url;
		return { ...target };
	}

	async readHtml(targetId: string): Promise<string> {
		this.requireTarget(targetId);
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

	async closeTarget(targetId: string): Promise<void> {
		this.closedTargets.push(targetId);
		this.targets.delete(targetId);
	}

	private requireTarget(targetId: string): DesktopCdpTarget {
		const target = this.targets.get(targetId);
		if (!target) throw new Error(`missing target ${targetId}`);
		return target;
	}

	replaceTarget(targetId: string, url: string): DesktopCdpTarget {
		this.targets.delete(targetId);
		const replacement = { id: `target-${this.nextTarget++}`, type: "page" as const, title: "ChatGPT", url };
		this.targets.set(replacement.id, replacement);
		return { ...replacement };
	}
}

const request = (action: string, params: Record<string, unknown> = {}) => ({ version: 2 as const, action, params });

describe("ChatGPT Desktop protocol-v2 adapter", () => {
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
				secureInput: true,
				protocolVersion: 2,
			},
		});
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

	test("owns the signed desktop ChatGPT shell without navigating or closing the app renderer", async () => {
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
		expect(created.ok).toBe(true);
		const session = created.result as { sessionId: string };
		expect((await handleDesktopDriverRequest(request("close", { sessionId: session.sessionId }), options)).ok).toBe(true);
		expect(environment.closedTargets).toEqual([]);
		expect(environment.targets.has("desktop-shell")).toBe(true);
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
		expect(blocked.error).toContain("capacity");
		expect(environment.targets.size).toBe(2);
	});

	test("removes an unbound durable session when renderer acquisition fails", async () => {
		const environment = new FakeDesktopCdp();
		environment.failCreateTarget = true;
		const stateRoot = scratch();
		const response = await handleDesktopDriverRequest(request("create", {
			name: "gpt-control:worker:no-capacity",
			url: "https://chatgpt.com/",
		}), { environment, stateRoot, allowCreateTarget: true });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("capacity exhausted");
		const durable = JSON.parse(readFileSync(join(stateRoot, "state.json"), "utf8"));
		expect(durable.sessions).toEqual({});
	});
});

describe("ChatGPT Desktop endpoint policy", () => {
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
			runtimeUrl: "app://-/index.html",
			chatGptMode: true,
			composerReady: true,
			modelSelectorReady: true,
			conversationActionsPresent: true,
			turnCount: 2,
			conversationIds: ["6a8a2fcb-8fa8-83ea-bdb7-0f5a8f12d565"],
		})).toBe("https://chatgpt.com/c/6a8a2fcb-8fa8-83ea-bdb7-0f5a8f12d565");
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
