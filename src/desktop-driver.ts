import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	ChromeBridgeBrowserDriver,
	type ChatGptConversationCatalog,
	type ChatGptConversationFindRequest,
	type DriverSession,
	type WebChatDriver,
} from "./browser-driver";
import {
	CHATGPT_ORIGIN,
	extractChatPageObservation,
	providerConversationIdentity,
	type ChatPageObservation,
	type ChatGptConversationAction,
	type ChatGptSelection,
	type ExactBrowserActionTarget,
} from "./chatgpt";
import type { Launcher } from "./transport";
import type { Exec, ExecResult } from "./types";

export const DESKTOP_DRIVER_ID = "chatgpt-desktop-cdp/v1";
export const DESKTOP_DRIVER_VERSION = "0.5.0-alpha.2";
export const DESKTOP_STATE_WRITER_VERSION = 2;

export interface DesktopCdpTarget {
	id: string;
	type: "page" | "webview";
	title: string;
	url: string;
	browserInstanceId?: string;
	surface?: "web" | "desktop_shell";
	runtimeUrl?: string;
}

export interface DesktopCdpTargetReceipt {
	id: string;
	browserInstanceId: string;
}

export class DesktopTargetCreationError extends Error {
	constructor(message: string, readonly outcome: "not_created" | "unknown") {
		super(message);
		this.name = "DesktopTargetCreationError";
	}
}

export type DesktopCdpAction =
	| { kind: "fill"; selector: string; text: string; expectedUrl?: string }
	| { kind: "click" | "doubleClick" | "hover" | "activate"; selector: string; expectedUrl?: string }
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
	browserInstanceId: string;
}

export interface DesktopCdpEnvironment {
	verifyHost(): Promise<DesktopHostReceipt>;
	listTargets(): Promise<DesktopCdpTarget[]>;
	findConversations(request: ChatGptConversationFindRequest): Promise<ChatGptConversationCatalog>;
	createTarget(url: string): Promise<DesktopCdpTargetReceipt>;
	waitForTarget(targetId: string, browserInstanceId: string): Promise<DesktopCdpTarget>;
	navigateTarget(targetId: string, url: string): Promise<DesktopCdpTarget>;
	windowId(targetId: string, browserInstanceId?: string): Promise<number | undefined>;
	readHtml(targetId: string): Promise<string>;
	elementExists(targetId: string, selector: string, expectedUrl?: string): Promise<boolean>;
	act(targetId: string, action: DesktopCdpAction): Promise<unknown>;
	screenshot(targetId: string): Promise<string>;
	closeTarget(targetId: string, browserInstanceId?: string): Promise<void>;
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
	windowId?: number;
	browserInstanceId?: string;
	surface?: "web" | "desktop_shell";
	createdTarget?: boolean;
	creationPhase?: "intent_recorded" | "target_created" | "ready";
	creationOperationId?: string;
	creationStartedAt?: string;
	creationBaselineTargetIds?: string[];
	closeState?: "requested" | "close_dispatched" | "target_absent";
	closeOwnerToken?: string;
	closeOwnerPid?: number;
	closeOwnerHostname?: string;
	closeOwnerStartedAt?: string;
	url: string;
	state: "working" | "needs_user" | "completed";
	sendState: "prepared" | "attempted" | "submitted";
	assistantBaseline?: number;
	promptSha256?: string;
	createdAt: string;
}

interface DesktopDriverState {
	version: 2;
	writerVersion: 2;
	driverVersion: string;
	nextTabId: number;
	sessions: Record<string, DesktopSessionState>;
}

interface CreationReceiptRecord {
	version: 1;
	operationId: string;
	targetId: string;
	browserInstanceId: string;
	recordedAt: string;
}

const STATE_LOCK_LEASE_MS = 120_000;
const STATE_LOCK_INITIALIZATION_GRACE_MS = 2_000;
const CLOSE_OWNER_LEASE_MS = 300_000;
const execFileAsync = promisify(execFile);

class UnsafeStateLockError extends Error {}

export async function handleDesktopDriverRequest(
	request: DesktopDriverRequest,
	options: DesktopDriverOptions,
): Promise<DesktopDriverEnvelope> {
	if (request.version !== 2 || typeof request.action !== "string" || !isRecord(request.params)) {
		return failure("Invalid browser-driver protocol-v2 request.");
	}
	try {
		if (request.action === "probe") {
			const host = await options.environment.verifyHost();
			return success({
				ready: true,
				driver: DESKTOP_DRIVER_ID,
				driverVersion: DESKTOP_DRIVER_VERSION,
				stateWriterVersion: DESKTOP_STATE_WRITER_VERSION,
				secureInput: true,
				protocolVersion: 2,
				host,
			});
		}
		const host = await options.environment.verifyHost();
		const bridge = new DesktopCdpBridge(options, host);
		const driver: WebChatDriver = new ChromeBridgeBrowserDriver(bridge.exec, bridge.launcher);
		const params = request.params;
		switch (request.action) {
			case "find_conversations":
				return success(await options.environment.findConversations(requiredConversationFindRequest(params)));
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
			case "read_conversation": {
				const limit = requiredSafeInteger(params.limit, "limit");
				if (limit < 1 || limit > 20) throw new Error("Conversation read limit must be 1-20.");
				if (!driver.readConversation) throw new Error(`Browser driver ${driver.id} does not support conversation reads.`);
				return success(await driver.readConversation(requiredSession(params.session), limit));
			}
			case "manage_conversation":
				return success(await driver.manageConversation(requiredSession(params.session), requiredConversationAction(params.operation)));
			case "select_model":
				return success(await driver.selectModel(requiredSession(params.session), requiredModelSelection(params.model)));
			case "verify_model":
				return success(await driver.verifyModel(requiredSession(params.session), requiredModelSelection(params.model)));
			case "send":
				await driver.send(requiredSession(params.session));
				return success({});
			case "observe": {
				const session = requiredSession(params.session);
				const observation = await driver.observe(session);
				await bridge.confirmObservedCompletion(session.sessionId, observation);
				return success(observation);
			}
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

function requiredConversationFindRequest(value: Record<string, unknown>): ChatGptConversationFindRequest {
	const query = value.query === undefined ? undefined : requiredString(value.query, "query").replace(/\s+/g, " ").trim();
	if (query !== undefined && (query.length < 1 || query.length > 256)) throw new Error("Conversation query must be 1-256 characters.");
	const pinned = value.pinned === undefined ? undefined : requiredBoolean(value.pinned, "pinned");
	const projectId = value.project_id === undefined ? undefined : requiredString(value.project_id, "project_id");
	if (projectId !== undefined && (projectId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(projectId))) {
		throw new Error("Conversation project_id is invalid.");
	}
	const limit = value.limit === undefined ? 20 : requiredSafeInteger(value.limit, "limit");
	if (limit < 1 || limit > 50) throw new Error("Conversation search limit must be 1-50.");
	return { ...(query ? { query } : {}), ...(pinned !== undefined ? { pinned } : {}), ...(projectId ? { projectId } : {}), limit };
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

	constructor(private readonly options: DesktopDriverOptions, private host: DesktopHostReceipt) {}

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
		let session = await this.sessionByTabId(tabId);
		if (request.action === "press" && payload.expectedTarget === undefined) {
			await this.assertExactTarget(session);
			session = await this.sessionByTabId(tabId);
			return this.options.environment.act(session.targetId, {
				kind: "press",
				key: requiredString(payload.key, "key"),
				expectedUrl: session.url,
			});
		}
		const expectedTarget = requiredExpectedTarget(payload.expectedTarget);
		await this.assertExactTarget(session, expectedTarget);
		session = await this.sessionByTabId(tabId);
		if (request.action === "ping") return { pong: true, expectedTargetEnforcement: "document-v1" };
		if (request.action === "fill") {
			const prompt = requiredString(payload.text, "text");
			const assistantBaseline = extractChatPageObservation(await this.options.environment.readHtml(session.targetId)).snapshot.count;
			await this.preparePrompt(session.sessionId, prompt, assistantBaseline);
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
		if (request.action === "click" || request.action === "doubleClick" || request.action === "hover" || request.action === "activate") {
			const selector = requiredString(payload.selector, "selector");
			if (request.action === "click" && isSendSelector(selector)) {
				if (!await this.options.environment.elementExists(session.targetId, selector, expectedTarget.url)) {
					throw new Error(`No element found: ${selector}`);
				}
				await this.markSendAttempted(session.sessionId);
			}
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
			await withStateLock(this.options.stateRoot, async (state) => {
				const session = requireSession(state, sessionId);
				assertSessionNotClosing(session);
				session.state = next;
			});
			return { success: true };
		}
		if (operation === "close") {
			const sessionId = requiredString(rest[0], "sessionId");
			let unresolved = requireSession(await readState(this.options.stateRoot), sessionId);
			if (unresolved.creationPhase === "intent_recorded" && !unresolved.targetId) {
				const receipt = unresolved.creationOperationId
					? await readCreationReceipt(this.options.stateRoot, unresolved.creationOperationId)
					: undefined;
				if (receipt) {
					const recoveredWindowId = await this.options.environment.windowId(receipt.targetId, receipt.browserInstanceId);
					await withStateLock(this.options.stateRoot, async (state) => {
						const durable = requireSession(state, sessionId);
						if (durable.targetId || durable.creationOperationId !== receipt.operationId) {
							throw new Error(`Desktop session ${sessionId} creation receipt no longer matches its durable intent.`);
						}
						durable.targetId = receipt.targetId;
						durable.browserInstanceId = receipt.browserInstanceId;
						durable.createdTarget = true;
						durable.creationPhase = "target_created";
						if (recoveredWindowId !== undefined) durable.windowId = recoveredWindowId;
					});
					unresolved = requireSession(await readState(this.options.stateRoot), sessionId);
				}
			}
			if (unresolved.creationPhase === "intent_recorded" && !unresolved.targetId) {
				if (!unresolved.browserInstanceId || !unresolved.creationBaselineTargetIds) {
					throw new Error(`Desktop session ${sessionId} has an uncertain native-window creation outcome without recovery evidence; manual cleanup is required.`);
				}
				const currentHost = await this.options.environment.verifyHost();
				const currentTargets = await this.options.environment.listTargets();
				const state = await readState(this.options.stateRoot);
				const claimed = new Set(Object.values(state.sessions)
					.filter((entry) => entry.sessionId !== sessionId)
					.map((entry) => entry.targetId)
					.filter(Boolean));
				const candidates = currentHost.browserInstanceId === unresolved.browserInstanceId
					? currentTargets.filter((target) => !unresolved.creationBaselineTargetIds!.includes(target.id) && !claimed.has(target.id))
					: [];
				if (candidates.length > 0) {
					throw new Error(`Desktop session ${sessionId} has an uncertain native-window creation outcome with ${candidates.length} unclaimed post-intent renderer candidate(s); the durable record was retained for manual cleanup.`);
				}
				await withStateLock(this.options.stateRoot, async (current) => {
					const durable = requireSession(current, sessionId);
					if (durable.creationPhase !== "intent_recorded" || durable.targetId) throw new Error(`Desktop session ${sessionId} creation recovery state changed.`);
					delete current.sessions[sessionId];
				});
				return { success: true };
			}
			const closeToken = randomUUID();
			const snapshot = await withStateLock(this.options.stateRoot, async (state) => {
				const session = requireSession(state, sessionId);
				session.closeState ??= "requested";
				if (session.closeState === "target_absent") return { session: { ...session }, claimed: new Set<string>() };
				if (session.closeOwnerToken) {
					const ownerFresh = typeof session.closeOwnerStartedAt === "string"
						&& Date.now() - Date.parse(session.closeOwnerStartedAt) < CLOSE_OWNER_LEASE_MS;
					if (ownerFresh && session.closeOwnerHostname !== hostname()) throw new Error(`Desktop session ${sessionId} close is owned by another host.`);
					if (ownerFresh && session.closeOwnerPid && processIsAlive(session.closeOwnerPid)) throw new Error(`Desktop session ${sessionId} close is already in progress.`);
				}
				session.closeOwnerToken = closeToken;
				session.closeOwnerPid = process.pid;
				session.closeOwnerHostname = hostname();
				session.closeOwnerStartedAt = new Date().toISOString();
				return {
					session: { ...session },
					claimed: new Set(Object.values(state.sessions)
						.filter((entry) => entry.sessionId !== sessionId)
						.map((entry) => entry.targetId)
						.filter(Boolean)),
				};
			});
			if (snapshot.session.closeState === "target_absent") {
				await withStateLock(this.options.stateRoot, async (state) => { delete state.sessions[sessionId]; });
				return { success: true };
			}
			let ownedTargetId: string | undefined;
			try {
				const session = snapshot.session;
				if (session.createdTarget === true && !session.browserInstanceId) {
					throw new Error(`Desktop session ${sessionId} uses legacy ownership state and cannot safely close its renderer automatically; the durable record was retained for manual cleanup.`);
				}
				if (session.createdTarget === true && session.browserInstanceId !== this.host.browserInstanceId) {
					throw new Error(`Desktop session ${sessionId} belongs to a different ChatGPT Desktop browser instance; target absence cannot be proved and the durable record was retained.`);
				}
				if (session.targetId && session.createdTarget === true
					&& session.browserInstanceId === this.host.browserInstanceId) {
					const targets = await this.options.environment.listTargets();
					let owned = snapshot.claimed.has(session.targetId)
						? undefined
						: targets.find((target) => target.id === session.targetId);
					if (session.windowId !== undefined) {
						if (owned && await this.options.environment.windowId(owned.id, session.browserInstanceId) !== session.windowId) {
							throw new Error(`Desktop session ${sessionId} exact renderer is still live but its native window identity changed; the durable record was retained.`);
						}
						if (!owned) {
							const replacements: DesktopCdpTarget[] = [];
							for (const candidate of targets) {
								if (snapshot.claimed.has(candidate.id)) continue;
								if (await this.options.environment.windowId(candidate.id, session.browserInstanceId) === session.windowId) replacements.push(candidate);
							}
							if (replacements.length > 1) throw new Error(`Desktop session ${sessionId} has ambiguous replacement renderers in its owned window.`);
							owned = replacements[0];
						}
						} else if (!owned) {
							throw new Error(`Desktop session ${sessionId} lost its exact renderer and has no native window identity; the durable record was retained for manual cleanup.`);
						}
					ownedTargetId = owned?.id;
					if (ownedTargetId) {
						for (let attempt = 0; attempt < 4 && ownedTargetId; attempt += 1) {
							const targetToClose = ownedTargetId;
							ownedTargetId = await withStateLock(this.options.stateRoot, async (state) => {
								const durable = requireSession(state, sessionId);
								if (durable.closeOwnerToken !== closeToken) throw new Error(`Desktop session ${sessionId} close ownership changed.`);
								const duplicate = Object.values(state.sessions)
									.find((entry) => entry.sessionId !== sessionId && entry.targetId === targetToClose);
								if (duplicate) return undefined;
								durable.targetId = targetToClose;
								durable.closeState = "close_dispatched";
								return targetToClose;
							});
							if (!ownedTargetId) break;
							await this.options.environment.closeTarget(ownedTargetId, session.browserInstanceId);
							const afterClose = await this.options.environment.listTargets();
							if (afterClose.some((target) => target.id === targetToClose)) {
								throw new Error(`ChatGPT Desktop renderer ${targetToClose} is still present after close.`);
							}
							if (session.windowId === undefined) {
								throw new Error(`Desktop session ${sessionId} closed its exact renderer, but has no native window identity; replacement-window absence cannot be proved and the durable record was retained.`);
							}
							const replacements: DesktopCdpTarget[] = [];
							for (const candidate of afterClose) {
								if (snapshot.claimed.has(candidate.id)) continue;
								if (await this.options.environment.windowId(candidate.id, session.browserInstanceId) === session.windowId) replacements.push(candidate);
							}
							if (replacements.length > 1) throw new Error(`Desktop session ${sessionId} has ambiguous replacement renderers after close.`);
							ownedTargetId = replacements[0]?.id;
						}
						if (ownedTargetId) throw new Error(`Desktop session ${sessionId} kept replacing its renderer during bounded close cleanup.`);
					}
				} else if (session.targetId && session.createdTarget !== true) {
					throw new Error(`Desktop session ${sessionId} does not own a dedicated renderer; automatic close is refused.`);
				}
				await withStateLock(this.options.stateRoot, async (state) => {
					const durable = requireSession(state, sessionId);
					if (durable.closeOwnerToken !== closeToken) throw new Error(`Desktop session ${sessionId} close ownership changed.`);
					durable.closeState = "target_absent";
					delete durable.closeOwnerToken;
					delete durable.closeOwnerPid;
					delete durable.closeOwnerHostname;
					delete durable.closeOwnerStartedAt;
				});
			} catch (error) {
				await withStateLock(this.options.stateRoot, async (state) => {
					const durable = state.sessions[sessionId];
					if (durable?.closeOwnerToken !== closeToken) return;
					delete durable.closeOwnerToken;
					delete durable.closeOwnerPid;
					delete durable.closeOwnerHostname;
					delete durable.closeOwnerStartedAt;
				});
				throw error;
			}
			await withStateLock(this.options.stateRoot, async (state) => {
				const session = requireSession(state, sessionId);
				if (session.closeState !== "target_absent") throw new Error(`Desktop session ${sessionId} has not proved target cleanup.`);
				delete state.sessions[sessionId];
			});
			return { success: true };
		}
		throw new Error(`Unsupported desktop taskSession operation: ${operation}`);
	}

	private async navigateSession(sessionId: string, url: string): Promise<{ tabId: number }> {
		let snapshot = await this.sessionById(sessionId);
		if (!snapshot.targetId && snapshot.creationPhase === "intent_recorded") {
			const journaled = snapshot.creationOperationId
				? await readCreationReceipt(this.options.stateRoot, snapshot.creationOperationId)
				: undefined;
			if (!journaled) {
				throw new Error(`Desktop session ${sessionId} has an uncertain native-window creation outcome; no replacement window will be created automatically.`);
			}
			await withStateLock(this.options.stateRoot, async (state) => {
				const session = requireSession(state, sessionId);
				if (session.creationOperationId !== journaled.operationId || session.targetId) throw new Error("Desktop creation receipt no longer matches its durable intent.");
				session.targetId = journaled.targetId;
				session.browserInstanceId = journaled.browserInstanceId;
				session.createdTarget = true;
				session.creationPhase = "target_created";
				session.url = CHATGPT_ORIGIN;
			});
			snapshot = await this.sessionById(sessionId);
		}
		if (!snapshot.targetId || snapshot.creationPhase === "target_created") {
			let receipt: DesktopCdpTargetReceipt | undefined = snapshot.targetId && snapshot.browserInstanceId
				? { id: snapshot.targetId, browserInstanceId: snapshot.browserInstanceId }
				: undefined;
			let receiptJournaled = Boolean(receipt);
			let creationBaselineTargetIds = snapshot.creationBaselineTargetIds ?? [];
			const operationId = snapshot.creationOperationId ?? randomUUID();
			try {
				if (!receipt) {
					if (!this.options.allowCreateTarget) {
						throw new Error("ChatGPT Desktop mutations require a dedicated owned window, but target creation is disabled.");
					}
					const creationHost = await this.options.environment.verifyHost();
					creationBaselineTargetIds = (await this.options.environment.listTargets()).map((target) => target.id);
					const unresolved = await withStateLock(this.options.stateRoot, async (current) => {
						const session = requireSession(current, sessionId);
						if (session.targetId || session.creationPhase) throw new Error("Desktop session creation state changed before native window creation.");
						const conflict = Object.values(current.sessions)
							.find((entry) => entry.sessionId !== sessionId && entry.creationPhase === "intent_recorded" && !entry.targetId);
						if (conflict) {
							delete current.sessions[sessionId];
							return { operationId: conflict.creationOperationId, sessionId: conflict.sessionId };
						}
						session.browserInstanceId = creationHost.browserInstanceId;
						session.creationPhase = "intent_recorded";
						session.creationOperationId = operationId;
						session.creationStartedAt = new Date().toISOString();
						session.creationBaselineTargetIds = creationBaselineTargetIds;
						return undefined;
					});
					if (unresolved) {
						throw new Error(`Desktop window creation is blocked by unresolved intent ${unresolved.operationId} in session ${unresolved.sessionId}; no replacement window was created.`);
					}
					receipt = await this.options.environment.createTarget(CHATGPT_ORIGIN);
					await writeCreationReceipt(this.options.stateRoot, operationId, receipt);
					receiptJournaled = true;
					await withStateLock(this.options.stateRoot, async (current) => {
						const session = requireSession(current, sessionId);
						if (session.targetId && session.targetId !== receipt!.id) throw new Error("Desktop session target changed during provisional claim.");
						const duplicate = Object.values(current.sessions).find((entry) => entry.sessionId !== sessionId && entry.targetId === receipt!.id);
						if (duplicate) throw new Error("Desktop renderer is already owned by another GPT-Control session.");
						session.targetId = receipt!.id;
						session.browserInstanceId = receipt!.browserInstanceId;
						session.createdTarget = true;
						session.creationPhase = "target_created";
						session.url = CHATGPT_ORIGIN;
					});
				}
				const target = await this.options.environment.waitForTarget(receipt.id, receipt.browserInstanceId);
				const navigated = await this.options.environment.navigateTarget(target.id, url);
				const ownershipHost = await this.options.environment.verifyHost();
				if (receipt.browserInstanceId !== ownershipHost.browserInstanceId) {
					throw new Error("ChatGPT Desktop browser instance changed during native renderer creation.");
				}
				const provedTarget = (await this.options.environment.listTargets())
					.find((candidate) => candidate.id === navigated.id && sameExactUrl(candidate.url, navigated.url));
				if (!provedTarget) throw new Error("ChatGPT Desktop renderer ownership changed before durable claim.");
				this.host = ownershipHost;
				const windowId = await this.options.environment.windowId(navigated.id, ownershipHost.browserInstanceId);
				if (windowId === undefined) throw new Error("ChatGPT Desktop did not provide a native window identity for the created renderer.");
				await withStateLock(this.options.stateRoot, async (current) => {
					const session = requireSession(current, sessionId);
					if (session.targetId && session.targetId !== navigated.id) throw new Error("Desktop session target changed during claim.");
					const duplicate = Object.values(current.sessions).find((entry) => entry.sessionId !== sessionId && entry.targetId === navigated.id);
					if (duplicate) throw new Error("Desktop renderer is already owned by another GPT-Control session.");
					session.targetId = navigated.id;
					session.windowId = windowId;
					session.browserInstanceId = ownershipHost.browserInstanceId;
					session.surface = navigated.surface;
					session.createdTarget = true;
					session.creationPhase = "ready";
					session.url = exactChatGptUrl(navigated.url);
				});
				await removeCreationReceipt(this.options.stateRoot, operationId);
			} catch (error) {
				if (!receipt) {
					if (!(error instanceof DesktopTargetCreationError && error.outcome === "unknown")) {
						await withStateLock(this.options.stateRoot, async (state) => {
							const current = state.sessions[sessionId];
							if (current && !current.targetId) delete state.sessions[sessionId];
						});
						throw error;
					}
					const durableBoundaryRecorded = await withStateLock(this.options.stateRoot, async (state) => {
						const current = state.sessions[sessionId];
						if (!current) return false;
						if (!current.targetId && !current.creationPhase) {
							delete state.sessions[sessionId];
							return false;
						}
						return true;
					});
					if (!durableBoundaryRecorded) throw error;
					throw new Error(`${errorMessage(error)} Native-window creation intent ${operationId} in session ${sessionId} remains durably recorded because no exact target receipt was received; call close with this session ID to recover only after no post-intent renderer remains.`);
				}
				if (!receiptJournaled) {
					try {
						await writeCreationReceipt(this.options.stateRoot, operationId, receipt);
						receiptJournaled = true;
					} catch (journalError) {
						let stateRecordError: unknown;
						try {
							await withStateLock(this.options.stateRoot, async (state) => {
								const current = requireSession(state, sessionId);
								current.targetId = receipt!.id;
								current.browserInstanceId = receipt!.browserInstanceId;
								current.createdTarget = true;
								current.creationPhase = "target_created";
							});
						} catch (caught) {
							stateRecordError = caught;
						}
						let cleanupError: unknown;
						try {
							await this.cleanupProvisionalRenderer(sessionId, receipt, creationBaselineTargetIds, !stateRecordError);
						} catch (caught) {
							cleanupError = caught;
						}
						if (!cleanupError) {
							if (!stateRecordError) {
								await withStateLock(this.options.stateRoot, async (state) => { delete state.sessions[sessionId]; });
							}
							throw new Error(`${errorMessage(error)} Receipt persistence failed, but exact renderer ${receipt.id} cleanup was proved: ${errorMessage(journalError)}`);
						}
						if (!stateRecordError) {
							throw new Error(`${errorMessage(error)} Exact renderer ${receipt.id} remains durably recorded because receipt persistence and cleanup failed: ${errorMessage(journalError)}; ${errorMessage(cleanupError)}`);
						}
						throw new Error(`${errorMessage(error)} Exact renderer ${receipt.id} could not be journaled, recorded in state, or proved cleaned: ${errorMessage(journalError)}; ${errorMessage(stateRecordError)}; ${errorMessage(cleanupError)}`);
					}
				}
				try {
					await this.cleanupProvisionalRenderer(sessionId, receipt, creationBaselineTargetIds, true);
				} catch (closeError) {
					throw new Error(`${errorMessage(error)} Exact created renderer ${receipt.id} remains durably journaled because cleanup could not be proved: ${errorMessage(closeError)}`);
				}
				try {
					await withStateLock(this.options.stateRoot, async (state) => {
						const current = state.sessions[sessionId];
						if (current?.creationOperationId === operationId) delete state.sessions[sessionId];
					});
					await removeCreationReceipt(this.options.stateRoot, operationId);
				} catch (stateCleanupError) {
					throw new Error(`${errorMessage(error)} Renderer ${receipt.id} absence was proved, but durable state cleanup failed; receipt journal ${operationId} was retained: ${errorMessage(stateCleanupError)}`);
				}
				throw error;
			}
			snapshot = await this.sessionById(sessionId);
		} else {
			await this.assertExactTarget(snapshot);
			const navigated = await this.options.environment.navigateTarget(snapshot.targetId, url);
			await withStateLock(this.options.stateRoot, async (state) => { requireSession(state, sessionId).url = exactChatGptUrl(navigated.url); });
		}
		return { tabId: snapshot.tabId };
	}

	private async cleanupProvisionalRenderer(
		sessionId: string,
		receipt: DesktopCdpTargetReceipt,
		baselineTargetIds: readonly string[],
		persistState: boolean,
	): Promise<void> {
		const baseline = new Set(baselineTargetIds);
		let targetId: string | undefined = receipt.id;
		let windowId: number | undefined;
		try {
			windowId = await this.options.environment.windowId(receipt.id, receipt.browserInstanceId);
		} catch {
			// The exact-target and baseline checks below remain fail-closed when no
			// native window identity is available.
		}
		for (let attempt = 0; attempt < 4 && targetId; attempt += 1) {
			if (persistState) {
				await withStateLock(this.options.stateRoot, async (state) => {
					const current = requireSession(state, sessionId);
					current.targetId = targetId!;
					current.browserInstanceId = receipt.browserInstanceId;
					current.createdTarget = true;
					current.creationPhase = "target_created";
					if (windowId !== undefined) current.windowId = windowId;
				});
			}
			let closeError: unknown;
			try {
				await this.options.environment.closeTarget(targetId, receipt.browserInstanceId);
			} catch (caught) {
				closeError = caught;
			}
			const remaining = await this.options.environment.listTargets();
			if (remaining.some((target) => target.id === targetId)) {
				throw closeError ?? new Error(`ChatGPT Desktop provisional renderer ${targetId} is still present after close.`);
			}
			const state = await readState(this.options.stateRoot).catch(() => undefined);
			const claimed = new Set(state ? Object.values(state.sessions)
				.filter((entry) => entry.sessionId !== sessionId)
				.map((entry) => entry.targetId)
				.filter(Boolean) : []);
			const postIntent = remaining.filter((candidate) => !baseline.has(candidate.id) && !claimed.has(candidate.id));
			if (windowId === undefined) {
				if (postIntent.length > 0) throw new Error(`${postIntent.length} post-intent renderer candidate(s) remain after exact-target cleanup.`);
				return;
			}
			const replacements: DesktopCdpTarget[] = [];
			for (const candidate of postIntent) {
				if (await this.options.environment.windowId(candidate.id, receipt.browserInstanceId) === windowId) replacements.push(candidate);
			}
			if (replacements.length > 1) throw new Error("Multiple replacement renderers remain in the provisional native window.");
			targetId = replacements[0]?.id;
			if (!targetId) return;
		}
		if (targetId) throw new Error("The provisional native window kept replacing its renderer during bounded cleanup.");
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
		assertSessionNotClosing(session);
		if (session.createdTarget !== true) {
			throw new Error(`Desktop session ${session.sessionId} does not own a dedicated renderer; browser actions are refused.`);
		}
		if (session.createdTarget === true && session.creationPhase !== "ready") {
			throw new Error(`Desktop session ${session.sessionId} has a provisional renderer claim and is not ready for actions.`);
		}
		if (!session.browserInstanceId || session.browserInstanceId !== this.host.browserInstanceId) {
			throw new Error("ChatGPT Desktop browser instance changed; durable renderer ownership is no longer valid.");
		}
		if (!session.targetId) throw new Error(`Desktop session ${session.sessionId} owns no renderer.`);
		if (expected) {
			if (expected.sessionId !== session.sessionId || expected.tabId !== session.tabId || expected.name !== session.name) {
				throw new Error("Desktop exact target ownership changed before the browser action.");
			}
			if (!sameExactUrl(expected.url, session.url)) throw new Error("Desktop exact target recorded URL changed before the browser action.");
		}
			let targets = await this.options.environment.listTargets();
			let target = targets.find((candidate) => candidate.id === session.targetId);
			if (target && session.windowId !== undefined
				&& await this.options.environment.windowId(target.id, session.browserInstanceId) !== session.windowId) target = undefined;
			if (target
				&& !eligibleTarget(target)
				&& session.surface === "desktop_shell"
				&& session.sendState === "attempted"
				&& session.url === `${CHATGPT_ORIGIN}/`) {
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline && !eligibleTarget(target)) {
					await sleep(250);
					targets = await this.options.environment.listTargets();
					target = targets.find((candidate) => candidate.id === session.targetId);
					if (!target) break;
				}
			}
			if (!target && session.windowId === undefined) {
				throw new Error("Desktop exact target renderer changed and no native window identity is available for safe rebinding.");
			}
			if (!target) {
			const identity = providerConversationIdentity(session.url);
			if (identity) {
				const state = await readState(this.options.stateRoot);
				const claimed = new Set(Object.values(state.sessions)
					.filter((entry) => entry.sessionId !== session.sessionId)
					.map((entry) => entry.targetId)
					.filter(Boolean));
				const matches: DesktopCdpTarget[] = [];
				for (const candidate of targets) {
					const candidateIdentity = eligibleTarget(candidate) ? providerConversationIdentity(candidate.url) : undefined;
					if (candidateIdentity?.id !== identity.id || claimed.has(candidate.id)) continue;
					if (session.windowId !== undefined
						&& await this.options.environment.windowId(candidate.id, session.browserInstanceId) !== session.windowId) continue;
					matches.push(candidate);
				}
				if (matches.length === 1) {
					target = matches[0];
					const replacementWindowId = await this.options.environment.windowId(target.id, session.browserInstanceId);
					await withStateLock(this.options.stateRoot, async (current) => {
						const durable = requireSession(current, session.sessionId);
						const duplicate = Object.values(current.sessions).find((entry) => entry.sessionId !== session.sessionId && entry.targetId === target?.id);
						if (duplicate) throw new Error("Replacement ChatGPT Desktop renderer became owned by another session.");
						durable.targetId = target!.id;
						durable.windowId = replacementWindowId;
						durable.surface = target!.surface;
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
		const session = requireSession(await readState(this.options.stateRoot), sessionId);
		assertSessionNotClosing(session);
		return session;
	}

	private async sessionByTabId(tabId: number): Promise<DesktopSessionState> {
		const session = Object.values((await readState(this.options.stateRoot)).sessions).find((entry) => entry.tabId === tabId);
		if (!session) throw new Error(`Desktop tab ${tabId} is not owned by GPT-Control.`);
		assertSessionNotClosing(session);
		return session;
	}

	private async actOnTab(tabId: number, action: DesktopCdpAction): Promise<unknown> {
		const session = await this.sessionByTabId(tabId);
		await this.assertExactTarget(session);
		return this.options.environment.act(session.targetId, { ...action, expectedUrl: session.url });
	}

	async confirmObservedCompletion(sessionId: string, observation: ChatPageObservation): Promise<void> {
		if (observation.answering || observation.thinking || observation.toolRunning) return;
		await withStateLock(this.options.stateRoot, async (state) => {
			const session = requireSession(state, sessionId);
			if (session.sendState !== "attempted" || session.assistantBaseline === undefined) return;
			if (observation.snapshot.count <= session.assistantBaseline || !observation.snapshot.text.trim()) return;
			session.sendState = "submitted";
		});
	}

	private async preparePrompt(sessionId: string, prompt: string, assistantBaseline: number): Promise<void> {
		await withStateLock(this.options.stateRoot, async (state) => {
			const session = requireSession(state, sessionId);
			if (session.sendState === "attempted") throw new Error("The prior desktop send was already attempted and remains ambiguous; prompt replacement is refused.");
			session.sendState = "prepared";
			session.promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
			session.assistantBaseline = assistantBaseline;
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

async function writeCreationReceipt(root: string, operationId: string, receipt: DesktopCdpTargetReceipt): Promise<void> {
	const directory = await secureDirectory(join(resolve(root), "creation-receipts"));
	const destination = join(directory, `${safeOperationId(operationId)}.json`);
	const record: CreationReceiptRecord = {
		version: 1,
		operationId,
		targetId: receipt.id,
		browserInstanceId: receipt.browserInstanceId,
		recordedAt: new Date().toISOString(),
	};
	const existing = await readCreationReceipt(root, operationId);
	if (existing) {
		if (existing.targetId !== receipt.id || existing.browserInstanceId !== receipt.browserInstanceId) {
			throw new Error(`Conflicting desktop creation receipt for operation ${operationId}.`);
		}
		return;
	}
	const scratch = join(directory, `.${operationId}-${randomUUID()}.tmp`);
	const handle = await open(scratch, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(scratch, destination);
	} catch (error) {
		if (!isAlreadyExists(error)) throw error;
		const winner = await readCreationReceipt(root, operationId);
		if (!winner || winner.targetId !== receipt.id || winner.browserInstanceId !== receipt.browserInstanceId) {
			throw new Error(`Conflicting desktop creation receipt for operation ${operationId}.`);
		}
	} finally {
		await rm(scratch, { force: true });
	}
}

async function readCreationReceipt(root: string, operationId: string): Promise<CreationReceiptRecord | undefined> {
	const directory = await secureDirectory(join(resolve(root), "creation-receipts"));
	const path = join(directory, `${safeOperationId(operationId)}.json`);
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe desktop creation receipt: ${path}`);
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!isRecord(value)
			|| value.version !== 1
			|| value.operationId !== operationId
			|| typeof value.targetId !== "string"
			|| !/^[A-Za-z0-9_-]{8,128}$/.test(value.targetId)
			|| typeof value.browserInstanceId !== "string"
			|| value.browserInstanceId.length < 8
			|| value.browserInstanceId.length > 256
			|| typeof value.recordedAt !== "string"
			|| !Number.isFinite(Date.parse(value.recordedAt))) {
			throw new Error(`Invalid desktop creation receipt: ${path}`);
		}
		return value as unknown as CreationReceiptRecord;
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function removeCreationReceipt(root: string, operationId: string): Promise<void> {
	const directory = await secureDirectory(join(resolve(root), "creation-receipts"));
	const path = join(directory, `${safeOperationId(operationId)}.json`);
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe desktop creation receipt: ${path}`);
		await rm(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

function safeOperationId(operationId: string): string {
	if (!/^[a-f0-9]{8}-[a-f0-9-]{27,63}$/i.test(operationId)) throw new Error("Invalid desktop creation operation ID.");
	return operationId;
}

async function readState(root: string): Promise<DesktopDriverState> {
	await secureDirectory(root);
	const path = join(resolve(root), "state.json");
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe desktop driver state: ${path}`);
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (isRecord(parsed) && parsed.version === 1) return migrateLegacyState(parsed);
		return parseState(parsed);
	} catch (error) {
		if (isMissing(error)) return {
			version: 2,
			writerVersion: DESKTOP_STATE_WRITER_VERSION,
			driverVersion: DESKTOP_DRIVER_VERSION,
			nextTabId: 1,
			sessions: {},
		};
		throw error;
	}
}

async function withStateLock<T>(root: string, work: (state: DesktopDriverState) => Promise<T> | T): Promise<T> {
	await secureDirectory(root);
	const lock = join(resolve(root), "state.lock");
	const deadline = Date.now() + 30_000;
	const token = randomUUID();
	const processStartId = await localProcessStartId(process.pid);
	let lockIdentity: { dev: number; ino: number } | undefined;
	for (;;) {
		try {
			await mkdir(lock, { mode: 0o700 });
			const info = await lstat(lock);
			lockIdentity = { dev: info.dev, ino: info.ino };
		} catch (error) {
			if (!isAlreadyExists(error) || Date.now() >= deadline) throw error;
			if (await recoverDeadLocalLock(lock)) continue;
			await sleep(25);
			continue;
		}
		try {
			const ownerScratch = join(lock, `.owner-${token}.tmp`);
			await writeFile(ownerScratch, `${JSON.stringify({
				token,
				pid: process.pid,
				hostname: hostname(),
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + STATE_LOCK_LEASE_MS).toISOString(),
				processStartId,
			})}\n`, { mode: 0o600, flag: "wx" });
			await rename(ownerScratch, join(lock, "owner.json"));
			break;
		} catch (error) {
			if (lockIdentity) {
				const current = await lstat(lock).catch(() => undefined);
				if (current?.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
					await rm(lock, { recursive: true, force: true });
				}
			}
			throw error;
		}
	}
	try {
		const state = await readState(root);
		const result = await work(state);
		state.version = 2;
		state.writerVersion = DESKTOP_STATE_WRITER_VERSION;
		state.driverVersion = DESKTOP_DRIVER_VERSION;
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
		let owner: unknown;
		try {
			owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as unknown;
		} catch {
			if (await lockIsWithinInitializationGrace(lock)) return false;
			throw new UnsafeStateLockError(`Refused ownerless desktop state lock: ${lock}. Manual inspection is required.`);
		}
		if (!isRecord(owner)
			|| typeof owner.hostname !== "string"
			|| typeof owner.pid !== "number"
			|| !Number.isInteger(owner.pid)
			|| owner.pid <= 0
			|| typeof owner.token !== "string"
			|| typeof owner.expiresAt !== "string"
			|| !Number.isFinite(Date.parse(owner.expiresAt))
			|| typeof owner.processStartId !== "string"
			|| owner.processStartId === "") {
			if (isRecord(owner)
				&& owner.hostname === hostname()
				&& typeof owner.pid === "number"
				&& Number.isInteger(owner.pid)
				&& owner.pid > 0
				&& !processIsAlive(owner.pid)) {
				await rm(lock, { recursive: true, force: true });
				return true;
			}
			if (await lockIsWithinInitializationGrace(lock)) return false;
			throw new UnsafeStateLockError(`Refused malformed desktop state lock: ${lock}. Manual inspection is required.`);
		}
		// A valid owner record is never stolen from a live local process or from
		// another host. The fixed expiry is diagnostic only; without a fencing
		// generation, removing that lock could let the old writer commit later.
		if (owner.hostname !== hostname()) return false;
		if (!processIsAlive(owner.pid)) {
			await rm(lock, { recursive: true, force: true });
			return true;
		}
		const currentStartId = await localProcessStartId(owner.pid);
		if (currentStartId === owner.processStartId) return false;
		await rm(lock, { recursive: true, force: true });
		return true;
	} catch (error) {
		if (error instanceof UnsafeStateLockError) throw error;
		return false;
	}
}

async function lockIsWithinInitializationGrace(lock: string): Promise<boolean> {
	try {
		const info = await lstat(lock);
		return info.isDirectory() && Date.now() - info.mtimeMs < STATE_LOCK_INITIALIZATION_GRACE_MS;
	} catch {
		return false;
	}
}

async function localProcessStartId(pid: number): Promise<string> {
	try {
		const result = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
			timeout: 5_000,
			maxBuffer: 64 * 1024,
			encoding: "utf8",
		});
		const value = result.stdout.trim();
		if (!value) throw new Error(`Process ${pid} is unavailable.`);
		return value;
	} catch (error) {
		throw new Error(`Could not verify process ${pid} start identity: ${errorMessage(error)}`);
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
	if (!isRecord(value)
		|| value.version !== 2
		|| value.writerVersion !== DESKTOP_STATE_WRITER_VERSION
		|| typeof value.driverVersion !== "string"
		|| value.driverVersion.length < 1
		|| value.driverVersion.length > 64
		|| !Number.isInteger(value.nextTabId)
		|| !isRecord(value.sessions)) {
		throw new Error("Invalid durable ChatGPT Desktop driver state.");
	}
	for (const [key, candidate] of Object.entries(value.sessions)) {
		if (!isRecord(candidate)
			|| candidate.sessionId !== key
			|| typeof candidate.name !== "string"
			|| !Number.isInteger(candidate.tabId)
			|| typeof candidate.targetId !== "string"
			|| (candidate.windowId !== undefined && (!Number.isSafeInteger(candidate.windowId) || (candidate.windowId as number) < 0))
			|| (candidate.browserInstanceId !== undefined && (typeof candidate.browserInstanceId !== "string" || candidate.browserInstanceId.length < 8 || candidate.browserInstanceId.length > 256))
			|| (candidate.surface !== undefined && candidate.surface !== "web" && candidate.surface !== "desktop_shell")
			|| (candidate.createdTarget !== undefined && typeof candidate.createdTarget !== "boolean")
			|| (candidate.creationPhase !== undefined && candidate.creationPhase !== "intent_recorded" && candidate.creationPhase !== "target_created" && candidate.creationPhase !== "ready")
			|| (candidate.creationOperationId !== undefined && (typeof candidate.creationOperationId !== "string" || candidate.creationOperationId.length < 8))
			|| (candidate.creationStartedAt !== undefined && (typeof candidate.creationStartedAt !== "string" || !Number.isFinite(Date.parse(candidate.creationStartedAt))))
			|| (candidate.creationBaselineTargetIds !== undefined && (!Array.isArray(candidate.creationBaselineTargetIds)
				|| candidate.creationBaselineTargetIds.length > 1_000
				|| candidate.creationBaselineTargetIds.some((targetId) => typeof targetId !== "string" || targetId.length < 1 || targetId.length > 256)))
			|| (candidate.closeState !== undefined && candidate.closeState !== "requested" && candidate.closeState !== "close_dispatched" && candidate.closeState !== "target_absent")
			|| (candidate.closeOwnerToken !== undefined && (typeof candidate.closeOwnerToken !== "string" || candidate.closeOwnerToken.length < 8))
			|| (candidate.closeOwnerPid !== undefined && (!Number.isSafeInteger(candidate.closeOwnerPid) || (candidate.closeOwnerPid as number) <= 0))
			|| (candidate.closeOwnerHostname !== undefined && (typeof candidate.closeOwnerHostname !== "string" || candidate.closeOwnerHostname === ""))
			|| (candidate.closeOwnerStartedAt !== undefined && (typeof candidate.closeOwnerStartedAt !== "string" || !Number.isFinite(Date.parse(candidate.closeOwnerStartedAt))))
			|| ((candidate.closeOwnerToken === undefined) !== (candidate.closeOwnerPid === undefined))
			|| ((candidate.closeOwnerToken === undefined) !== (candidate.closeOwnerHostname === undefined))
			|| ((candidate.closeOwnerToken === undefined) !== (candidate.closeOwnerStartedAt === undefined))
			|| typeof candidate.url !== "string"
			|| !new Set(["working", "needs_user", "completed"]).has(String(candidate.state))
			|| !new Set(["prepared", "attempted", "submitted"]).has(String(candidate.sendState))
			|| typeof candidate.createdAt !== "string"
			|| (candidate.assistantBaseline !== undefined && (!Number.isSafeInteger(candidate.assistantBaseline) || (candidate.assistantBaseline as number) < 0))
			|| (candidate.promptSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(candidate.promptSha256)))) {
			throw new Error("Invalid durable ChatGPT Desktop session record.");
		}
	}
	return value as unknown as DesktopDriverState;
}

function migrateLegacyState(value: Record<string, unknown>): DesktopDriverState {
	if (value.version !== 1 || !Number.isInteger(value.nextTabId) || !isRecord(value.sessions)) {
		throw new Error("Invalid legacy ChatGPT Desktop driver state.");
	}
	const sessions: Record<string, DesktopSessionState> = {};
	for (const [key, candidate] of Object.entries(value.sessions)) {
		if (!isRecord(candidate)
			|| candidate.sessionId !== key
			|| typeof candidate.name !== "string"
			|| !Number.isInteger(candidate.tabId)
			|| typeof candidate.targetId !== "string"
			|| (candidate.windowId !== undefined && (!Number.isSafeInteger(candidate.windowId) || (candidate.windowId as number) < 0))
			|| (candidate.browserInstanceId !== undefined && (typeof candidate.browserInstanceId !== "string" || candidate.browserInstanceId.length < 8 || candidate.browserInstanceId.length > 256))
			|| (candidate.surface !== undefined && candidate.surface !== "web" && candidate.surface !== "desktop_shell")
			|| (candidate.createdTarget !== undefined && typeof candidate.createdTarget !== "boolean")
			|| (candidate.closeState !== undefined && candidate.closeState !== "requested" && candidate.closeState !== "target_closed")
			|| (candidate.closeOwnerToken !== undefined && (typeof candidate.closeOwnerToken !== "string" || candidate.closeOwnerToken.length < 8))
			|| (candidate.closeOwnerPid !== undefined && (!Number.isSafeInteger(candidate.closeOwnerPid) || (candidate.closeOwnerPid as number) <= 0))
			|| (candidate.closeOwnerHostname !== undefined && (typeof candidate.closeOwnerHostname !== "string" || candidate.closeOwnerHostname === ""))
			|| ((candidate.closeOwnerToken === undefined) !== (candidate.closeOwnerPid === undefined))
			|| ((candidate.closeOwnerToken === undefined) !== (candidate.closeOwnerHostname === undefined))
			|| typeof candidate.url !== "string"
			|| !new Set(["working", "needs_user", "completed"]).has(String(candidate.state))
			|| !new Set(["prepared", "attempted", "submitted"]).has(String(candidate.sendState))
			|| typeof candidate.createdAt !== "string"
			|| (candidate.assistantBaseline !== undefined && (!Number.isSafeInteger(candidate.assistantBaseline) || (candidate.assistantBaseline as number) < 0))
			|| (candidate.promptSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(candidate.promptSha256)))) {
			throw new Error("Invalid legacy ChatGPT Desktop session record.");
		}
		if (candidate.closeOwnerToken !== undefined
			&& (candidate.closeOwnerHostname !== hostname() || processIsAlive(candidate.closeOwnerPid as number))) {
			throw new Error(`Legacy ChatGPT Desktop session ${key} has an active or unprovable close owner; migration is refused until that owner is gone.`);
		}
		sessions[key] = {
			sessionId: key,
			name: candidate.name,
			tabId: candidate.tabId as number,
			targetId: candidate.targetId,
			...(candidate.windowId !== undefined ? { windowId: candidate.windowId as number } : {}),
			...(typeof candidate.browserInstanceId === "string" ? { browserInstanceId: candidate.browserInstanceId } : {}),
			...(candidate.surface === "web" || candidate.surface === "desktop_shell" ? { surface: candidate.surface } : {}),
			...(typeof candidate.createdTarget === "boolean" ? { createdTarget: candidate.createdTarget } : {}),
			...(candidate.targetId ? { creationPhase: "ready" as const } : {}),
			...(candidate.closeState === "requested" ? { closeState: "requested" as const } : {}),
			...(candidate.closeState === "target_closed" ? { closeState: "close_dispatched" as const } : {}),
			url: candidate.url,
			state: candidate.state as DesktopSessionState["state"],
			sendState: candidate.sendState as DesktopSessionState["sendState"],
			...(typeof candidate.assistantBaseline === "number" ? { assistantBaseline: candidate.assistantBaseline } : {}),
			...(typeof candidate.promptSha256 === "string" ? { promptSha256: candidate.promptSha256 } : {}),
			createdAt: candidate.createdAt,
		};
	}
	return parseState({
		version: 2,
		writerVersion: DESKTOP_STATE_WRITER_VERSION,
		driverVersion: DESKTOP_DRIVER_VERSION,
		nextTabId: value.nextTabId,
		sessions,
	});
}

function requireSession(state: DesktopDriverState, sessionId: string): DesktopSessionState {
	const session = state.sessions[sessionId];
	if (!session) throw new Error(`Unknown ChatGPT Desktop session: ${sessionId}`);
	return session;
}

function assertSessionNotClosing(session: DesktopSessionState): void {
	if (session.closeState) throw new Error(`Desktop session ${session.sessionId} is closing; only close retry is allowed.`);
}

function eligibleTarget(target: DesktopCdpTarget): boolean {
	if (target.type !== "page" && target.type !== "webview") return false;
	try {
		const url = new URL(target.url);
		if (url.origin !== CHATGPT_ORIGIN) return false;
		const direct = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
		return !direct || /^[A-Za-z0-9_-]{8,128}$/.test(direct[1]);
	} catch {
		return false;
	}
}

function exactChatGptUrl(raw: string): string {
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error(`Invalid ChatGPT URL: ${raw}`); }
	if (url.origin !== CHATGPT_ORIGIN || url.username || url.password || url.hash) throw new Error(`Refused URL outside ${CHATGPT_ORIGIN}.`);
	const direct = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
	if (direct && !/^[A-Za-z0-9_-]{8,128}$/.test(direct[1])) throw new Error("Refused synthetic or invalid ChatGPT conversation URL.");
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

function requiredSafeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer.`);
	return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
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
	return selector.includes("send-button")
		|| selector.includes("Send prompt")
		|| selector.includes("composer-send")
		|| selector === 'button[aria-label="Send"]';
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
	const message = error instanceof Error ? error.message : String(error);
	return message || "Unknown ChatGPT Desktop driver failure.";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
