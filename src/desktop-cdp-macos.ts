import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import {
	type DesktopCdpAction,
	type DesktopCdpEnvironment,
	type DesktopCdpTarget,
	type DesktopHostReceipt,
} from "./desktop-driver";

const execFileAsync = promisify(execFile);
const OFFICIAL_TEAM_ID = "2DC432GLL2";
const OFFICIAL_BUNDLE_IDS = new Set(["com.openai.codex", "com.openai.chat"]);
const DEFAULT_APP_PATH = "/Applications/ChatGPT.app";
const DEFAULT_ENDPOINT = "http://127.0.0.1:9236";

interface CdpTargetDescriptor extends DesktopCdpTarget {
	webSocketDebuggerUrl: string;
}

export function createMacDesktopCdpEnvironment(env: NodeJS.ProcessEnv = process.env): MacDesktopCdpEnvironment {
	return new MacDesktopCdpEnvironment(
		env.GPT_CONTROL_DRIVER_DESKTOP_CDP_ENDPOINT ?? DEFAULT_ENDPOINT,
		env.GPT_CONTROL_DRIVER_DESKTOP_APP_PATH ?? DEFAULT_APP_PATH,
	);
}

export class MacDesktopCdpEnvironment implements DesktopCdpEnvironment {
	private readonly endpoint: URL;
	private readonly appPath: string;

	constructor(endpoint: string, appPath = DEFAULT_APP_PATH) {
		this.endpoint = parseLoopbackEndpoint(endpoint);
		this.appPath = appPath;
	}

	async verifyHost(): Promise<DesktopHostReceipt> {
		if (process.platform !== "darwin") throw new Error("ChatGPT Desktop CDP requires macOS.");
		const executable = await realpath(`${this.appPath}/Contents/MacOS/ChatGPT`);
		const signature = await command("/usr/bin/codesign", ["-dv", "--verbose=4", this.appPath], 10_000, true);
		const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1]?.trim();
		const teamId = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim();
		if (!identifier || !OFFICIAL_BUNDLE_IDS.has(identifier) || teamId !== OFFICIAL_TEAM_ID) {
			throw new Error(`Refused unverified ChatGPT.app signature (bundle=${identifier ?? "unknown"}, team=${teamId ?? "unknown"}).`);
		}
		const listener = await this.listenerReceipt();
		const processExecutable = (await command("/bin/ps", ["-p", String(listener.pid), "-o", "comm="], 5_000)).trim();
		if (await realpath(processExecutable) !== executable) {
			throw new Error(`CDP listener PID ${listener.pid} is not the verified ChatGPT.app executable.`);
		}
		const commandLine = (await command("/bin/ps", ["-p", String(listener.pid), "-o", "command="], 5_000)).trim();
		if (!commandLine.includes(`--remote-debugging-port=${this.endpoint.port}`)
			|| !commandLine.includes("--remote-debugging-address=127.0.0.1")) {
			throw new Error("ChatGPT.app CDP listener lacks the required explicit loopback debugging arguments.");
		}
		const version = await this.fetchJson("/json/version") as Record<string, unknown>;
		const browserVersion = requiredString(version.Browser, "CDP Browser version");
		const browserSocket = new URL(requiredString(version.webSocketDebuggerUrl, "CDP browser WebSocket URL"));
		assertLoopbackWebSocket(browserSocket, this.endpoint.port);
		return {
			appPath: this.appPath,
			bundleId: identifier,
			teamId,
			listenerPid: listener.pid,
			endpoint: this.endpoint.origin,
			browserVersion,
		};
	}

	async listTargets(): Promise<DesktopCdpTarget[]> {
		return (await this.targetDescriptors()).map(({ id, type, title, url }) => ({ id, type, title, url }));
	}

	async createTarget(url: string): Promise<DesktopCdpTarget> {
		const response = await fetch(new URL(`/json/new?${encodeURIComponent(url)}`, this.endpoint), { method: "PUT" });
		if (!response.ok) throw new Error(`ChatGPT Desktop could not create a renderer (HTTP ${response.status}).`);
		const target = parseTarget(await response.json(), this.endpoint.port);
		return { id: target.id, type: target.type, title: target.title, url: target.url };
	}

	async navigateTarget(targetId: string, url: string): Promise<DesktopCdpTarget> {
		await this.cdp(targetId, "Page.enable");
		await this.cdp(targetId, "Page.navigate", { url });
		const deadline = Date.now() + 30_000;
		let last = "";
		while (Date.now() < deadline) {
			const target = (await this.targetDescriptors()).find((candidate) => candidate.id === targetId);
			if (!target) throw new Error("ChatGPT Desktop renderer closed during navigation.");
			last = target.url;
			if (sameNavigationDestination(target.url, url)) return { id: target.id, type: target.type, title: target.title, url: target.url };
			await sleep(100);
		}
		throw new Error(`ChatGPT Desktop renderer did not reach ${url}; last URL was ${last || "unavailable"}.`);
	}

	async readHtml(targetId: string): Promise<string> {
		return requiredString(await this.evaluate(targetId, "document.documentElement?.outerHTML || ''"), "desktop page HTML");
	}

	async act(targetId: string, action: DesktopCdpAction): Promise<unknown> {
		if (action.kind === "reload") {
			await this.assertRuntimeUrl(targetId, action.expectedUrl);
			await this.cdp(targetId, "Page.reload", { ignoreCache: false });
			return { success: true };
		}
		if (action.kind === "press") {
			await this.assertRuntimeUrl(targetId, action.expectedUrl);
			await this.cdp(targetId, "Input.dispatchKeyEvent", { type: "keyDown", key: action.key });
			await this.cdp(targetId, "Input.dispatchKeyEvent", { type: "keyUp", key: action.key });
			return { success: true };
		}
		if (action.kind === "upload") {
			await this.assertRuntimeUrl(targetId, action.expectedUrl);
			const document = await this.cdp(targetId, "DOM.getDocument", { depth: 1, pierce: true }) as { root?: { nodeId?: unknown } };
			const nodeId = document.root?.nodeId;
			if (typeof nodeId !== "number") throw new Error("CDP returned no document node.");
			const query = await this.cdp(targetId, "DOM.querySelector", { nodeId, selector: action.selector }) as { nodeId?: unknown };
			if (typeof query.nodeId !== "number" || query.nodeId <= 0) throw new Error(`No element found: ${action.selector}`);
			await this.cdp(targetId, "DOM.setFileInputFiles", { nodeId: query.nodeId, files: action.files });
			return { success: true };
		}
		const payload = JSON.stringify(action);
		return this.evaluate(targetId, `(() => {
			const action = ${payload};
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			if (action.expectedUrl && canonical(location.href) !== canonical(action.expectedUrl)) throw new Error('expectedTarget exact URL changed before the browser action');
			const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
			const find = selector => {
				if (selector.startsWith('text=')) {
					const name = normalized(selector.slice(5));
					return [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],a')]
						.find(element => normalized(element.getAttribute('aria-label') || element.textContent) === name);
				}
				const role = /^role=([^[]+)\\[name=(.*)\\]$/.exec(selector);
				if (role) {
					const candidates = role[1] === 'button' ? document.querySelectorAll('button,[role="button"]') : document.querySelectorAll('[role="' + role[1] + '"]');
					return [...candidates].find(element => normalized(element.getAttribute('aria-label') || element.textContent) === normalized(role[2]));
				}
				return document.querySelector(selector);
			};
			const element = find(action.selector);
			if (!element) throw new Error('No element found: ' + action.selector);
			element.scrollIntoView({ block: 'center', inline: 'center' });
			if (action.kind === 'fill') {
				element.focus();
				if ('value' in element) {
					const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, action.text);
				} else {
					const selection = getSelection();
					selection.removeAllRanges();
					const range = document.createRange();
					range.selectNodeContents(element);
					selection.addRange(range);
					document.execCommand('insertText', false, action.text);
				}
				element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text }));
				element.dispatchEvent(new Event('change', { bubbles: true }));
			} else if (action.kind === 'click') {
				element.click();
			} else if (action.kind === 'hover') {
				element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
				element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
			}
			return { success: true };
		})()`);
	}

	async screenshot(targetId: string): Promise<string> {
		const result = await this.cdp(targetId, "Page.captureScreenshot", { format: "png", fromSurface: true }) as { data?: unknown };
		return requiredString(result.data, "CDP screenshot data");
	}

	async closeTarget(targetId: string): Promise<void> {
		const response = await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, this.endpoint), { method: "PUT" });
		if (!response.ok && response.status !== 404) throw new Error(`ChatGPT Desktop could not close renderer ${targetId} (HTTP ${response.status}).`);
	}

	private async listenerReceipt(): Promise<{ pid: number }> {
		const output = await command("/usr/sbin/lsof", ["-nP", `-iTCP:${this.endpoint.port}`, "-sTCP:LISTEN", "-Fpctn"], 5_000);
		const records = parseLsofRecords(output);
		if (records.length !== 1) throw new Error(`Expected one ChatGPT Desktop CDP listener on ${this.endpoint.origin}; found ${records.length}.`);
		const record = records[0];
		if (!record.names.length || record.names.some((name) => !isLoopbackListenerName(name, this.endpoint.port))) {
			throw new Error(`Refused non-loopback ChatGPT Desktop CDP listener: ${record.names.join(", ") || "unknown"}.`);
		}
		return { pid: record.pid };
	}

	private async targetDescriptors(): Promise<CdpTargetDescriptor[]> {
		const value = await this.fetchJson("/json/list");
		return parseCdpTargetList(value, this.endpoint.port);
	}

	private async fetchJson(path: string): Promise<unknown> {
		const response = await fetch(new URL(path, this.endpoint), { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) throw new Error(`ChatGPT Desktop CDP endpoint returned HTTP ${response.status} for ${path}.`);
		return response.json();
	}

	private async cdp(targetId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const target = (await this.targetDescriptors()).find((candidate) => candidate.id === targetId);
		if (!target) throw new Error(`ChatGPT Desktop target ${targetId} is unavailable.`);
		return cdpRequest(target.webSocketDebuggerUrl, method, params);
	}

	private async evaluate(targetId: string, expression: string): Promise<unknown> {
		const response = await this.cdp(targetId, "Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		}) as { result?: { value?: unknown; description?: unknown }; exceptionDetails?: { text?: unknown; exception?: { description?: unknown } } };
		if (response.exceptionDetails) {
			throw new Error(String(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "CDP evaluation failed."));
		}
		return response.result?.value;
	}

	private async assertRuntimeUrl(targetId: string, expectedUrl?: string): Promise<void> {
		if (!expectedUrl) return;
		const current = requiredString(await this.evaluate(targetId, "location.href"), "current renderer URL");
		if (!sameNavigationDestination(current, expectedUrl)) throw new Error("expectedTarget exact URL changed before the browser action");
	}
}

export function parseLoopbackEndpoint(raw: string): URL {
	let endpoint: URL;
	try { endpoint = new URL(raw); } catch { throw new Error(`Invalid ChatGPT Desktop CDP endpoint: ${raw}`); }
	if (endpoint.protocol !== "http:"
		|| (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost")
		|| !endpoint.port
		|| endpoint.username
		|| endpoint.password
		|| endpoint.pathname !== "/"
		|| endpoint.search
		|| endpoint.hash) {
		throw new Error("ChatGPT Desktop CDP endpoint must be an explicit loopback HTTP origin with a port.");
	}
	return endpoint;
}

export function parseCdpTargetList(value: unknown, port: string): CdpTargetDescriptor[] {
	if (!Array.isArray(value)) throw new Error("ChatGPT Desktop CDP target list is invalid.");
	return value
		.filter((target) => isRecord(target) && (target.type === "page" || target.type === "webview"))
		.map((target) => parseTarget(target, port));
}

function parseTarget(value: unknown, port: string): CdpTargetDescriptor {
	if (!isRecord(value)) throw new Error("Invalid ChatGPT Desktop CDP target.");
	const type = requiredString(value.type, "target type");
	if (type !== "page" && type !== "webview") throw new Error(`Ineligible ChatGPT Desktop CDP target type: ${type}`);
	const socket = new URL(requiredString(value.webSocketDebuggerUrl, "target WebSocket URL"));
	assertLoopbackWebSocket(socket, port);
	return {
		id: requiredString(value.id, "target id"),
		type,
		title: typeof value.title === "string" ? value.title : "",
		url: requiredString(value.url, "target URL"),
		webSocketDebuggerUrl: socket.toString(),
	};
}

function assertLoopbackWebSocket(socket: URL, port: string): void {
	if (socket.protocol !== "ws:"
		|| (socket.hostname !== "127.0.0.1" && socket.hostname !== "localhost")
		|| socket.port !== port) {
		throw new Error(`Refused non-loopback CDP WebSocket: ${socket.toString()}`);
	}
}

async function cdpRequest(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const id = 1;
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error(`CDP ${method} timed out.`));
		}, 30_000);
		const finish = (work: () => void) => {
			clearTimeout(timer);
			try { socket.close(); } catch {}
			work();
		};
		socket.addEventListener("open", () => socket.send(JSON.stringify({ id, method, params })));
		socket.addEventListener("error", () => finish(() => reject(new Error(`CDP ${method} WebSocket failed.`))));
		socket.addEventListener("message", (event) => {
			let message: unknown;
			try { message = JSON.parse(String(event.data)); } catch { return; }
			if (!isRecord(message) || message.id !== id) return;
			if (isRecord(message.error)) {
				const detail = String(message.error.message ?? `CDP ${method} failed.`);
				finish(() => reject(new Error(detail)));
				return;
			}
			finish(() => resolve(message.result));
		});
	});
}

interface LsofRecord { pid: number; names: string[] }
function parseLsofRecords(output: string): LsofRecord[] {
	const records = new Map<number, LsofRecord>();
	let current: LsofRecord | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			const pid = Number(line.slice(1));
			if (!Number.isInteger(pid) || pid <= 0) continue;
			current = records.get(pid) ?? { pid, names: [] };
			records.set(pid, current);
		} else if (line.startsWith("n") && current) current.names.push(line.slice(1));
	}
	return [...records.values()];
}

function isLoopbackListenerName(name: string, port: string): boolean {
	return name === `127.0.0.1:${port}` || name === `[::1]:${port}` || name === `localhost:${port}`;
}

async function command(path: string, args: string[], timeout: number, includeStderr = false): Promise<string> {
	try {
		const result = await execFileAsync(path, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8" });
		return `${result.stdout}${includeStderr ? result.stderr : ""}`;
	} catch (error) {
		if (isRecord(error)) {
			const detail = String(error.stderr ?? error.stdout ?? error.message ?? `${path} failed`);
			throw new Error(detail.trim());
		}
		throw error;
	}
}

function sameNavigationDestination(left: string, right: string): boolean {
	try {
		const a = new URL(left);
		const b = new URL(right);
		return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") && a.search === b.search;
	} catch { return false; }
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`Missing ${name}.`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
