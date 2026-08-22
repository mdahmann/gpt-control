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
import { parseCdpTargetList, parseLoopbackEndpoint } from "./src/desktop-cdp-macos";

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
	private nextTarget = 1;
	failNextSend = false;

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
		return '<main><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></main>';
	}

	async act(targetId: string, action: DesktopCdpAction): Promise<unknown> {
		this.requireTarget(targetId);
		this.actions.push({ targetId, action });
		if (action.kind === "click" && action.selector.includes("send-button") && this.failNextSend) {
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
});

describe("ChatGPT Desktop endpoint policy", () => {
	test("accepts only an explicit loopback HTTP origin with a port", () => {
		expect(parseLoopbackEndpoint("http://127.0.0.1:9236").origin).toBe("http://127.0.0.1:9236");
		expect(() => parseLoopbackEndpoint("http://0.0.0.0:9236")).toThrow("loopback");
		expect(() => parseLoopbackEndpoint("https://127.0.0.1:9236")).toThrow("loopback");
		expect(() => parseLoopbackEndpoint("http://127.0.0.1:9236/json/list")).toThrow("loopback");
	});

	test("ignores unrelated CDP workers but rejects unsafe eligible target sockets", () => {
		const targets = parseCdpTargetList([
			{ id: "worker-1", type: "service_worker", title: "worker", url: "https://chatgpt.com/sw.js" },
			{
				id: "page-1",
				type: "page",
				title: "ChatGPT",
				url: "https://chatgpt.com/",
				webSocketDebuggerUrl: "ws://127.0.0.1:9236/devtools/page/page-1",
			},
		], "9236");
		expect(targets.map(({ id }) => id)).toEqual(["page-1"]);
		expect(() => parseCdpTargetList([{
			id: "page-2",
			type: "page",
			title: "ChatGPT",
			url: "https://chatgpt.com/",
			webSocketDebuggerUrl: "ws://192.0.2.4:9236/devtools/page/page-2",
		}], "9236")).toThrow("non-loopback");
	});
});
