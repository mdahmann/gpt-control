import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChromeBridgeBrowserDriver, type DriverSession, type WebChatDriver } from "./browser-driver";
import {
	CHATGPT_ORIGIN,
	providerConversationIdentity,
	type ChatGptConversationAction,
	type ChatGptSelection,
	type ExactBrowserActionTarget,
} from "./chatgpt";
import type { Launcher } from "./transport";
import type { Exec, ExecResult } from "./types";

export const DESKTOP_DRIVER_ID = "chatgpt-desktop-cdp/v1";

export interface DesktopCdpTarget {
	id: string;
	type: "page" | "webview";
	title: string;
	url: string;
}

export type DesktopCdpAction =
	| { kind: "fill"; selector: string; text: string; expectedUrl?: string }
	| { kind: "click" | "hover"; selector: string; expectedUrl?: string }
	| { kind: "press"; key: string; expectedUrl?: string }
	| { kind: "upload"; selector: string; files: string[]; expectedUrl?: string }
	| { kind: "reload"; expectedUrl?: string };

export interface DesktopHostReceipt {
	appPath: string;
	bundleId: string;
	teamId: string;
	listenerPid: number;
	endpoint: string;
	browserVersion: string;
}

export interface DesktopCdpEnvironment {
	verifyHost(): Promise<DesktopHostReceipt>;
	listTargets(): Promise<DesktopCdpTarget[]>;
	createTarget(url: string): Promise<DesktopCdpTarget>;
	navigateTarget(targetId: string, url: string): Promise<DesktopCdpTarget>;
	readHtml(targetId: string): Promise<string>;
	act(targetId: string, action: DesktopCdpAction): Promise<unknown>;
	screenshot(targetId: string): Promise<string>;
	closeTarget(targetId: string): Promise<void>;
}

export interface DesktopDriverRequest {
	version: 2;
	action: string;
	params: Record<string, unknown>;
}

export interface DesktopDriverEnvelope {
	version: 2;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface DesktopDriverOptions {
	environment: DesktopCdpEnvironment;
	stateRoot: string;
	allowCreateTarget: boolean;
}

interface DesktopSessionState {
	sessionId: string;
	name: string;
	tabId: number;
	targetId: string;
	url: string;
	state: "working" | "needs_user" | "completed";
	sendState: "prepared" | "attempted" | "submitted";
	promptSha256?: string;
	createdAt: string;
}

interface DesktopDriverState {
	version: 1;
	nextTabId: number;
	sessions: Record<string, DesktopSessionState>;
}

export async function handleDesktopDriverRequest(
	request: DesktopDriverRequest,
	options: DesktopDriverOptions,
): Promise<DesktopDriverEnvelope> {
	if (request.version !== 2 || typeof request.action !== "string" || !isRecord(request.params)) {
		return failure("Invalid browser-driver protocol-v2 request.");
	}
	try {
		if (request.action === "probe") {
			await options.environment.verifyHost();
			return success({ ready: true, driver: DESKTOP_DRIVER_ID, secureInput: true, protocolVersion: 2 });
		}
		await options.environment.verifyHost();
		const bridge = new DesktopCdpBridge(options);
		const driver: WebChatDriver = new ChromeBridgeBrowserDriver(bridge.exec, bridge.launcher);
		const params = request.params;
		switch (request.action) {
			case "create":
				return success(await driver.create(requiredString(params.name, "name"), requiredString(params.url, "url")));
			case "show":
				return success(await driver.show(requiredString(params.sessionId, "sessionId")));
			case "navigate":
				return success(await driver.navigate(requiredSession(params.session), requiredString(params.url, "url")));
			case "upload":
				await driver.upload(requiredSession(params.session), requiredStringArray(params.files, "files"));
				return success({});
			case "fill":
				await driver.fill(requiredSession(params.session), requiredString(params.prompt, "prompt"));
				return success({});
			case "discover_models":
				return success(await driver.discoverModels(requiredSession(params.session)));
			case "discover_projects":
				return success(await driver.discoverProjects(requiredSession(params.session)));
			case "manage_conversation":
				return success(await driver.manageConversation(requiredSession(params.session), requiredConversationAction(params.operation)));
			case "select_model":
				return success(await driver.selectModel(requiredSession(params.session), requiredModelSelection(params.model)));
			case "verify_model":
				return success(await driver.verifyModel(requiredSession(params.session), requiredModelSelection(params.model)));
			case "send":
				await driver.send(requiredSession(params.session));
				return success({});
			case "observe":
				return success(await driver.observe(requiredSession(params.session)));
			case "recover":
				await driver.recover(requiredSession(params.session), requiredRecoveryAction(params.action));
				return success({});
			case "set_state":
				await driver.setState(requiredString(params.sessionId, "sessionId"), requiredDriverState(params.state));
				return success({});
			case "close":
				await driver.close(requiredString(params.sessionId, "sessionId"));
				return success({});
			case "screenshot":
				return success(await driver.screenshot(requiredSession(params.session), requiredString(params.outputPath, "outputPath")));
			default:
				throw new Error(`Unsupported desktop browser-driver action: ${request.action}`);
		}
	} catch (error) {
		return failure(errorMessage(error));
	}
}

class DesktopCdpBridge {
	readonly launcher: Launcher = {
		command: "gpt-control-desktop-cdp-bridge",
		args: [],
		origin: "in-process ChatGPT Desktop CDP bridge",
		privateRpc: {
			command: "gpt-control-desktop-cdp-private",
			args: [],
			clientScript: "internal",
			origin: "private request-file CDP bridge",
		},
	};

	constructor(private readonly options: DesktopDriverOptions) {}

	readonly exec: Exec = async (command, args): Promise<ExecResult> => {
		try {
			const result = command === this.launcher.privateRpc?.command
				? await this.privateRequest(args)
				: await this.publicRequest(args);
			return commandResult(true, result);
		} catch (error) {
			return commandResult(false, undefined, errorMessage(error));
		}
	};

	private async publicRequest(args: string[]): Promise<unknown> {
		const [action, ...rest] = args;
		if (action === "taskSession") return this.taskSession(rest);
		if (action === "getTabs") return { tabs: await this.currentTabs() };
		if (action === "getHTML") {
			const session = await this.sessionByTabId(Number(rest[0]));
			await this.assertExactTarget(session);
			await writeFile(requiredString(rest[1], "HTML output path"), await this.options.environment.readHtml(session.targetId), { mode: 0o600 });
			return { success: true };
		}
		if (action === "reload") return this.actOnTab(Number(rest[0]), { kind: "reload" });
		if (action === "click" || action === "hover") return this.actOnTab(Number(rest[0]), { kind: action, selector: requiredString(rest[1], "selector") });
		if (action === "press") return this.actOnTab(Number(rest[0]), { kind: "press", key: requiredString(rest[1], "key") });
		if (action === "screenshot") {
			const session = await this.sessionByTabId(Number(rest[0]));
			await this.assertExactTarget(session);
			await writeFile(requiredString(rest[1], "screenshot output path"), Buffer.from(await this.options.environment.screenshot(session.targetId), "base64"), { mode: 0o600 });
			return { success: true };
		}
		throw new Error(`Unsupported desktop bridge action: ${action}`);
	}

	private async privateRequest(args: string[]): Promise<unknown> {
		const requestPath = args.at(-1);
		if (!requestPath) throw new Error("Desktop private request path is missing.");
		const request = JSON.parse(await readFile(requestPath, "utf8")) as { action?: unknown; payload?: unknown };
		if (typeof request.action !== "string" || !isRecord(request.payload)) throw new Error("Invalid desktop private request.");
		const payload = request.payload;
		const tabId = requiredNumber(payload.tabId, "tabId");
		const session = await this.sessionByTabId(tabId);
		const expectedTarget = requiredExpectedTarget(payload.expectedTarget);
		await this.assertExactTarget(session, expectedTarget);
		if (request.action === "ping") return { pong: true, expectedTargetEnforcement: "document-v1" };
		if (request.action === "fill") {
			const prompt = requiredString(payload.text, "text");
			await this.preparePrompt(session.sessionId, prompt);
			return this.options.environment.act(session.targetId, {
				kind: "fill",
				selector: requiredString(payload.selector, "selector"),
				text: prompt,
				expectedUrl: expectedTarget.url,
			});
		}
		if (request.action === "uploadFile") {
			return this.options.environment.act(session.targetId, {
				kind: "upload",
				selector: requiredString(payload.selector, "selector"),
				files: requiredStringArray(payload.files, "files"),
				expectedUrl: expectedTarget.url,
			});
		}
		if (request.action === "click" || request.action === "hover") {
			const selector = requiredString(payload.selector, "selector");
			if (request.action === "click" && isSendSelector(selector)) await this.markSendAttempted(session.sessionId);
			return this.options.environment.act(session.targetId, {
				kind: request.action,
				selector,
				expectedUrl: expectedTarget.url,
			});
		}
		if (request.action === "press") {
			return this.options.environment.act(session.targetId, {
				kind: "press",
				key: requiredString(payload.key, "key"),
				expectedUrl: expectedTarget.url,
			});
		}
		if (request.action === "reload") return this.options.environment.act(session.targetId, { kind: "reload", expectedUrl: expectedTarget.url });
		if (request.action === "screenshot") {
			return { success: true, dataUrl: `data:image/png;base64,${await this.options.environment.screenshot(session.targetId)}` };
		}
		throw new Error(`Unsupported desktop private action: ${request.action}`);
	}

	private async taskSession(args: string[]): Promise<unknown> {
		const [operation, ...rest] = args;
		if (operation === "create") {
			const name = requiredString(rest[0], "session name");
			if (!/^gpt-control:[A-Za-z0-9:._-]{1,200}$/.test(name)) throw new Error("Invalid GPT-Control desktop session name.");
			const sessionId = `desktop-${randomUUID()}`;
			await withStateLock(this.options.stateRoot, async (state) => {
				state.sessions[sessionId] = {
					sessionId,
					name,
					tabId: state.nextTabId++,
					targetId: "",
					url: "",
					state: "working",
					sendState: "prepared",
					createdAt: new Date().toISOString(),
				};
			});
			return { sessionId };
		}
		if (operation === "navigate") {
			const sessionId = requiredString(rest[0], "sessionId");
			const url = exactChatGptUrl(requiredString(rest[1], "url"));
			return this.navigateSession(sessionId, url);
		}
		if (operation === "show") {
			const session = await this.sessionById(requiredString(rest[0], "sessionId"));
			await this.assertExactTarget(session);
			return { sessionId: session.sessionId, name: session.name, tabIds: [session.tabId], state: session.state };
		}
		if (operation === "state") {
			const sessionId = requiredString(rest[0], "sessionId");
			const next = requiredDriverState(rest[1]);
			await withStateLock(this.options.stateRoot, async (state) => { requireSession(state, sessionId).state = next; });
			return { success: true };
		}
		if (operation === "close") {
			const sessionId = requiredString(rest[0], "sessionId");
			let targetId = "";
			await withStateLock(this.options.stateRoot, async (state) => {
				targetId = requireSession(state, sessionId).targetId;
				delete state.sessions[sessionId];
			});
			if (targetId) await this.options.environment.closeTarget(targetId);
			return { success: true };
		}
		throw new Error(`Unsupported desktop taskSession operation: ${operation}`);
	}

	private async navigateSession(sessionId: string, url: string): Promise<{ tabId: number }> {
		let snapshot = await this.sessionById(sessionId);
		if (!snapshot.targetId) {
			const targets = await this.options.environment.listTargets();
			const state = await readState(this.options.stateRoot);
			const claimed = new Set(Object.values(state.sessions).map((session) => session.targetId).filter(Boolean));
			let target = targets.find((candidate) => eligibleTarget(candidate) && !claimed.has(candidate.id));
			if (!target) {
				const activeClaims = claimed.size;
				if (activeClaims > 0 && !this.options.allowCreateTarget) {
					throw new Error("ChatGPT Desktop renderer capacity is exhausted; extra target creation is disabled.");
				}
				target = await this.options.environment.createTarget(url);
			}
			const navigated = await this.options.environment.navigateTarget(target.id, url);
			await withStateLock(this.options.stateRoot, async (current) => {
				const session = requireSession(current, sessionId);
				if (session.targetId && session.targetId !== navigated.id) throw new Error("Desktop session target changed during claim.");
				const duplicate = Object.values(current.sessions).find((entry) => entry.sessionId !== sessionId && entry.targetId === navigated.id);
				if (duplicate) throw new Error("Desktop renderer is already owned by another GPT-Control session.");
				session.targetId = navigated.id;
				session.url = exactChatGptUrl(navigated.url);
			});
			snapshot = await this.sessionById(sessionId);
		} else {
			await this.assertExactTarget(snapshot);
			const navigated = await this.options.environment.navigateTarget(snapshot.targetId, url);
			await withStateLock(this.options.stateRoot, async (state) => { requireSession(state, sessionId).url = exactChatGptUrl(navigated.url); });
		}
		return { tabId: snapshot.tabId };
	}

	private async currentTabs(): Promise<Array<{ id: number; url: string }>> {
		const state = await readState(this.options.stateRoot);
		const result: Array<{ id: number; url: string }> = [];
		for (const session of Object.values(state.sessions)) {
			if (!session.targetId) continue;
			const current = await this.assertExactTarget(session);
			result.push({ id: current.tabId, url: current.url });
		}
		return result;
	}

	private async assertExactTarget(session: DesktopSessionState, expected?: ExactBrowserActionTarget): Promise<DesktopSessionState> {
		if (!session.targetId) throw new Error(`Desktop session ${session.sessionId} owns no renderer.`);
		if (expected) {
			if (expected.sessionId !== session.sessionId || expected.tabId !== session.tabId || expected.name !== session.name) {
				throw new Error("Desktop exact target ownership changed before the browser action.");
			}
			if (!sameExactUrl(expected.url, session.url)) throw new Error("Desktop exact target recorded URL changed before the browser action.");
		}
		const targets = await this.options.environment.listTargets();
		let target = targets.find((candidate) => candidate.id === session.targetId);
		if (!target) {
			const identity = providerConversationIdentity(session.url);
			if (identity) {
				const state = await readState(this.options.stateRoot);
				const claimed = new Set(Object.values(state.sessions)
					.filter((entry) => entry.sessionId !== session.sessionId)
					.map((entry) => entry.targetId)
					.filter(Boolean));
				const matches = targets.filter((candidate) => {
					const candidateIdentity = eligibleTarget(candidate) ? providerConversationIdentity(candidate.url) : undefined;
					return candidateIdentity?.id === identity.id && !claimed.has(candidate.id);
				});
				if (matches.length === 1) {
					target = matches[0];
					await withStateLock(this.options.stateRoot, async (current) => {
						const durable = requireSession(current, session.sessionId);
						const duplicate = Object.values(current.sessions).find((entry) => entry.sessionId !== session.sessionId && entry.targetId === target?.id);
						if (duplicate) throw new Error("Replacement ChatGPT Desktop renderer became owned by another session.");
						durable.targetId = target!.id;
						durable.url = identity.url;
					});
					session = await this.sessionById(session.sessionId);
				}
			}
		}
		if (!target || !eligibleTarget(target)) throw new Error("Desktop exact target renderer is unavailable or ineligible.");
		if (sameExactUrl(target.url, session.url)) return session;
		const oldIdentity = providerConversationIdentity(session.url);
		const newIdentity = providerConversationIdentity(target.url);
		if (session.sendState === "attempted" && session.url === `${CHATGPT_ORIGIN}/` && newIdentity) {
			await withStateLock(this.options.stateRoot, async (state) => {
				const current = requireSession(state, session.sessionId);
				current.url = newIdentity.url;
				current.sendState = "submitted";
			});
			return this.sessionById(session.sessionId);
		}
		if (oldIdentity && newIdentity?.id === oldIdentity.id) {
			await withStateLock(this.options.stateRoot, async (state) => { requireSession(state, session.sessionId).url = newIdentity.url; });
			return this.sessionById(session.sessionId);
		}
		throw new Error(`Desktop exact target URL changed from ${session.url} to ${target.url}.`);
	}

	private async sessionById(sessionId: string): Promise<DesktopSessionState> {
		return requireSession(await readState(this.options.stateRoot), sessionId);
	}

	private async sessionByTabId(tabId: number): Promise<DesktopSessionState> {
		const session = Object.values((await readState(this.options.stateRoot)).sessions).find((entry) => entry.tabId === tabId);
		if (!session) throw new Error(`Desktop tab ${tabId} is not owned by GPT-Control.`);
		return session;
	}

	private async actOnTab(tabId: number, action: DesktopCdpAction): Promise<unknown> {
		const session = await this.sessionByTabId(tabId);
		await this.assertExactTarget(session);
		return this.options.environment.act(session.targetId, { ...action, expectedUrl: session.url });
	}

	private async preparePrompt(sessionId: string, prompt: string): Promise<void> {
		await withStateLock(this.options.stateRoot, async (state) => {
			const session = requireSession(state, sessionId);
			if (session.sendState === "attempted") throw new Error("The prior desktop send was already attempted and remains ambiguous; prompt replacement is refused.");
			session.sendState = "prepared";
			session.promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
		});
	}

	private async markSendAttempted(sessionId: string): Promise<void> {
		await withStateLock(this.options.stateRoot, async (state) => {
			const session = requireSession(state, sessionId);
			if (session.sendState === "attempted") throw new Error("This desktop send was already attempted; automatic replay is refused.");
			if (session.sendState !== "prepared" || !session.promptSha256) throw new Error("Desktop prompt must be filled before send.");
			session.sendState = "attempted";
		});
	}
}

async function readState(root: string): Promise<DesktopDriverState> {
	await secureDirectory(root);
	const path = join(resolve(root), "state.json");
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe desktop driver state: ${path}`);
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parseState(parsed);
	} catch (error) {
		if (isMissing(error)) return { version: 1, nextTabId: 1, sessions: {} };
		throw error;
	}
}

async function withStateLock<T>(root: string, work: (state: DesktopDriverState) => Promise<T> | T): Promise<T> {
	await secureDirectory(root);
	const lock = join(resolve(root), "state.lock");
	const deadline = Date.now() + 30_000;
	const token = randomUUID();
	for (;;) {
		try {
			await mkdir(lock, { mode: 0o700 });
		} catch (error) {
			if (!isAlreadyExists(error) || Date.now() >= deadline) throw error;
			if (await recoverDeadLocalLock(lock)) continue;
			await sleep(25);
			continue;
		}
		try {
			await writeFile(join(lock, "owner.json"), `${JSON.stringify({
				token,
				pid: process.pid,
				hostname: hostname(),
				createdAt: new Date().toISOString(),
			})}\n`, { mode: 0o600, flag: "wx" });
			break;
		} catch (error) {
			await rm(lock, { recursive: true, force: true });
			throw error;
		}
	}
	try {
		const state = await readState(root);
		const result = await work(state);
		await writeState(root, state);
		return result;
	} finally {
		try {
			const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as unknown;
			if (isRecord(owner) && owner.token === token) await rm(lock, { recursive: true, force: true });
		} catch {}
	}
}

async function recoverDeadLocalLock(lock: string): Promise<boolean> {
	try {
		const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as unknown;
		if (!isRecord(owner)
			|| owner.hostname !== hostname()
			|| typeof owner.pid !== "number"
			|| !Number.isInteger(owner.pid)
			|| owner.pid <= 0
			|| typeof owner.token !== "string") return false;
		if (processIsAlive(owner.pid)) return false;
		await rm(lock, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code !== "ESRCH";
	}
}

async function writeState(root: string, state: DesktopDriverState): Promise<void> {
	parseState(state);
	const parent = await secureDirectory(root);
	const destination = join(parent, "state.json");
	const scratch = join(parent, `.state-${randomUUID()}.tmp`);
	try {
		const current = await lstat(destination);
		if (current.isSymbolicLink() || !current.isFile()) throw new Error(`Refused unsafe desktop driver state: ${destination}`);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const handle = await open(scratch, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
	} finally {
		await handle.close();
	}
	await rename(scratch, destination);
}

async function secureDirectory(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		const info = await lstat(absolute);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refused unsafe desktop driver directory: ${absolute}`);
	} catch (error) {
		if (!isMissing(error)) throw error;
		await mkdir(absolute, { recursive: true, mode: 0o700 });
	}
	await chmod(absolute, 0o700);
	return absolute;
}

function parseState(value: unknown): DesktopDriverState {
	if (!isRecord(value) || value.version !== 1 || !Number.isInteger(value.nextTabId) || !isRecord(value.sessions)) {
		throw new Error("Invalid durable ChatGPT Desktop driver state.");
	}
	for (const [key, candidate] of Object.entries(value.sessions)) {
		if (!isRecord(candidate)
			|| candidate.sessionId !== key
			|| typeof candidate.name !== "string"
			|| !Number.isInteger(candidate.tabId)
			|| typeof candidate.targetId !== "string"
			|| typeof candidate.url !== "string"
			|| !new Set(["working", "needs_user", "completed"]).has(String(candidate.state))
			|| !new Set(["prepared", "attempted", "submitted"]).has(String(candidate.sendState))
			|| typeof candidate.createdAt !== "string"
			|| (candidate.promptSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(candidate.promptSha256)))) {
			throw new Error("Invalid durable ChatGPT Desktop session record.");
		}
	}
	return value as unknown as DesktopDriverState;
}

function requireSession(state: DesktopDriverState, sessionId: string): DesktopSessionState {
	const session = state.sessions[sessionId];
	if (!session) throw new Error(`Unknown ChatGPT Desktop session: ${sessionId}`);
	return session;
}

function eligibleTarget(target: DesktopCdpTarget): boolean {
	if (target.type !== "page" && target.type !== "webview") return false;
	try { return new URL(target.url).origin === CHATGPT_ORIGIN; } catch { return false; }
}

function exactChatGptUrl(raw: string): string {
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error(`Invalid ChatGPT URL: ${raw}`); }
	if (url.origin !== CHATGPT_ORIGIN || url.username || url.password || url.hash) throw new Error(`Refused URL outside ${CHATGPT_ORIGIN}.`);
	return url.toString();
}

function sameExactUrl(left: string, right: string): boolean {
	try {
		const a = new URL(left);
		const b = new URL(right);
		return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") && a.search === b.search;
	} catch {
		return false;
	}
}

function requiredSession(value: unknown): DriverSession {
	if (!isRecord(value)) throw new Error("Missing browser-driver session.");
	return {
		sessionId: requiredString(value.sessionId, "session.sessionId"),
		pageId: typeof value.pageId === "number" || typeof value.pageId === "string" ? value.pageId : requiredNumber(value.pageId, "session.pageId"),
		name: requiredString(value.name, "session.name"),
		url: requiredString(value.url, "session.url"),
	};
}

function requiredExpectedTarget(value: unknown): ExactBrowserActionTarget {
	if (!isRecord(value)) throw new Error("Desktop browser action requires expectedTarget proof.");
	return {
		sessionId: requiredString(value.sessionId, "expectedTarget.sessionId"),
		tabId: requiredNumber(value.tabId, "expectedTarget.tabId"),
		name: requiredString(value.name, "expectedTarget.name"),
		url: requiredString(value.url, "expectedTarget.url"),
	};
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`Missing ${name}.`);
	return value;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Missing ${name}.`);
	return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) throw new Error(`Invalid ${name}.`);
	return [...value];
}

function requiredRecoveryAction(value: unknown): "reload" | "continue" | "retry" | "stop" {
	if (value === "reload" || value === "continue" || value === "retry" || value === "stop") return value;
	throw new Error("Invalid recovery action.");
}

function requiredConversationAction(value: unknown): ChatGptConversationAction {
	if (!isRecord(value)) throw new Error("Invalid conversation management action.");
	if (value.action === "pin" || value.action === "unpin" || value.action === "archive") return { action: value.action };
	if (value.action === "rename") return { action: "rename", title: requiredString(value.title, "operation.title") };
	if (value.action === "move") return { action: "move", project: requiredString(value.project, "operation.project") };
	throw new Error("Invalid conversation management action.");
}

function requiredModelSelection(value: unknown): ChatGptSelection | string {
	if (typeof value === "string" && value !== "") return value;
	if (!isRecord(value)) throw new Error("Invalid ChatGPT model selection.");
	const model = value.model === undefined ? undefined : requiredString(value.model, "model.model");
	const effort = value.effort === undefined ? undefined : requiredString(value.effort, "model.effort");
	if (!model && !effort) throw new Error("ChatGPT model selection requires model or effort.");
	return { model, effort };
}

function requiredDriverState(value: unknown): "working" | "needs_user" | "completed" {
	if (value === "working" || value === "needs_user" || value === "completed") return value;
	throw new Error("Invalid driver state.");
}

function isSendSelector(selector: string): boolean {
	return selector.includes("send-button") || selector.includes("Send prompt") || selector.includes("composer-send");
}

function commandResult(ok: boolean, result?: unknown, error?: string): ExecResult {
	return {
		stdout: JSON.stringify(ok ? { success: true, result } : { success: false, error }),
		stderr: ok ? "" : (error ?? "Desktop CDP action failed."),
		code: ok ? 0 : 1,
		killed: false,
	};
}

function success(result: unknown): DesktopDriverEnvelope {
	return { version: 2, ok: true, result };
}

function failure(error: string): DesktopDriverEnvelope {
	return { version: 2, ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
