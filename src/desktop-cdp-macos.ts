import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ChatGptConversationCatalog, ChatGptConversationFindRequest } from "./browser-driver";
import {
	DesktopTargetCreationError,
	type DesktopCdpAction,
	type DesktopCdpEnvironment,
	type DesktopCdpTarget,
	type DesktopCdpTargetReceipt,
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

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message || "Unknown ChatGPT Desktop driver failure.";
}

export class CdpProtocolError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
		this.name = "CdpProtocolError";
	}
}

export function isMissingBrowserWindowError(error: unknown): boolean {
	return error instanceof CdpProtocolError && error.code === -32000 && error.message === "Browser window not found";
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
		env.GPT_CONTROL_DRIVER_DESKTOP_DEDICATED_PROCESS === "1"
			? env.GPT_CONTROL_DRIVER_DESKTOP_DEDICATED_PROFILE_ROOT
			: undefined,
	);
}

export class MacDesktopCdpEnvironment implements DesktopCdpEnvironment {
	private readonly endpoint: URL;
	private readonly appPath: string;
	private readonly dedicatedProfileRoot?: string;

	constructor(endpoint: string, appPath = DEFAULT_APP_PATH, dedicatedProfileRoot?: string) {
		this.endpoint = parseLoopbackEndpoint(endpoint);
		this.appPath = appPath;
		this.dedicatedProfileRoot = dedicatedProfileRoot ? resolve(dedicatedProfileRoot) : undefined;
	}

	async verifyHost(): Promise<DesktopHostReceipt> {
		if (process.platform !== "darwin") throw new Error("ChatGPT Desktop CDP requires macOS.");
		const executable = await realpath(`${this.appPath}/Contents/MacOS/ChatGPT`);
		await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", this.appPath], 30_000, true);
		const signature = await command("/usr/bin/codesign", ["-dv", "--verbose=4", this.appPath], 10_000, true);
		const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1]?.trim();
		const teamId = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim();
		if (!identifier || !OFFICIAL_BUNDLE_IDS.has(identifier) || teamId !== OFFICIAL_TEAM_ID) {
			throw new Error(`Refused unverified ChatGPT.app signature (bundle=${identifier ?? "unknown"}, team=${teamId ?? "unknown"}).`);
		}
		await command("/usr/bin/codesign", [
			"--verify", "--deep", "--strict", "--verbose=2",
			`-R=identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${OFFICIAL_TEAM_ID}"`,
			this.appPath,
		], 30_000, true);
		await verifySignedExecutable(executable);
		const listenerPid = await this.listenerReceipt(executable);
		const processExecutable = (await command("/bin/ps", ["-p", String(listenerPid), "-o", "comm="], 5_000)).trim();
		if (await realpath(processExecutable) !== executable) {
			throw new Error(`CDP listener PID ${listenerPid} is not the verified ChatGPT.app executable.`);
		}
		const commandLine = (await command("/bin/ps", ["-p", String(listenerPid), "-o", "command="], 5_000)).trim();
		if (!commandLineHasExactArgument(commandLine, `--remote-debugging-port=${this.endpoint.port}`)
			|| !commandLineHasExactArgument(commandLine, "--remote-debugging-address=127.0.0.1")) {
			throw new Error("ChatGPT.app CDP listener lacks the required explicit loopback debugging arguments.");
		}
		if (this.dedicatedProfileRoot) {
			const profileRoot = await realpath(this.dedicatedProfileRoot);
			if (!commandLineHasExactArgument(commandLine, `--user-data-dir=${profileRoot}`)) {
				throw new Error("ChatGPT.app dedicated worker listener does not use the exact trusted profile root.");
			}
		}
		const version = await this.fetchJson("/json/version") as Record<string, unknown>;
		const browserVersion = requiredString(version.Browser, "CDP Browser version");
		const browserSocket = new URL(requiredString(version.webSocketDebuggerUrl, "CDP browser WebSocket URL"));
		assertLoopbackWebSocket(browserSocket, this.endpoint.port);
		const browserInstanceId = browserSocket.pathname;
		if (!/^\/devtools\/browser\/[A-Za-z0-9_-]{8,256}$/.test(browserInstanceId)) {
			throw new Error("ChatGPT Desktop returned an invalid CDP browser instance identity.");
		}
		return {
			appPath: this.appPath,
			bundleId: identifier,
			teamId,
			listenerPid,
			endpoint: this.endpoint.origin,
			browserVersion,
			browserInstanceId,
		};
	}

	async closeBrowser(browserInstanceId: string): Promise<void> {
		await this.browserCommand(browserInstanceId, "Browser.close", {});
	}

	private async browserCommand(browserInstanceId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
		const version = await this.fetchJson("/json/version");
		if (!isRecord(version)) throw new Error("ChatGPT Desktop returned an invalid CDP browser descriptor.");
		const browserSocket = new URL(requiredString(version.webSocketDebuggerUrl, "CDP browser WebSocket URL"));
		assertLoopbackWebSocket(browserSocket, this.endpoint.port);
		if (browserSocket.pathname !== browserInstanceId) {
			throw new Error("ChatGPT Desktop browser instance changed before process cleanup.");
		}
		try {
			return await cdpRequest(browserSocket.toString(), method, params);
		} catch (error) {
			// Some Electron builds close the socket before returning the Browser.close
			// receipt. Accept that boundary only when the exact endpoint is already gone.
			try {
				await this.fetchJson("/json/version");
			} catch {
				return undefined;
			}
			throw error;
		}
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

	async findConversations(request: ChatGptConversationFindRequest): Promise<ChatGptConversationCatalog> {
		const shells = (await this.targetDescriptors()).filter((target) => isDesktopShellRuntimeUrl(target.url));
		if (shells.length === 0) throw new Error("ChatGPT Desktop conversation discovery found no eligible app shell.");
		const payload = JSON.stringify({
			query: request.query?.toLocaleLowerCase() ?? "",
			pinned: request.pinned,
			projectId: request.projectId,
			limit: request.limit ?? 20,
		});
		const expression = `(() => {
			const request = ${payload};
			const idGrammar = /^[A-Za-z0-9_-]{8,128}$/;
			const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
			const records = [];
			for (const titleNode of document.querySelectorAll('[data-thread-title]')) {
				const title = normalized(titleNode.textContent);
				if (!title || (request.query && !title.toLocaleLowerCase().includes(request.query))) continue;
				const row = titleNode.closest('[role="button"]');
				if (!row) continue;
				const ids = new Set();
				const projectIds = new Set();
				const pinValues = new Set();
				const updateTimes = new Set();
				const visited = new Set();
				let inspected = 0;
				const visit = (value, depth, parentKey) => {
					if (value == null || depth > 8 || inspected > 10000) return;
					if ((typeof value !== 'object' && typeof value !== 'function') || visited.has(value)) return;
					visited.add(value);
					inspected += 1;
					for (const key of Object.keys(value).slice(0, 300)) {
						let child;
						try { child = value[key]; } catch { continue; }
						if ((key === 'conversationId' || (key === 'id' && parentKey === 'conversation'))
							&& typeof child === 'string' && idGrammar.test(child)) ids.add(child);
						if (key === 'projectId' && typeof child === 'string' && idGrammar.test(child)) projectIds.add(child);
						if (key === 'isPinned' && typeof child === 'boolean') pinValues.add(child);
						if ((key === 'update_time' || key === 'updatedAt') && typeof child === 'string') updateTimes.add(child);
						if (depth < 8 && !/^(?:return|owner|stateNode|_debug)/i.test(key)) visit(child, depth + 1, key);
					}
				};
				let element = row;
				for (let level = 0; element && level < 2; level += 1, element = element.parentElement) {
					for (const key of Object.keys(element)) if (key.startsWith('__react')) visit(element[key], 0, '');
				}
				if (ids.size !== 1 || projectIds.size > 1 || pinValues.size > 1 || updateTimes.size > 1) continue;
				const providerConversationId = [...ids][0];
				const projectId = [...projectIds][0];
				const pinned = [...pinValues][0] === true;
				const updatedAt = [...updateTimes][0];
				if (request.pinned !== undefined && pinned !== request.pinned) continue;
				if (request.projectId !== undefined && projectId !== request.projectId) continue;
				records.push({
					providerConversationId,
					providerConversationUrl: 'https://chatgpt.com/c/' + providerConversationId,
					title,
					pinned,
					...(projectId ? { projectId } : {}),
					...(row.closest('[aria-current="page"]') ? { current: true } : {}),
					...(updatedAt ? { updatedAt } : {}),
				});
			}
			const deduped = new Map();
			for (const record of records) {
				const previous = deduped.get(record.providerConversationId);
				if (previous && previous.title !== record.title) throw new Error('ChatGPT Desktop conversation title identity is inconsistent.');
				deduped.set(record.providerConversationId, previous ? { ...previous, ...record, pinned: previous.pinned || record.pinned } : record);
			}
			return [...deduped.values()].slice(0, request.limit);
		})()`;
		const raw: unknown[] = [];
		for (const shell of shells) {
			const shellRecords = await this.evaluate(shell.id, expression);
			if (!Array.isArray(shellRecords)) throw new Error("ChatGPT Desktop returned an invalid conversation catalog.");
			raw.push(...shellRecords);
		}
		if (!Array.isArray(raw)) throw new Error("ChatGPT Desktop returned an invalid conversation catalog.");
		const mapped = raw.map((entry) => {
			if (!isRecord(entry)
				|| typeof entry.providerConversationId !== "string"
				|| !/^[A-Za-z0-9_-]{8,128}$/.test(entry.providerConversationId)
				|| typeof entry.providerConversationUrl !== "string"
				|| typeof entry.title !== "string"
				|| typeof entry.pinned !== "boolean"
				|| (entry.projectId !== undefined && typeof entry.projectId !== "string")
				|| (entry.current !== undefined && typeof entry.current !== "boolean")
				|| (entry.updatedAt !== undefined && typeof entry.updatedAt !== "string")) {
				throw new Error("ChatGPT Desktop returned an invalid conversation catalog entry.");
			}
			return {
				providerConversationId: entry.providerConversationId,
				providerConversationUrl: entry.providerConversationUrl,
				title: entry.title,
				pinned: entry.pinned,
				...(entry.projectId ? { projectId: entry.projectId } : {}),
				...(entry.current === true ? { current: true } : {}),
				...(typeof entry.updatedAt === "string" ? { updatedAt: entry.updatedAt } : {}),
			};
		});
		const byId = new Map<string, (typeof mapped)[number]>();
		for (const conversation of mapped) {
			const previous = byId.get(conversation.providerConversationId);
			if (previous) {
				if (previous.providerConversationUrl !== conversation.providerConversationUrl
					|| previous.title !== conversation.title
					|| previous.projectId !== conversation.projectId) {
					throw new Error(`ChatGPT Desktop returned conflicting identity evidence for conversation ${conversation.providerConversationId}.`);
				}
				byId.set(conversation.providerConversationId, {
					...previous,
					pinned: previous.pinned || conversation.pinned,
					...(previous.current === true || conversation.current === true ? { current: true } : {}),
					...(previous.updatedAt || conversation.updatedAt
						? { updatedAt: [previous.updatedAt, conversation.updatedAt].filter((value): value is string => Boolean(value)).sort().at(-1)! }
						: {}),
				});
				continue;
			}
			byId.set(conversation.providerConversationId, conversation);
		}
		return { conversations: [...byId.values()].slice(0, request.limit ?? 20), discoveredAt: new Date().toISOString() };
	}

	async createTarget(url: string): Promise<DesktopCdpTargetReceipt> {
		const requested = new URL(url);
		if (requested.origin !== "https://chatgpt.com" || requested.pathname !== "/" || requested.search || requested.hash) {
			throw new Error("ChatGPT Desktop can create only an owned new-chat window; exact-conversation creation is not supported.");
		}
		const host = await this.verifyHost();
		if (this.dedicatedProfileRoot) {
			const candidates: CdpTargetDescriptor[] = [];
			for (const target of await this.targetDescriptors()) {
				if (!isDesktopShellRuntimeUrl(target.url)) continue;
				if (resolveDesktopShellProviderUrl(await this.desktopShellEvidence(target.id))) candidates.push(target);
			}
			if (candidates.length !== 1) {
				throw new DesktopTargetCreationError(`Dedicated ChatGPT Desktop worker exposed ${candidates.length} eligible app shells; exactly one is required.`, "not_created");
			}
			return { id: candidates[0].id, browserInstanceId: host.browserInstanceId };
		}
		const version = await this.fetchJson("/json/version");
		if (!isRecord(version)) throw new Error("ChatGPT Desktop returned an invalid CDP browser descriptor.");
		const browserSocket = new URL(requiredString(version.webSocketDebuggerUrl, "CDP browser WebSocket URL"));
		assertLoopbackWebSocket(browserSocket, this.endpoint.port);
		if (browserSocket.pathname !== host.browserInstanceId) throw new Error("ChatGPT Desktop browser instance changed before renderer creation.");
		let created: unknown;
		try {
			created = await cdpRequest(browserSocket.toString(), "Target.createTarget", {
				url: "app://-/index.html",
				newWindow: true,
				background: true,
			});
		} catch (error) {
			const outcome = error instanceof CdpProtocolError ? "not_created" : "unknown";
			throw new DesktopTargetCreationError(`ChatGPT Desktop renderer creation ${outcome === "not_created" ? "was rejected" : "has an unknown outcome"}: ${errorMessage(error)}`, outcome);
		}
		if (!isRecord(created)) throw new DesktopTargetCreationError("ChatGPT Desktop returned an invalid renderer-creation receipt.", "unknown");
		let ownedTargetId: string;
		try {
			ownedTargetId = requiredString(created.targetId, "created renderer target ID");
		} catch (error) {
			throw new DesktopTargetCreationError(errorMessage(error), "unknown");
		}
		if (!/^[A-Za-z0-9_-]{8,128}$/.test(ownedTargetId)) throw new DesktopTargetCreationError("ChatGPT Desktop returned an invalid created renderer target ID.", "unknown");
		return { id: ownedTargetId, browserInstanceId: host.browserInstanceId };
	}

	async waitForTarget(targetId: string, browserInstanceId: string): Promise<DesktopCdpTarget> {
		const host = await this.verifyHost();
		if (host.browserInstanceId !== browserInstanceId) throw new Error("ChatGPT Desktop browser instance changed before renderer readiness.");
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const candidate = (await this.targetDescriptors()).find((target) => target.id === targetId);
			if (candidate && isDesktopShellRuntimeUrl(candidate.url)) {
				const providerUrl = resolveDesktopShellProviderUrl(await this.desktopShellEvidence(candidate.id));
				if (providerUrl) return {
					id: candidate.id,
					type: candidate.type,
					title: candidate.title,
					url: providerUrl,
					browserInstanceId,
					runtimeUrl: candidate.url,
					surface: "desktop_shell",
				};
			}
			await sleep(100);
		}
		throw new Error("ChatGPT Desktop owned window did not expose one ready signed-in native renderer.");
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
		if (desktopShell && action.kind === "reload") {
			if (!action.expectedUrl) throw new Error("ChatGPT Desktop native-shell reload requires an exact provider URL.");
			const expected = JSON.stringify(action.expectedUrl);
			const evidenceReader = readDesktopShellEvidenceInPage.toString();
			const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
			return this.evaluate(targetId, `(() => {
				const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
				const current = (${providerResolver})((${evidenceReader})());
				if (!current || canonical(current) !== canonical(${expected})) {
					throw new Error('expectedTarget exact ChatGPT conversation changed before native reload');
				}
				setTimeout(() => location.reload(), 0);
				return { success: true };
			})()`);
		}
		if (desktopShell && action.kind === "upload") {
			if (!action.expectedUrl) throw new Error("ChatGPT Desktop native-shell upload requires an exact provider URL.");
			return this.uploadDesktopShellFiles(targetId, action.selector, action.files, action.expectedUrl);
		}
		if (desktopShell && action.kind === "fill") {
			if (!action.expectedUrl) throw new Error("ChatGPT Desktop native-shell fill requires an exact provider URL.");
			return this.fillDesktopShellComposer(targetId, action.selector, action.text, action.expectedUrl);
		}
		if (desktopShell && action.kind === "press") {
			if (!action.expectedUrl) throw new Error("ChatGPT Desktop native-shell key action requires an exact provider URL.");
			return this.trustedDesktopShellPress(targetId, action.key, action.expectedUrl);
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
		if (desktopShell && action.kind === "doubleClick") {
			return this.trustedDesktopShellClick(targetId, action.selector, action.expectedUrl!, 2);
		}
		if (desktopShell && action.kind === "activate") {
			return this.trustedDesktopShellActivate(targetId, action.selector, action.expectedUrl!);
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

	private async trustedDesktopShellClick(targetId: string, selector: string, expectedProviderUrl: string, clickCount = 1): Promise<unknown> {
		const payload = JSON.stringify({ selector, expectedProviderUrl, clickCount });
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
				let matches;
				if (candidate.startsWith('text=')) {
					const name = normalized(candidate.slice(5));
					matches = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],a')]
						.filter(element => normalized(element.getAttribute('aria-label') || element.textContent) === name);
				} else {
					const role = /^role=([^[]+)\\[name=(.*)\\]$/.exec(candidate);
					if (role) {
						const candidates = role[1] === 'button' ? document.querySelectorAll('button,[role="button"]') : document.querySelectorAll('[role="' + role[1] + '"]');
						matches = [...candidates].filter(element => normalized(element.getAttribute('aria-label') || element.textContent) === normalized(role[2]));
					} else {
						matches = [...document.querySelectorAll(candidate)];
					}
				}
				if (matches.length > 1) throw new Error('Ambiguous ChatGPT Desktop click target: ' + candidate);
				return matches[0];
			};
			const element = find(action.selector);
			if (!element) throw new Error('No element found: ' + action.selector);
			element.scrollIntoView({ block: 'center', inline: 'center' });
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) throw new Error('ChatGPT Desktop click target has no visible bounds.');
			const candidates = [
				[0.5, 0.5], [0.2, 0.5], [0.8, 0.5],
				[0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65],
			];
			const inspectedPoints = candidates.map(([horizontal, vertical]) => {
				const x = rect.left + rect.width * horizontal;
				const y = rect.top + rect.height * vertical;
				const hit = document.elementFromPoint(x, y);
				const stack = document.elementsFromPoint(x, y);
				return { x, y, hit, stack };
			});
			let trustedPoint = inspectedPoints.map(({ x, y, hit }) => (
				hit && (hit === element || element.contains(hit)) ? { x, y } : undefined
			)).find(Boolean);
			let coveredTargets = [];
			if (!trustedPoint) {
				const role = element.getAttribute('role');
				const allowedControl = ['BUTTON', 'A'].includes(element.tagName)
					|| ['button', 'menuitem', 'menuitemradio', 'option'].includes(role || '');
				const coveredOnlyByViewTrack = inspectedPoints.every(({ hit }) => hit
					&& String(hit.className || '').split(/\s+/).some(name => name.startsWith('_ViewTrack_')));
				const coveredOnlyByInertGraphics = inspectedPoints.every(({ hit }) => hit
					&& ['svg', 'path', 'g'].includes(hit.tagName.toLowerCase())
					&& !hit.getAttribute('role') && !hit.getAttribute('aria-label'));
				const exactTargetInHitStacks = inspectedPoints.every(({ stack }) => stack.some(node => node === element || element.contains(node)));
				if (allowedControl && coveredOnlyByViewTrack) {
					element.click();
					const afterProviderUrl = (${providerResolver})((${evidenceReader})());
					if (!afterProviderUrl || canonical(afterProviderUrl) !== canonical(action.expectedProviderUrl)) {
						throw new Error('expectedTarget exact ChatGPT conversation changed during the guarded native control action');
					}
					return { synthetic: true };
				}
				if (allowedControl && coveredOnlyByInertGraphics && exactTargetInHitStacks) {
					trustedPoint = { x: inspectedPoints[0].x, y: inspectedPoints[0].y };
					coveredTargets = inspectedPoints.map(({ hit }) => hit).filter(Boolean);
				}
			}
			if (!trustedPoint) {
				const describe = node => node ? [node.tagName, node.id, node.getAttribute('role'), node.getAttribute('aria-label'), node.getAttribute('data-testid'), node.className]
					.map(value => normalized(value)).filter(Boolean).join(':') : 'none';
				const covers = [...new Set(inspectedPoints.map(({ hit }) => describe(hit)))].join(', ');
				throw new Error('ChatGPT Desktop click target ' + describe(element) + ' is covered at every trusted hit point by ' + covers + '.');
			}
			const describe = node => node ? [node.tagName, node.id, node.getAttribute('role'), node.getAttribute('aria-label'), node.getAttribute('data-testid'), node.className]
				.map(value => normalized(value)).filter(Boolean).join(':') : 'none';
			const state = { status: 'pending', blockedBy: '' };
			const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', ...(action.clickCount === 2 ? ['dblclick'] : [])];
			const guard = event => {
				let allowed = false;
				try {
					const current = (${providerResolver})((${evidenceReader})());
					allowed = Boolean(current)
						&& canonical(current) === canonical(action.expectedProviderUrl)
						&& (event.target === element || element.contains(event.target)
							|| coveredTargets.some(node => node === event.target || node.contains(event.target) || event.target.contains(node)));
				} catch {}
				if (!allowed) {
					state.status = 'blocked';
					state.blockedBy ||= describe(event.target);
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
				if (event.type === (action.clickCount === 2 ? 'dblclick' : 'click')) state.status = 'allowed';
			};
			for (const type of eventTypes) document.addEventListener(type, guard, true);
			window[guardKey] = {
				state,
				cleanup: () => { for (const type of eventTypes) document.removeEventListener(type, guard, true); },
			};
			return trustedPoint;
		})()`);
		if (isRecord(point) && point.synthetic === true) return { success: true };
		if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
			throw new Error("ChatGPT Desktop returned an invalid trusted-click point.");
		}
		try {
			await this.cdp(targetId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			for (const count of clickCount === 2 ? [1, 2] : [1]) {
				await this.cdp(targetId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: count });
				await this.cdp(targetId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: count });
			}
			const status = await this.evaluate(targetId, `(() => {
				const key = '__gptControlTrustedClickGuard';
				const pending = window[key];
				if (!pending) return 'missing';
				pending.cleanup();
				delete window[key];
				return pending.state.status === 'blocked' && pending.state.blockedBy
					? pending.state.status + ':' + pending.state.blockedBy
					: pending.state.status;
			})()`);
			if (status !== "allowed") throw new Error(`ChatGPT Desktop trusted click for ${selector} was ${String(status)}.`);
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

	private async trustedDesktopShellActivate(targetId: string, selector: string, expectedProviderUrl: string): Promise<unknown> {
		const payload = JSON.stringify({ selector, expectedProviderUrl });
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		return this.evaluate(targetId, `(() => {
			const action = ${payload};
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			const current = (${providerResolver})((${evidenceReader})());
			if (!current || canonical(current) !== canonical(action.expectedProviderUrl)) {
				throw new Error('expectedTarget exact ChatGPT conversation changed before native activation');
			}
			const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
			const role = /^role=([^[]+)\\[name=(.*)\\]$/.exec(action.selector);
			let matches;
			if (action.selector.startsWith('text=')) {
				const name = normalized(action.selector.slice(5));
				matches = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],a')]
					.filter(element => normalized(element.getAttribute('aria-label') || element.textContent) === name);
			} else if (role) {
				const candidates = role[1] === 'button' ? document.querySelectorAll('button,[role="button"]') : document.querySelectorAll('[role="' + role[1] + '"]');
				matches = [...candidates].filter(element => normalized(element.getAttribute('aria-label') || element.textContent) === normalized(role[2]));
			} else {
				matches = [...document.querySelectorAll(action.selector)];
			}
			if (matches.length !== 1) throw new Error('ChatGPT Desktop activation requires one exact target: ' + action.selector);
			const element = matches[0];
			const controlRole = element.getAttribute('role');
			if (!['BUTTON', 'A'].includes(element.tagName) && !['button', 'menuitem', 'menuitemradio', 'option'].includes(controlRole || '')) {
				throw new Error('ChatGPT Desktop activation target is not an allowed control.');
			}
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) throw new Error('ChatGPT Desktop activation target has no visible bounds.');
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			const stack = document.elementsFromPoint(x, y);
			if (!stack.some(node => node === element || element.contains(node) || node.contains(element))) {
				throw new Error('ChatGPT Desktop activation target is covered by an unrelated control.');
			}
			element.click();
			return new Promise((resolve, reject) => setTimeout(() => {
				try {
					const after = (${providerResolver})((${evidenceReader})());
					if (!after || canonical(after) !== canonical(action.expectedProviderUrl)) {
						throw new Error('expectedTarget exact ChatGPT conversation changed during native activation');
					}
					const visibleAlerts = [...document.querySelectorAll('.alert-root,[role="alert"]')]
						.filter(node => {
							const rect = node.getBoundingClientRect();
							const style = getComputedStyle(node);
							return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
						})
						.map(node => normalized(node.textContent))
						.filter(Boolean);
					resolve({ success: true, visibleAlerts: [...new Set(visibleAlerts)] });
				} catch (error) {
					reject(error);
				}
			}, 750));
		})()`);
	}

	private async trustedDesktopShellPress(targetId: string, key: string, expectedProviderUrl: string): Promise<unknown> {
		if (!new Set(["Escape", "ArrowLeft", "Enter"]).has(key)) {
			throw new Error(`ChatGPT Desktop refused unsupported guarded key ${key}.`);
		}
		const payload = JSON.stringify({ key, expectedProviderUrl });
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		const installed = await this.evaluate(targetId, `(() => {
			const action = ${payload};
			const guardKey = '__gptControlTrustedKeyGuard';
			if (window[guardKey]) throw new Error('A trusted ChatGPT Desktop key is already pending.');
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			const current = (${providerResolver})((${evidenceReader})());
			if (!current || canonical(current) !== canonical(action.expectedProviderUrl)) {
				throw new Error('expectedTarget exact ChatGPT conversation changed before the key action');
			}
			if (action.key === 'Enter' && document.activeElement?.getAttribute('aria-label') !== 'Chat title') {
				throw new Error('ChatGPT Desktop Enter is allowed only while the exact title input is focused.');
			}
			const state = { status: 'pending' };
			const guard = event => {
				let allowed = false;
				try {
					const provider = (${providerResolver})((${evidenceReader})());
					allowed = Boolean(provider)
						&& canonical(provider) === canonical(action.expectedProviderUrl)
						&& event.key === action.key
						&& (action.key !== 'Enter' || document.activeElement?.getAttribute('aria-label') === 'Chat title');
				} catch {}
				if (!allowed) {
					state.status = 'blocked';
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
				if (event.type === 'keyup') state.status = 'allowed';
			};
			document.addEventListener('keydown', guard, true);
			document.addEventListener('keyup', guard, true);
			window[guardKey] = {
				state,
				cleanup: () => {
					document.removeEventListener('keydown', guard, true);
					document.removeEventListener('keyup', guard, true);
				},
			};
			return true;
		})()`);
		if (installed !== true) throw new Error("ChatGPT Desktop did not install the trusted key guard.");
		try {
			await this.cdp(targetId, "Input.dispatchKeyEvent", { type: "keyDown", key });
			await this.cdp(targetId, "Input.dispatchKeyEvent", { type: "keyUp", key });
			const status = await this.evaluate(targetId, `(() => {
				const key = '__gptControlTrustedKeyGuard';
				const pending = window[key];
				if (!pending) return 'missing';
				pending.cleanup();
				delete window[key];
				return pending.state.status;
			})()`);
			if (status !== "allowed") throw new Error(`ChatGPT Desktop trusted key was ${String(status)}.`);
			return { success: true };
		} catch (error) {
			await this.evaluate(targetId, `(() => {
				const key = '__gptControlTrustedKeyGuard';
				const pending = window[key];
				if (pending) pending.cleanup();
				delete window[key];
			})()`).catch(() => undefined);
			throw error;
		}
	}

	private async uploadDesktopShellFiles(
		targetId: string,
		selector: string,
		files: string[],
		expectedProviderUrl: string,
	): Promise<unknown> {
		const marker = `upload-${randomUUID()}`;
		const payload = JSON.stringify({ selector, marker, expectedProviderUrl });
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		const guard = `
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			const current = (${providerResolver})((${evidenceReader})());
			if (!current || canonical(current) !== canonical(action.expectedProviderUrl)) {
				throw new Error('expectedTarget exact ChatGPT conversation changed before native upload');
			}
		`;
		await this.evaluate(targetId, `(() => {
			const action = ${payload};
			${guard}
			for (const old of document.querySelectorAll('[data-gpt-control-upload-target]')) old.removeAttribute('data-gpt-control-upload-target');
			const matches = [...document.querySelectorAll(action.selector)]
				.filter(element => element instanceof HTMLInputElement && element.type === 'file' && !element.disabled);
			if (matches.length !== 1) throw new Error('ChatGPT Desktop requires one exact enabled file input.');
			matches[0].setAttribute('data-gpt-control-upload-target', action.marker);
			return { success: true };
		})()`);
		try {
			await this.withCdpSession(targetId, async (request) => {
				const document = await request("DOM.getDocument", { depth: 1, pierce: true }) as { root?: { nodeId?: unknown } };
				const nodeId = document.root?.nodeId;
				if (typeof nodeId !== "number") throw new Error("CDP returned no document node.");
				const markedSelector = `[data-gpt-control-upload-target="${marker}"]`;
				const query = await request("DOM.querySelector", { nodeId, selector: markedSelector }) as { nodeId?: unknown };
				if (typeof query.nodeId !== "number" || query.nodeId <= 0) throw new Error("The marked ChatGPT Desktop file input disappeared.");
				await this.evaluate(targetId, `(() => {
					const action = ${payload};
					${guard}
					const marked = document.querySelector('[data-gpt-control-upload-target="' + action.marker + '"]');
					if (!(marked instanceof HTMLInputElement) || marked.type !== 'file' || marked.disabled) {
						throw new Error('The marked ChatGPT Desktop file input changed before upload.');
					}
					return { success: true };
				})()`);
				await request("DOM.setFileInputFiles", { nodeId: query.nodeId, files });
			});
			await this.evaluate(targetId, `(() => {
				const action = ${payload};
				${guard}
				return { success: true };
			})()`);
			return { success: true };
		} finally {
			await this.evaluate(targetId, `document.querySelector('[data-gpt-control-upload-target="${marker}"]')?.removeAttribute('data-gpt-control-upload-target')`).catch(() => undefined);
		}
	}

	private async fillDesktopShellComposer(
		targetId: string,
		selector: string,
		text: string,
		expectedProviderUrl: string,
	): Promise<unknown> {
		const marker = `fill-${randomUUID()}`;
		const payload = JSON.stringify({ selector, marker, expectedProviderUrl });
		const evidenceReader = readDesktopShellEvidenceInPage.toString();
		const providerResolver = resolveDesktopShellProviderUrlInPage.toString();
		const guard = `
			const canonical = value => { const url = new URL(value); return url.origin + url.pathname.replace(/\\/$/, '') + url.search; };
			const current = (${providerResolver})((${evidenceReader})());
			if (!current || canonical(current) !== canonical(action.expectedProviderUrl)) {
				throw new Error('expectedTarget exact ChatGPT conversation changed before native fill');
			}
		`;
		const prepareExpression = `(() => {
			const action = ${payload};
			${guard}
			for (const old of document.querySelectorAll('[data-gpt-control-fill-target]')) old.removeAttribute('data-gpt-control-fill-target');
			const matches = [...document.querySelectorAll(action.selector)].filter(element => {
				if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return !element.disabled;
				return element instanceof HTMLElement && element.isContentEditable;
			});
			if (matches.length === 0) throw new Error('No element found: ' + action.selector);
			if (matches.length > 1) throw new Error('ChatGPT Desktop requires one exact editable composer.');
			const element = matches[0];
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) throw new Error('ChatGPT Desktop composer has no visible bounds.');
			const candidates = [
				[0.5, 0.5], [0.2, 0.5], [0.8, 0.5],
				[0.2, 0.25], [0.5, 0.25], [0.8, 0.25],
				[0.2, 0.75], [0.5, 0.75], [0.8, 0.75],
			];
			const hits = candidates.map(([horizontal, vertical]) => {
				const hit = document.elementFromPoint(
					rect.left + rect.width * horizontal,
					rect.top + rect.height * vertical,
				);
				return hit;
			});
			const visible = hits.some(hit => hit && (hit === element || element.contains(hit) || hit.contains(element)));
			if (!visible) {
				const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
				const describe = node => node ? [node.tagName, node.id, node.getAttribute('role'), node.getAttribute('aria-label'), node.getAttribute('data-testid'), node.className]
					.map(value => normalized(value)).filter(Boolean).join(':') : 'none';
				const covers = [...new Set(hits.map(hit => describe(hit)))].join(', ');
				throw new Error('ChatGPT Desktop composer is covered at every trusted point by ' + covers + '.');
			}
			element.setAttribute('data-gpt-control-fill-target', action.marker);
			element.focus();
			if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
				const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, '');
				element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
			} else {
				const selection = getSelection();
				selection.removeAllRanges();
				const range = document.createRange();
				range.selectNodeContents(element);
				selection.addRange(range);
				document.execCommand('delete', false);
				if ((element.innerText || '').length > 0) {
					element.replaceChildren();
					element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
				}
			}
			return { success: true };
		})()`;
		const readbackExpression = `(() => {
			const action = ${payload};
			${guard}
			const marked = document.querySelector('[data-gpt-control-fill-target="' + action.marker + '"]');
			const candidates = marked ? [marked] : [...document.querySelectorAll(action.selector)];
			if (candidates.length !== 1) throw new Error('The exact ChatGPT Desktop composer changed during fill.');
			const element = candidates[0];
			return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText;
		})()`;
		try {
			const observed = await this.withCdpSession(targetId, async (request) => {
				const evaluate = async (expression: string): Promise<unknown> => {
					const response = await request("Runtime.evaluate", {
						expression, returnByValue: true, awaitPromise: true, userGesture: true,
					});
					if (!isRecord(response)) throw new Error("ChatGPT Desktop returned an invalid CDP evaluation response.");
					if (isRecord(response.exceptionDetails)) {
						const exception = isRecord(response.exceptionDetails.exception) ? response.exceptionDetails.exception : undefined;
						throw new Error(String(exception?.description ?? response.exceptionDetails.text ?? "CDP evaluation failed."));
					}
					return isRecord(response.result) ? response.result.value : undefined;
				};
				await evaluate(prepareExpression);
				await request("Input.insertText", { text });
				return evaluate(readbackExpression);
			});
			const normalize = (value: string) => value.replace(/\r\n/g, "\n").replace(/\n+$/, "");
			if (typeof observed !== "string" || normalize(observed) !== normalize(text)) {
				throw new Error("ChatGPT Desktop did not retain the exact prompt text. No prompt was sent.");
			}
			return { success: true };
		} finally {
			await this.evaluate(targetId, `document.querySelector('[data-gpt-control-fill-target="${marker}"]')?.removeAttribute('data-gpt-control-fill-target')`).catch(() => undefined);
		}
	}

	async screenshot(targetId: string): Promise<string> {
		const result = await this.cdp(targetId, "Page.captureScreenshot", { format: "png", fromSurface: true }) as { data?: unknown };
		return requiredString(result.data, "CDP screenshot data");
	}

	async windowId(targetId: string, browserInstanceId?: string): Promise<number | undefined> {
		const version = await this.fetchJson("/json/version");
		if (!isRecord(version)) throw new Error("ChatGPT Desktop returned an invalid CDP browser descriptor.");
		const browserSocket = new URL(requiredString(version.webSocketDebuggerUrl, "CDP browser WebSocket URL"));
		assertLoopbackWebSocket(browserSocket, this.endpoint.port);
		if (browserInstanceId && browserSocket.pathname !== browserInstanceId) {
			throw new Error("ChatGPT Desktop browser instance changed before native window lookup.");
		}
		let result: unknown;
		try {
			result = await cdpRequest(browserSocket.toString(), "Browser.getWindowForTarget", { targetId });
		} catch (error) {
			if (isMissingBrowserWindowError(error)) return this.dedicatedProfileRoot
				? dedicatedProfileWindowId(this.endpoint, this.dedicatedProfileRoot)
				: undefined;
			throw error;
		}
		if (!isRecord(result) || !Number.isSafeInteger(result.windowId) || (result.windowId as number) < 0) return undefined;
		return result.windowId as number;
	}

	async closeTarget(targetId: string, browserInstanceId?: string): Promise<void> {
		const version = await this.fetchJson("/json/version");
		if (!isRecord(version)) throw new Error("ChatGPT Desktop returned an invalid CDP browser descriptor.");
		const browserSocket = new URL(requiredString(version.webSocketDebuggerUrl, "CDP browser WebSocket URL"));
		assertLoopbackWebSocket(browserSocket, this.endpoint.port);
		if (browserInstanceId && browserSocket.pathname !== browserInstanceId) {
			throw new Error("ChatGPT Desktop browser instance changed before renderer cleanup.");
		}
		if (!(await this.targetDescriptors()).some((target) => target.id === targetId)) return;
		const result = await cdpRequest(browserSocket.toString(), "Target.closeTarget", { targetId });
		if (!isRecord(result) || result.success !== true) throw new Error(`ChatGPT Desktop could not close renderer ${targetId}.`);
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (!(await this.targetDescriptors()).some((target) => target.id === targetId)) return;
			await sleep(100);
		}
		throw new Error(`ChatGPT Desktop renderer ${targetId} remained present after its close receipt.`);
	}

	private async listenerReceipt(expectedExecutable: string): Promise<number> {
		const output = await lsofListeners(this.endpoint.port);
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

	private async withCdpSession<T>(
		targetId: string,
		work: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
	): Promise<T> {
		const target = (await this.targetDescriptors()).find((candidate) => candidate.id === targetId);
		if (!target) throw new Error(`ChatGPT Desktop target ${targetId} is unavailable.`);
		return runCdpSession(target.webSocketDebuggerUrl, work);
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

export function commandLineHasExactArgument(commandLine: string, expected: string): boolean {
	if (!expected || /\s/.test(expected)) {
		throw new Error("ChatGPT Desktop process arguments containing whitespace are not supported for exact identity checks.");
	}
	const argumentsList = commandLine.trim().split(/\s+/);
	const equals = expected.indexOf("=");
	const prefix = equals >= 0 ? expected.slice(0, equals + 1) : expected;
	const matches = argumentsList.filter((argument) => argument.startsWith(prefix));
	return matches.length === 1 && matches[0] === expected;
}

export function resolveDesktopShellProviderUrl(evidence: DesktopShellEvidence): string | undefined {
	return resolveDesktopShellProviderUrlInPage(evidence);
}

function resolveDesktopShellProviderUrlInPage(evidence: DesktopShellEvidence): string | undefined {
	const localPendingRuntime = /^https:\/\/chatgpt\.com\/c\/WEB:[A-Za-z0-9-]{8,128}\/?$/.test(evidence.runtimeUrl);
	if (evidence.runtimeUrl !== "app://-/index.html" && !localPendingRuntime
		|| !evidence.chatGptMode) return undefined;
	const reportedIds = [...new Set(evidence.conversationIds)];
	if (reportedIds.some((id) => !/^[A-Za-z0-9_-]{8,128}$/.test(id) && !/^WEB:[A-Za-z0-9-]{8,128}$/.test(id))) {
		throw new Error("ChatGPT Desktop reported an invalid provider conversation id.");
	}
	const ids = reportedIds.filter((id) => !id.startsWith("WEB:"));
	if (ids.length > 1) throw new Error("ChatGPT Desktop provider conversation identity is ambiguous.");
	if (ids.length === 1) return `https://chatgpt.com/c/${ids[0]}`;
	if (!evidence.composerReady || !evidence.modelSelectorReady) return undefined;
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
	return raw === "app://-/index.html" || /^https:\/\/chatgpt\.com\/c\/WEB:[A-Za-z0-9-]{8,128}\/?$/.test(raw);
}

export function dedicatedProfileWindowId(endpoint: URL, profileRoot: string): number {
	const digest = createHash("sha256").update(`${endpoint.origin}\0${resolve(profileRoot)}`).digest();
	return 2 ** 48 + digest.readUIntBE(0, 6);
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
	return runCdpSession(url, (request) => request(method, params));
}

async function runCdpSession<T>(
	url: string,
	work: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
	const socket = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			try { socket.close(); } catch {}
			reject(new Error("CDP WebSocket connection timed out."));
		}, 30_000);
		const finish = (callback: () => void) => {
			clearTimeout(timer);
			callback();
		};
		socket.addEventListener("open", () => finish(resolve), { once: true });
		socket.addEventListener("error", () => finish(() => reject(new Error("CDP WebSocket connection failed."))), { once: true });
	});
	let nextId = 1;
	const request = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolve, reject) => {
		const id = nextId++;
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`CDP ${method} timed out.`));
		}, 30_000);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("error", onError);
		};
		const onError = () => {
			cleanup();
			reject(new Error(`CDP ${method} WebSocket failed.`));
		};
		const onMessage = (event: MessageEvent) => {
			let message: unknown;
			try { message = JSON.parse(String(event.data)); } catch { return; }
			if (!isRecord(message) || message.id !== id) return;
			cleanup();
				if (isRecord(message.error)) {
					const code = typeof message.error.code === "number" ? message.error.code : -1;
					reject(new CdpProtocolError(code, String(message.error.message ?? `CDP ${method} failed.`)));
				return;
			}
			resolve(message.result);
		};
		socket.addEventListener("message", onMessage);
		socket.addEventListener("error", onError);
		socket.send(JSON.stringify({ id, method, params }));
	});
	try {
		return await work(request);
	} finally {
		try { socket.close(); } catch {}
	}
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
	await verifySignedExecutable(executable);
	const signature = await command("/usr/bin/codesign", ["-dv", "--verbose=4", executable], 10_000, true);
	return /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim() ?? "unknown";
}

async function verifySignedExecutable(executable: string): Promise<void> {
	await command("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", executable], 30_000, true);
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
			const detail = String(error.stderr ?? error.stdout ?? error.message ?? "").trim();
			throw new Error(detail || `${path} failed without diagnostic output.`);
		}
		throw error;
	}
}

async function lsofListeners(port: string): Promise<string> {
	try {
		const result = await execFileAsync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpctn"], {
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
			encoding: "utf8",
		});
		return result.stdout;
	} catch (error) {
		if (isRecord(error) && error.code === 1 && String(error.stdout ?? "") === "") return "";
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
