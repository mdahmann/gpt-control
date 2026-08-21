import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capabilities } from "./src/capability";
import { BROWSER_DRIVER_PROTOCOL_VERSION, ChromeBridgeBrowserDriver } from "./src/browser-driver";
import { GptControlService } from "./src/service";
import { operatorPolicyFromEnv, type OperatorPolicyInput } from "./src/policy";
import { RunStore } from "./src/store";
import type { Exec, ExecResult } from "./src/types";
import type { Launcher } from "./src/transport";

export type FakeScenario = "success" | "false_completion" | "network_recover" | "network_persistent" | "continue_persistent" | "slow" | "fail_fill";

export interface FakeBridgeOptions {
	firstTabRaceReads?: number;
	initialModel?: string;
	modelSelectorAbsent?: boolean;
	modelAvailable?: boolean;
	modelReadbackMismatch?: boolean;
	modelChangesBeforeSend?: boolean;
	foreignSession?: boolean;
	reloadToHome?: boolean;
	conversationRenderNeedsReload?: boolean;
	driftToDifferentConversation?: boolean;
	scenarioForPrompt?: (prompt: string) => FakeScenario;
}

interface FakeTurn {
	prompt: string;
	scenario: FakeScenario;
	phase: number;
	released: boolean;
	recovered: boolean;
	conversationId: string;
}

interface FakeTab {
	id: number;
	sessionId: string;
	url: string;
	newTabReads: number;
	model: string;
	menuOpen: boolean;
	filled: string;
	turns: FakeTurn[];
	state: string;
	restoredUrl?: string;
	reloadsAtConversation: number;
	conversationUrlReads: number;
	didDriftConversation: boolean;
	name: string;
}

export class FakeChromeBridge {
	readonly launcher: Launcher = {
		command: "fake-chrome-bridge",
		args: [],
		origin: "deterministic fake",
		privateRpc: {
			command: "fake-python",
			args: ["fake-helper.py"],
			clientScript: "/private/fake-test-client.py",
			origin: "deterministic private request-file RPC",
		},
	};
	readonly calls: Array<{ command: string; args: string[] }> = [];
	readonly privateRequests: Array<{ action: string; payload: Record<string, unknown> }> = [];
	readonly uploadedFiles: string[][] = [];
	readonly submittedPrompts: string[] = [];
	readonly unsafeOriginActions: string[] = [];
	private readonly tabs = new Map<number, FakeTab>();
	private nextTab = 70;
	private nextSession = 1;
	private readonly sessionNames = new Map<string, string>();
	readonly stopClicks: number[] = [];

	constructor(readonly options: FakeBridgeOptions = {}) {}

	readonly exec: Exec = async (command, args): Promise<ExecResult> => {
		this.calls.push({ command, args: [...args] });
		try {
			if (command === this.launcher.privateRpc?.command) {
				return this.handlePrivate(args);
			}
			return this.handleBridge(args);
		} catch (error) {
			return {
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				code: 1,
				killed: false,
			};
		}
	};

	capabilities(): Capabilities {
		const driver = new ChromeBridgeBrowserDriver(this.exec, this.launcher);
		return {
			browser: {
				driver,
				probe: { ready: true, driver: driver.id, secureInput: true, protocolVersion: BROWSER_DRIVER_PROTOCOL_VERSION },
				source: "deterministic fake",
			},
		};
	}

	activeTabs(): number[] {
		return [...this.tabs.keys()];
	}

	release(tabId?: number): void {
		for (const tab of this.tabs.values()) {
			if (tabId !== undefined && tab.id !== tabId) continue;
			const turn = tab.turns.at(-1);
			if (turn) turn.released = true;
		}
	}

	forceFinal(tabId?: number): void {
		for (const tab of this.tabs.values()) {
			if (tabId !== undefined && tab.id !== tabId) continue;
			const turn = tab.turns.at(-1);
			if (turn) {
				turn.released = true;
				turn.recovered = true;
				turn.phase = 20;
			}
		}
	}

	setUrl(url: string, tabId?: number): void {
		for (const tab of this.tabs.values()) {
			if (tabId === undefined || tab.id === tabId) tab.url = url;
		}
	}

	setModel(label: string, tabId?: number): void {
		for (const tab of this.tabs.values()) {
			if (tabId === undefined || tab.id === tabId) tab.model = label;
		}
	}

	private handlePrivate(args: string[]): ExecResult {
		const requestPath = args.at(-1);
		if (!requestPath) throw new Error("private request path missing");
		const request = JSON.parse(readFileSync(requestPath, "utf8")) as { action: string; payload: Record<string, unknown> };
		this.privateRequests.push(request);
		const tab = this.requireTab(Number(request.payload.tabId));
		if (!tab.url.startsWith("https://chatgpt.com")) this.unsafeOriginActions.push(`${request.action}:${tab.url}`);
		if (request.action === "fill") {
			const text = String(request.payload.text ?? "");
			if (this.scenario(text) === "fail_fill") return failed("deterministic fill failure");
			tab.filled = text;
			if (this.options.modelChangesBeforeSend) tab.model = "Auto";
			return ok({ success: true });
		}
		if (request.action === "uploadFile") {
			const files = Array.isArray(request.payload.files) ? request.payload.files.map(String) : [];
			this.uploadedFiles.push(files);
			return ok({ success: true });
		}
		return failed(`unsupported private action ${request.action}`);
	}

	private handleBridge(args: string[]): ExecResult {
		const action = args[0];
		if (action === "ready") return json({ endpointStatus: "reachable", extension: "connected", endpoint: "fake" });
		if (action === "taskSession") return this.handleSession(args.slice(1));
		if (action === "getTabs") return ok({ tabs: [...this.tabs.values()].map((tab) => ({ id: tab.id, url: this.nextUrl(tab) })) });
		if (action === "getHTML") {
			const tab = this.requireTab(Number(args[1]));
			writeFileSync(args[2], this.html(tab));
			return ok({ success: true });
		}
		if (action === "click") return this.handleClick(Number(args[1]), String(args[2]));
		if (action === "reload") return this.handleReload(Number(args[1]));
		if (action === "screenshot") {
			this.requireTab(Number(args[1]));
			writeFileSync(args[2], Buffer.from("fake-png"));
			return ok({ success: true });
		}
		return ok({ success: true });
	}

	private handleSession(args: string[]): ExecResult {
		const operation = args[0];
		if (operation === "create") {
			const sessionId = `fake-session-${this.nextSession++}`;
			this.sessionNames.set(sessionId, String(args[1] ?? ""));
			return ok({ sessionId });
		}
		if (operation === "navigate") {
			const sessionId = String(args[1]);
			const url = String(args[2]);
			const existing = [...this.tabs.values()].find((tab) => tab.sessionId === sessionId);
			if (existing) {
				existing.url = url;
				existing.restoredUrl = url;
				return ok({ tabId: existing.id });
			}
			const id = this.nextTab++;
			this.tabs.set(id, {
				id,
				sessionId,
				url: (this.options.firstTabRaceReads ?? 0) > 0 ? "chrome://newtab/" : url,
				newTabReads: 0,
				model: this.options.initialModel ?? "Pro",
				menuOpen: false,
				filled: "",
				turns: [],
				state: "working",
				reloadsAtConversation: 0,
				conversationUrlReads: 0,
				didDriftConversation: false,
				name: this.sessionNames.get(sessionId) ?? "",
			});
			return ok({ tabId: id });
		}
		if (operation === "show") {
			const sessionId = String(args[1]);
			const tab = [...this.tabs.values()].find((value) => value.sessionId === sessionId);
			if (!tab) return failed("session not found");
			return ok({
				sessionId,
				name: this.options.foreignSession ? "other-tool" : tab.name,
				tabIds: [tab.id],
				state: tab.state,
			});
		}
		if (operation === "state") {
			const tab = [...this.tabs.values()].find((value) => value.sessionId === String(args[1]));
			if (tab) tab.state = String(args[2]);
			return ok({ success: true });
		}
		if (operation === "close") {
			const tab = [...this.tabs.values()].find((value) => value.sessionId === String(args[1]));
			if (tab) this.tabs.delete(tab.id);
			this.sessionNames.delete(String(args[1]));
			return ok({ success: true });
		}
		return failed(`unsupported taskSession operation ${operation}`);
	}

	private handleClick(tabId: number, selector: string): ExecResult {
		const tab = this.requireTab(tabId);
		if (selector.includes("model-switcher") || selector.includes("model-selector") || selector.includes("composer-model")) {
			tab.menuOpen = true;
			return ok({ success: true });
		}
		if (selector === "text=Pro") {
			if (this.options.modelAvailable === false) return failed("No element found");
			tab.model = this.options.modelReadbackMismatch ? "Auto" : "Pro";
			tab.menuOpen = false;
			return ok({ success: true });
		}
		if (selector.includes("send-button") || selector.includes("Send prompt") || selector.includes("composer-send")) {
			if (!tab.filled) return failed("prompt is empty");
			const prompt = tab.filled;
			this.submittedPrompts.push(prompt);
			const conversationId = `fake-${tab.id}-${tab.turns.length + 1}`;
			tab.turns.push({
				prompt,
				scenario: this.scenario(prompt),
				phase: 0,
				released: false,
				recovered: false,
				conversationId,
			});
			tab.url = `https://chatgpt.com/c/${conversationId}`;
			tab.filled = "";
			return ok({ success: true });
		}
		if (selector === "text=Retry") {
			const turn = tab.turns.at(-1);
			if (turn?.scenario === "network_recover") turn.recovered = true;
			return ok({ success: true });
		}
		if (selector === "text=Continue generating" || selector === "text=Continue response" || selector === "text=Continue") return ok({ success: true });
		if (selector.includes("stop") || selector.includes("Stop")) {
			this.stopClicks.push(tabId);
			const turn = tab.turns.at(-1);
			if (turn) turn.released = true;
			return ok({ success: true });
		}
		return failed("No element found");
	}

	private handleReload(tabId: number): ExecResult {
		const tab = this.requireTab(tabId);
		const turn = tab.turns.at(-1);
		if (this.options.reloadToHome && tab.url.includes("/c/") && tab.reloadsAtConversation === 0) {
			tab.url = "https://chatgpt.com/";
			return ok({ success: true });
		}
		if (tab.url.includes("/c/")) {
			tab.reloadsAtConversation += 1;
			if (turn && this.options.conversationRenderNeedsReload) turn.recovered = true;
		}
		return ok({ success: true });
	}

	private nextUrl(tab: FakeTab): string {
		if (tab.url === "chrome://newtab/") {
			tab.newTabReads += 1;
			if (tab.newTabReads > (this.options.firstTabRaceReads ?? 0)) tab.url = "https://chatgpt.com/";
		}
		if (this.options.driftToDifferentConversation && tab.url.includes("/c/")) {
			if (tab.conversationUrlReads >= 1 && !tab.didDriftConversation) {
				tab.url = `https://chatgpt.com/c/foreign-${tab.id}`;
				tab.didDriftConversation = true;
			}
			tab.conversationUrlReads += 1;
		}
		return tab.url;
	}

	private html(tab: FakeTab): string {
		const account = '<div data-testid="account-plan">Miles Pro</div>';
		const composer = this.options.modelSelectorAbsent
			? '<form data-testid="composer"><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></form>'
			: `<form data-testid="composer"><button data-testid="model-switcher-dropdown-button" aria-label="Model selector">${escapeHtml(tab.model)}</button><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></form>`;
		const menu = tab.menuOpen && this.options.modelAvailable !== false
			? '<div role="menu"><button role="menuitem">Pro</button></div>'
			: tab.menuOpen ? '<div role="menu"><button role="menuitem">Auto</button></div>' : "";
		const turns = tab.turns.map((turn, index) => this.turnHtml(turn, index === tab.turns.length - 1)).join("");
		return `<main>${account}${turns}${composer}${menu}</main>`;
	}

	private turnHtml(turn: FakeTurn, current: boolean): string {
		if (!current) return finalAssistant(turn);
		const phase = turn.phase++;
		if (turn.scenario === "false_completion" && phase < 4) {
			return '<div data-message-author-role="assistant"><div class="markdown"><p>Pro thinking</p></div></div><div role="status">Pro thinking</div><button data-testid="stop-button" aria-label="Stop answering">Stop</button>';
		}
		if (turn.scenario === "network_recover" && !turn.recovered) {
			return '<div role="alert">Network error</div><button>Retry</button>';
		}
		if (turn.scenario === "network_persistent") {
			return '<div role="alert">Network error</div><button>Retry</button>';
		}
		if (turn.scenario === "continue_persistent") {
			return '<div data-message-author-role="assistant"><div class="markdown"><p>partial response</p></div></div><button>Continue generating</button>';
		}
		if (turn.scenario === "slow" && !turn.released) {
			return '<div data-message-author-role="assistant"><div class="markdown"><p>partial work</p></div></div><div role="status">Running tool</div><button data-testid="stop-button" aria-label="Stop answering">Stop</button>';
		}
		if (this.options.conversationRenderNeedsReload && !turn.recovered && phase < 2) {
			return '<div role="alert">Connection lost</div><button>Retry</button>';
		}
		if (phase === 0 && turn.scenario === "success") {
			return '<div role="status">Pro thinking</div><button data-testid="stop-button" aria-label="Stop answering">Stop</button>';
		}
		return finalAssistant(turn);
	}

	private scenario(prompt: string): FakeScenario {
		if (this.options.scenarioForPrompt) return this.options.scenarioForPrompt(prompt);
		if (prompt.includes("[false-completion]")) return "false_completion";
		if (prompt.includes("[network-recover]")) return "network_recover";
		if (prompt.includes("[network-persistent]")) return "network_persistent";
		if (prompt.includes("[input-required]")) return "continue_persistent";
		if (prompt.includes("[slow]")) return "slow";
		if (prompt.includes("[fail-start]")) return "fail_fill";
		return "success";
	}

	private requireTab(tabId: number): FakeTab {
		const tab = this.tabs.get(tabId);
		if (!tab) throw new Error(`tab ${tabId} not found`);
		return tab;
	}
}

export function makeChromeService(
	root: string,
	workspace: string,
	bridge = new FakeChromeBridge(),
	overrides: OperatorPolicyInput = {},
): { service: GptControlService; bridge: FakeChromeBridge; store: RunStore } {
	const store = new RunStore(root);
	const policy = operatorPolicyFromEnv({}, {
		workspaceRoot: workspace,
		storageRoot: root,
		snapshotRoot: join(root, "snapshots"),
		outputRoot: join(root, "generated"),
		allowedTransports: ["browser"],
		defaultChatGptModel: "pro",
		maxConcurrentWorkers: 3,
		...overrides,
	});
	const service = new GptControlService(bridge.exec, store, policy, {
		resolveCapabilities: async () => bridge.capabilities(),
	});
	return { service, bridge, store };
}

export function ok(result: unknown): ExecResult {
	return json({ success: true, result });
}

export function failed(message: string): ExecResult {
	return json({ success: false, error: message }, 1, message);
}

function json(value: unknown, code = 0, stderr = ""): ExecResult {
	return { stdout: JSON.stringify(value), stderr, code, killed: false };
}

function finalAssistant(turn: FakeTurn): string {
	return `<div data-message-author-role="assistant" data-message-id="assistant-${escapeHtml(turn.conversationId)}"><div class="markdown"><p>final:${escapeHtml(turn.prompt)}</p></div></div>`;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
