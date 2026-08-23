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

export interface DesktopShellEvidence {
	runtimeUrl: string;
	chatGptMode: boolean;
	composerReady: boolean;
	modelSelectorReady: boolean;
	conversationActionsPresent: boolean;
	turnCount: number;
	conversationIds: string[];
}

export interface DesktopListenerProcess {
	pid: number;
	executable: string;
	teamId: string;
	ancestry: number[];
	names: string[];
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
		const listenerPid = await this.listenerReceipt(executable);
		const processExecutable = (await command("/bin/ps", ["-p", String(listenerPid), "-o", "comm="], 5_000)).trim();
		if (await realpath(processExecutable) !== executable) {
			throw new Error(`CDP listener PID ${listenerPid} is not the verified ChatGPT.app executable.`);
		}
		const commandLine = (await command("/bin/ps", ["-p", String(listenerPid), "-o", "command="], 5_000)).trim();
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
			listenerPid,
			endpoint: this.endpoint.origin,
			browserVersion,
		};
	}

	async listTargets(): Promise<DesktopCdpTarget[]> {
		const targets: DesktopCdpTarget[] = [];
		for (const target of await this.targetDescriptors()) {
			if (isDesktopShellRuntimeUrl(target.url)) {
				const providerUrl = resolveDesktopShellProviderUrl(await this.desktopShellEvidence(target.id));
				if (providerUrl) {
					targets.push({
						id: target.id,
						type: target.type,
						title: target.title,
						url: providerUrl,
						runtimeUrl: target.url,
						surface: "desktop_shell",
					});
					continue;
				}
			}
			targets.push({ id: target.id, type: target.type, title: target.title, url: target.url, runtimeUrl: target.url, surface: "web" });
		}
		return targets;
	}

	async createTarget(url: string): Promise<DesktopCdpTarget> {
		const requested = new URL(url);
		if (requested.origin !== "https://chatgpt.com" || requested.pathname !== "/" || requested.search || requested.hash) {
			throw new Error("ChatGPT Desktop can create only a native new-chat window; exact-conversation creation is not supported.");
		}
		const host = await this.verifyHost();
		const previousFrontmostPid = Number((await command("/usr/bin/osascript", [
			"-e",
			'tell application "System Events" to get unix id of first application process whose frontmost is true',
		], 5_000)).trim());
		const before = new Set((await this.targetDescriptors()).map((target) => target.id));
		try {
			await command("/usr/bin/osascript", [
				"-e",
				`tell application "System Events" to tell (first process whose unix id is ${host.listenerPid}) to click menu item "New Window" of menu 1 of menu bar item "File" of menu bar 1`,
			], 10_000);
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const candidates = (await this.targetDescriptors())
					.filter((target) => !before.has(target.id) && isDesktopShellRuntimeUrl(target.url));
				const ready: DesktopCdpTarget[] = [];
				for (const candidate of candidates) {
					const providerUrl = resolveDesktopShellProviderUrl(await this.desktopShellEvidence(candidate.id));
					if (!providerUrl) continue;
					ready.push({
						id: candidate.id,
						type: candidate.type,
						title: candidate.title,
						url: providerUrl,
						runtimeUrl: candidate.url,
						surface: "desktop_shell",
					});
				}
				if (ready.length > 1) throw new Error("ChatGPT Desktop New Window created ambiguous native renderers.");
				if (ready.length === 1) return ready[0];
				await sleep(100);
			}
			throw new Error("ChatGPT Desktop New Window did not expose one ready signed-in native renderer.");
		} finally {
			if (Number.isSafeInteger(previousFrontmostPid) && previousFrontmostPid > 0 && previousFrontmostPid !== host.listenerPid) {
				await command("/usr/bin/osascript", [
					"-e",
					`tell application "System Events" to set frontmost of (first application process whose unix id is ${previousFrontmostPid}) to true`,
				], 5_000).catch(() => undefined);
			}
		}
	}

	async navigateTarget(targetId: string, url: string): Promise<DesktopCdpTarget> {
		const current = (await this.targetDescriptors()).find((candidate) => candidate.id === targetId);
		if (!current) throw new Error("ChatGPT Desktop renderer closed during navigation.");
		if (isDesktopShellRuntimeUrl(current.url)) {
			const requested = new URL(url);
			const existing = (await this.listTargets()).find((candidate) => candidate.id === targetId);
			if (sameNavigationDestination(existing?.url ?? "", url)) return existing!;
			if (requested.origin !== "https://chatgpt.com" || requested.search || requested.hash) {
				throw new Error("ChatGPT Desktop refused navigation outside the signed-in ChatGPT shell.");
			}
			const directConversation = /^\/c\/([A-Za-z0-9_-]{8,128})\/?$/.exec(requested.pathname);
			if (directConversation) {
				if (!existing?.url) throw new Error("ChatGPT Desktop current provider identity is unavailable before exact-conversation navigation.");
				await this.openDesktopConversation(targetId, directConversation[1], existing.url);
				const deadline = Date.now() + 30_000;
				let stable = 0;
				while (Date.now() < deadline) {
					const target = (await this.listTargets()).find((candidate) => candidate.id === targetId);
					stable = target?.surface === "desktop_shell" && sameNavigationDestination(target.url, url) ? stable + 1 : 0;
					if (stable >= 3) return target!;
					await sleep(200);
				}
				throw new Error("ChatGPT Desktop did not open the exact native sidebar conversation.");
			}
			if (requested.pathname !== "/") {
				throw new Error("ChatGPT Desktop supports only native new-chat and direct /c/<id> navigation.");
			}
			await this.openDesktopNewChat(targetId, existing!.url);
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const target = (await this.listTargets()).find((candidate) => candidate.id === targetId);
				if (target?.surface === "desktop_shell" && sameNavigationDestination(target.url, url)) return target;
				await sleep(100);
			}
			throw new Error("ChatGPT Desktop did not reach a ready native new-chat surface.");
		}
		await this.cdp(targetId, "Page.enable");
		await this.cdp(targetId, "Page.navigate", { url });
		const deadline = Date.now() + 30_000;
		let last = "";
		while (Date.now() < deadline) {
			const target = (await this.targetDescriptors()).find((candidate) => candidate.id === targetId);
			if (!target) throw new Error("ChatGPT Desktop renderer closed during navigation.");
			last = target.url;
			if (sameNavigationDestination(target.url, url)) return { id: target.id, type: target.type, title: target.title, url: target.url, runtimeUrl: target.url, surface: "web" };
			await sleep(100);
		}
		throw new Error(`ChatGPT Desktop renderer did not reach ${url}; last URL was ${last || "unavailable"}.`);
	}

	async readHtml(targetId: string): Promise<string> {
		return requiredString(await this.evaluate(targetId, "document.documentElement?.outerHTML || ''"), "desktop page HTML");
	}

	async elementExists(targetId: string, selector: string, expectedUrl?: string): Promise<boolean> {
		await this.assertRuntimeUrl(targetId, expectedUrl);
		const payload = JSON.stringify(selector);
		return Boolean(await this.evaluate(targetId, `(() => {
			const selector = ${payload};
			const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
			if (selector.startsWith('text=')) {
				const name = normalized(selector.slice(5));
				return [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],a')]
					.some(element => normalized(element.getAttribute('aria-label') || element.textContent) === name);
			}
			const role = /^role=([^[]+)\\[name=(.*)\\]$/.exec(selector);
			if (role) {
				const candidates = role[1] === 'button' ? document.querySelectorAll('button,[role="button"]') : document.querySelectorAll('[role="' + role[1] + '"]');
				return [...candidates].some(element => normalized(element.getAttribute('aria-label') || element.textContent) === normalized(role[2]));
			}
			return Boolean(document.querySelector(selector));
		})()`));
	}

	async act(targetId: string, action: DesktopCdpAction): Promise<unknown> {
		const runtime = (await this.targetDescriptors()).find((candidate) => candidate.id === targetId)?.url;
		const desktopShell = isDesktopShellRuntimeUrl(runtime ?? "");
		if (desktopShell && (action.kind === "reload" || action.kind === "press" || action.kind === "upload")) {
			throw new Error(`ChatGPT Desktop native-shell ${action.kind} is disabled until it can verify provider identity atomically.`);
		}
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
		if (desktopShell && !action.expectedUrl) throw new Error("ChatGPT Desktop native-shell mutation requires an exact provider URL.");
		if (desktopShell && action.kind === "click") {
			return this.trustedDesktopShellClick(targetId, action.selector, action.expectedUrl!);
		}
		const payload = JSON.stringify(desktopShell
			? { ...action, expectedProviderUrl: action.expectedUrl, expectedUrl: undefined }
			: action);
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		return this.evaluate(targetId, `(() => {
			const action = ${payload};
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			if (action.expectedProviderUrl) {
				const evidence = (${evidenceReader})();
				const currentProviderUrl = (${providerResolver})(evidence);
				if (!currentProviderUrl || canonical(currentProviderUrl) !== canonical(action.expectedProviderUrl)) {
					throw new Error('expectedTarget exact ChatGPT conversation changed before the browser action');
				}
			}
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

	private async trustedDesktopShellClick(targetId: string, selector: string, expectedProviderUrl: string): Promise<unknown> {
		const payload = JSON.stringify({ selector, expectedProviderUrl });
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		const point = await this.evaluate(targetId, `(() => {
			const action = ${payload};
			const guardKey = '__gptControlTrustedClickGuard';
			if (window[guardKey]) throw new Error('A trusted ChatGPT Desktop click is already pending.');
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			const currentProviderUrl = (${providerResolver})((${evidenceReader})());
			if (!currentProviderUrl || canonical(currentProviderUrl) !== canonical(action.expectedProviderUrl)) {
				throw new Error('expectedTarget exact ChatGPT conversation changed before the browser action');
			}
			const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
			const find = candidate => {
				if (candidate.startsWith('text=')) {
					const name = normalized(candidate.slice(5));
					return [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],a')]
						.find(element => normalized(element.getAttribute('aria-label') || element.textContent) === name);
				}
				const role = /^role=([^[]+)\\[name=(.*)\\]$/.exec(candidate);
				if (role) {
					const candidates = role[1] === 'button' ? document.querySelectorAll('button,[role="button"]') : document.querySelectorAll('[role="' + role[1] + '"]');
					return [...candidates].find(element => normalized(element.getAttribute('aria-label') || element.textContent) === normalized(role[2]));
				}
				return document.querySelector(candidate);
			};
			const element = find(action.selector);
			if (!element) throw new Error('No element found: ' + action.selector);
			element.scrollIntoView({ block: 'center', inline: 'center' });
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) throw new Error('ChatGPT Desktop click target has no visible bounds.');
			const state = { status: 'pending' };
			const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
			const guard = event => {
				let allowed = false;
				try {
					const current = (${providerResolver})((${evidenceReader})());
					allowed = Boolean(current)
						&& canonical(current) === canonical(action.expectedProviderUrl)
						&& (event.target === element || element.contains(event.target));
				} catch {}
				if (!allowed) {
					state.status = 'blocked';
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
				if (event.type === 'click') state.status = 'allowed';
			};
			for (const type of eventTypes) document.addEventListener(type, guard, true);
			window[guardKey] = {
				state,
				cleanup: () => { for (const type of eventTypes) document.removeEventListener(type, guard, true); },
			};
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		})()`);
		if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
			throw new Error("ChatGPT Desktop returned an invalid trusted-click point.");
		}
		try {
			await this.cdp(targetId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await this.cdp(targetId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
			await this.cdp(targetId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
			const status = await this.evaluate(targetId, `(() => {
				const key = '__gptControlTrustedClickGuard';
				const pending = window[key];
				if (!pending) return 'missing';
				pending.cleanup();
				delete window[key];
				return pending.state.status;
			})()`);
			if (status !== "allowed") throw new Error(`ChatGPT Desktop trusted click was ${String(status)}.`);
			return { success: true };
		} catch (error) {
			await this.evaluate(targetId, `(() => {
				const key = '__gptControlTrustedClickGuard';
				const pending = window[key];
				if (pending) pending.cleanup();
				delete window[key];
			})()`).catch(() => undefined);
			throw error;
		}
	}

	async screenshot(targetId: string): Promise<string> {
		const result = await this.cdp(targetId, "Page.captureScreenshot", { format: "png", fromSurface: true }) as { data?: unknown };
		return requiredString(result.data, "CDP screenshot data");
	}

	async closeTarget(targetId: string): Promise<void> {
		const target = (await this.targetDescriptors()).find((candidate) => candidate.id === targetId);
		if (target && isDesktopShellRuntimeUrl(target.url)) return;
		const response = await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, this.endpoint), { method: "PUT" });
		if (!response.ok && response.status !== 404) throw new Error(`ChatGPT Desktop could not close renderer ${targetId} (HTTP ${response.status}).`);
	}

	private async listenerReceipt(expectedExecutable: string): Promise<number> {
		const output = await command("/usr/sbin/lsof", ["-nP", `-iTCP:${this.endpoint.port}`, "-sTCP:LISTEN", "-Fpctn"], 5_000);
		const records = parseLsofRecords(output);
		if (records.length === 0) throw new Error(`Expected a ChatGPT Desktop CDP listener on ${this.endpoint.origin}; found none.`);
		const processes: DesktopListenerProcess[] = [];
		for (const record of records) {
			const processExecutable = await realpath((await command("/bin/ps", ["-p", String(record.pid), "-o", "comm="], 5_000)).trim());
			const teamId = processExecutable === expectedExecutable
				? OFFICIAL_TEAM_ID
				: await signedTeamId(processExecutable);
			processes.push({
				...record,
				executable: processExecutable,
				teamId,
				ancestry: await processAncestry(record.pid),
			});
		}
		return selectDesktopListenerOwner(processes, expectedExecutable, this.endpoint.port);
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
		const runtime = requiredString(await this.evaluate(targetId, "location.href"), "current renderer URL");
		const current = isDesktopShellRuntimeUrl(runtime)
			? resolveDesktopShellProviderUrl(await this.desktopShellEvidence(targetId))
			: runtime;
		if (!current) throw new Error("expectedTarget ChatGPT Desktop shell is not ready");
		if (!sameNavigationDestination(current, expectedUrl)) throw new Error("expectedTarget exact URL changed before the browser action");
	}

	private async openDesktopNewChat(targetId: string, expectedProviderUrl: string): Promise<void> {
		const expected = JSON.stringify(expectedProviderUrl);
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		const clicked = await this.evaluate(targetId, `(() => {
			const evidence = (${evidenceReader})();
			const currentProviderUrl = (${providerResolver})(evidence);
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			if (!currentProviderUrl || canonical(currentProviderUrl) !== canonical(${expected})) {
				throw new Error('expectedTarget exact ChatGPT conversation changed before New chat');
			}
			const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
			const buttons = [...document.querySelectorAll('button')];
			const button = buttons.find(element => normalized(element.textContent) === 'New chat' && !element.getAttribute('aria-label'));
			if (!button) return false;
			button.click();
			return true;
		})()`);
		if (clicked !== true) throw new Error("ChatGPT Desktop native New chat control is unavailable.");
	}

	private async openDesktopConversation(targetId: string, conversationId: string, expectedProviderUrl: string): Promise<void> {
		const payload = JSON.stringify({ conversationId, expectedProviderUrl });
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		const marked = await this.evaluate(targetId, `(() => {
			const action = ${payload};
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			const current = (${providerResolver})((${evidenceReader})());
			if (!current || canonical(current) !== canonical(action.expectedProviderUrl)) {
				throw new Error('expectedTarget exact ChatGPT conversation changed before native sidebar navigation');
			}
			for (const old of document.querySelectorAll('[data-gpt-control-thread-target]')) old.removeAttribute('data-gpt-control-thread-target');
			const rows = [...document.querySelectorAll('[data-thread-title]')]
				.map(title => title.closest('[role="button"]'))
				.filter(Boolean);
			const matches = rows.filter(row => {
				const values = new Set();
				const visited = new Set();
				let inspected = 0;
				const visit = (value, depth) => {
					if (value == null || depth > 10 || inspected > 10000) return;
					if (typeof value === 'string') {
						if (value === action.conversationId || value.includes('/c/' + action.conversationId)) values.add(value);
						return;
					}
					if ((typeof value !== 'object' && typeof value !== 'function') || visited.has(value)) return;
					visited.add(value);
					inspected += 1;
					for (const key of Object.keys(value).slice(0, 300)) {
						let child;
						try { child = value[key]; } catch { continue; }
						visit(child, depth + 1);
					}
				};
				let element = row;
				// The row and its immediate wrapper contain the row identity. Higher
				// ancestors contain shared sidebar state and can mention many chats.
				for (let level = 0; element && level < 2; level += 1, element = element.parentElement) {
					for (const key of Object.keys(element)) if (key.startsWith('__react')) visit(element[key], 0);
				}
				return values.size > 0;
			});
			if (matches.length !== 1) throw new Error('The exact ChatGPT Desktop sidebar conversation is unavailable or ambiguous.');
			matches[0].setAttribute('data-gpt-control-thread-target', 'true');
			return true;
		})()`);
		if (marked !== true) throw new Error("ChatGPT Desktop could not mark the exact native sidebar conversation.");
		try {
			await this.trustedDesktopShellClick(targetId, '[data-gpt-control-thread-target="true"]', expectedProviderUrl);
		} finally {
			await this.evaluate(targetId, `document.querySelector('[data-gpt-control-thread-target]')?.removeAttribute('data-gpt-control-thread-target')`).catch(() => undefined);
		}
	}

	private async desktopShellEvidence(targetId: string): Promise<DesktopShellEvidence> {
		const value = await this.evaluate(targetId, `(${readDesktopShellEvidenceInPage.toString()})()`);
		if (!isRecord(value)
			|| typeof value.runtimeUrl !== "string"
			|| typeof value.chatGptMode !== "boolean"
			|| typeof value.composerReady !== "boolean"
			|| typeof value.modelSelectorReady !== "boolean"
			|| typeof value.conversationActionsPresent !== "boolean"
			|| !Number.isSafeInteger(value.turnCount)
			|| (value.turnCount as number) < 0
			|| !Array.isArray(value.conversationIds)
			|| value.conversationIds.some((entry) => typeof entry !== "string")) {
			throw new Error("ChatGPT Desktop returned invalid native shell evidence.");
		}
		return value as unknown as DesktopShellEvidence;
	}
}

export function resolveDesktopShellProviderUrl(evidence: DesktopShellEvidence): string | undefined {
	return resolveDesktopShellProviderUrlInPage(evidence);
}

function resolveDesktopShellProviderUrlInPage(evidence: DesktopShellEvidence): string | undefined {
	if (evidence.runtimeUrl !== "app://-/index.html"
		|| !evidence.chatGptMode
		|| !evidence.composerReady
		|| !evidence.modelSelectorReady) return undefined;
	const ids = [...new Set(evidence.conversationIds)];
	if (ids.some((id) => !/^[A-Za-z0-9_-]{8,128}$/.test(id))) throw new Error("ChatGPT Desktop reported an invalid provider conversation id.");
	if (ids.length > 1) throw new Error("ChatGPT Desktop provider conversation identity is ambiguous.");
	if (ids.length === 1) return `https://chatgpt.com/c/${ids[0]}`;
	if (!evidence.conversationActionsPresent && evidence.turnCount === 0) return "https://chatgpt.com/";
	return undefined;
}

function readDesktopShellEvidenceInPage(): DesktopShellEvidence {
	const action = document.querySelector('[aria-label="ChatGPT conversation actions"]');
	const conversationIds = new Set<string>();
	const visited = new Set<object>();
	let inspected = 0;
	const visit = (value: unknown, depth: number): void => {
		if (value == null || depth > 10 || inspected > 10_000) return;
		if ((typeof value !== "object" && typeof value !== "function") || visited.has(value as object)) return;
		visited.add(value as object);
		inspected += 1;
		for (const key of Object.keys(value).slice(0, 300)) {
			let child: unknown;
			try { child = (value as Record<string, unknown>)[key]; } catch { continue; }
			if (key === "serverConversationId" && typeof child === "string") conversationIds.add(child);
			else if (depth < 10 && !/^(?:return|owner|stateNode|_debug)/i.test(key)) visit(child, depth + 1);
		}
	};
	let element: Element | null = action;
	for (let level = 0; element && level < 12; level += 1, element = element.parentElement) {
		for (const key of Object.keys(element)) {
			if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$")) {
				visit((element as unknown as Record<string, unknown>)[key], 0);
			}
		}
	}
	const mode = document.querySelector('[aria-label^="Switch mode, current mode:"]')?.getAttribute("aria-label") ?? "";
	return {
		runtimeUrl: location.href,
		chatGptMode: /current mode:\s*ChatGPT$/i.test(mode),
		composerReady: Boolean(document.querySelector('#prompt-textarea,div[contenteditable="true"][aria-label="Message ChatGPT"]')),
		modelSelectorReady: Boolean(document.querySelector('[aria-label="Select ChatGPT model"]')),
		conversationActionsPresent: Boolean(action),
		turnCount: document.querySelectorAll('[data-content-search-unit-key$=":user"],[data-content-search-unit-key$=":assistant"]').length,
		conversationIds: [...conversationIds],
	};
}

function isDesktopShellRuntimeUrl(raw: string): boolean {
	return raw === "app://-/index.html";
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
		// Chromium can expose the renderer before its first navigation commits.
		// Keep that target visible by id, but an empty URL remains ineligible for
		// GPT-Control ownership until a later inventory read proves ChatGPT.
		url: typeof value.url === "string" ? value.url : "",
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

export function selectDesktopListenerOwner(
	processes: readonly DesktopListenerProcess[],
	expectedExecutable: string,
	port: string,
): number {
	for (const process of processes) {
		if (!process.names.length || process.names.some((name) => !isLoopbackListenerName(name, port))) {
			throw new Error(`Refused non-loopback ChatGPT Desktop CDP listener: ${process.names.join(", ") || "unknown"}.`);
		}
	}
	const owners = processes.filter((process) => process.executable === expectedExecutable);
	if (owners.length !== 1) {
		throw new Error(`Expected one verified ChatGPT Desktop CDP listener owner; found ${owners.length}.`);
	}
	const owner = owners[0];
	const unverified = processes.find((process) => process.pid !== owner.pid
		&& (process.teamId !== OFFICIAL_TEAM_ID || !process.ancestry.includes(owner.pid)));
	if (unverified) {
		throw new Error(`Refused unverified listener holder PID ${unverified.pid}; it is not an OpenAI-signed descendant of ChatGPT.app.`);
	}
	return owner.pid;
}

async function signedTeamId(executable: string): Promise<string> {
	const signature = await command("/usr/bin/codesign", ["-dv", "--verbose=4", executable], 10_000, true);
	return /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim() ?? "unknown";
}

async function processAncestry(pid: number): Promise<number[]> {
	const ancestry: number[] = [];
	const seen = new Set([pid]);
	let current = pid;
	for (let depth = 0; depth < 32; depth += 1) {
		const raw = (await command("/bin/ps", ["-p", String(current), "-o", "ppid="], 5_000)).trim();
		const parent = Number(raw);
		if (!Number.isInteger(parent) || parent <= 0 || seen.has(parent)) break;
		ancestry.push(parent);
		if (parent === 1) break;
		seen.add(parent);
		current = parent;
	}
	return ancestry;
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
