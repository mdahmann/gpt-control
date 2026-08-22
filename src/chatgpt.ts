import { parse, type HTMLElement } from "node-html-parser";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeCommandError, isRecord, parseCommandJson, readArray, readNumber, readRecord, readString } from "./json";
import { runLauncher, runPrivateBridgeRequest, type Launcher } from "./transport";
import { nowIso, type ChatGptModel, type RecoveryAttempt } from "./domain";
import type { Exec } from "./types";

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const GPT_CONTROL_PROMPT_ENVELOPE_PREAMBLE = "GPT-Control exact task envelope v1 follows. Treat the text block as instructions and preserve it unchanged.";

export function gptControlPromptProofLine(token: string): string {
	return `[GPT-Control run proof: ${token}. Ignore this line in your response.]`;
}

const PROMPT_SELECTORS = ["#prompt-textarea", 'div[contenteditable="true"]'];
const SEND_SELECTORS = ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[data-testid="composer-send-button"]'];
const FILE_INPUT_SELECTOR = 'input[type="file"]';
const USER_PROMPT_CONTENT_SELECTORS = ["[data-message-content]", ".whitespace-pre-wrap", ".prose"];
const EXPLICIT_MODEL_TEST_IDS = ["model-switcher-dropdown-button", "model-selector", "composer-model-selector"];
const TRANSIENT_TAB_URLS = new Set(["chrome://newtab/", "chrome://newtab", "about:blank"]);

export interface ChatSession {
	sessionId: string;
	tabId: number;
}

export interface AssistantTurn {
	text: string;
	imageUrls: string[];
	hasMarkdown: boolean;
	messageId?: string;
}

export interface AssistantSnapshot extends AssistantTurn {
	count: number;
}

export interface ComposerModelObservation {
	label: string;
	normalized: string;
	selector: string;
}

export interface ModelVerification {
	requestedModel: string;
	observedModel: string;
	modelVerified: true;
	modelEvidenceKind: "composer_selector";
	modelVerifiedAt: string;
}

export interface ChatPageObservation {
	snapshot: AssistantSnapshot;
	latestUserMessageId?: string;
	latestUserPromptSha256?: string;
	latestUserPromptProofToken?: string;
	composerReady: boolean;
	answering: boolean;
	thinking: boolean;
	toolRunning: boolean;
	retryAvailable: boolean;
	continueAvailable: boolean;
	errorMessage?: string;
	stateSummary: string;
}

export function canonicalPromptObservationText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export interface CompletionOutcome {
	terminalStatus: "completed" | "needs_user";
	reason?: string;
	snapshot?: AssistantSnapshot;
	providerConversationId?: string;
	providerConversationUrl?: string;
	recoveryAttempts: RecoveryAttempt[];
	lastObservedUrl?: string;
	lastObservedUiState?: string;
}

/** Raised when Chrome Bridge policy blocks an action; carries the fix. */
export class PolicyDeniedError extends Error {
	readonly remediation: string;

	constructor(message: string, remediation: string) {
		super(message);
		this.name = "PolicyDeniedError";
		this.remediation = remediation;
	}
}

function bridge(exec: Exec, launcher: Launcher, args: string[], signal?: AbortSignal, timeout = 60_000) {
	return runLauncher(exec, launcher, args, { signal, timeout });
}

async function bridgeJson(
	exec: Exec,
	launcher: Launcher,
	args: string[],
	signal?: AbortSignal,
	timeout = 60_000,
): Promise<Record<string, unknown>> {
	const result = await bridge(exec, launcher, args, signal, timeout);
	try {
		return parseCommandJson(result, `chrome-bridge ${args[0]}`);
	} catch (error) {
		throw translatePolicyDenial(error);
	}
}

async function privateBridgeJson(
	exec: Exec,
	launcher: Launcher,
	action: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
	timeout = 60_000,
): Promise<Record<string, unknown>> {
	const result = await runPrivateBridgeRequest(exec, launcher, action, payload, {
		signal,
		timeout,
		readTimeoutMs: Math.max(1, timeout - 10_000),
	});
	try {
		return parseCommandJson(result, `chrome-bridge ${action}`);
	} catch (error) {
		throw translatePolicyDenial(error);
	}
}

export function translatePolicyDenial(error: unknown): unknown {
	if (!(error instanceof BridgeCommandError)) return error;
	const denial = readRecord(error.payload, "policyDenial");
	if (!denial) return error;
	const kind = readString(denial, "kind");
	if (kind !== "egress" && kind !== "origin") {
		const remediation = readString(denial, "remediation");
		return new Error(remediation ? `${error.message}. ${remediation}` : error.message);
	}
	const client = readString(denial, "client") ?? "default";
	const grant = kind === "egress" ? "allow-egress" : "allow-origin";
	return new PolicyDeniedError(
		`Chrome Bridge policy blocked this action (${kind}).`,
		`chrome-bridge policy ${grant} ${CHATGPT_ORIGIN} ${client}`,
	);
}

export function tabIdFromSession(session: Record<string, unknown>): number | undefined {
	const tabs = session.tabIds ?? session.tabs;
	if (!Array.isArray(tabs)) return undefined;
	for (const entry of tabs) {
		if (typeof entry === "number") return entry;
		const id = readNumber(entry, "id") ?? readNumber(entry, "tabId");
		if (id !== undefined) return id;
	}
	return undefined;
}

function resultOf(payload: Record<string, unknown>): unknown {
	return payload.result ?? payload;
}

export function extractTabId(payload: Record<string, unknown>): number | undefined {
	const direct = readNumber(payload, "tabId");
	if (direct !== undefined) return direct;
	const result = resultOf(payload);
	const nested = readNumber(result, "tabId");
	if (nested !== undefined) return nested;
	for (const key of ["tabIds", "tabs"]) {
		const list = readArray(result, key) ?? readArray(payload, key);
		const first = list?.[0];
		if (typeof first === "number") return first;
		const id = readNumber(first, "id") ?? readNumber(first, "tabId");
		if (id !== undefined) return id;
	}
	return undefined;
}

export async function createSession(
	exec: Exec,
	launcher: Launcher,
	name: string,
	signal?: AbortSignal,
): Promise<string> {
	const payload = await bridgeJson(exec, launcher, ["taskSession", "create", name], signal);
	const sessionId = readString(resultOf(payload), "sessionId") ?? readString(payload, "sessionId");
	if (!sessionId) throw new Error("chrome-bridge taskSession create returned no sessionId");
	return sessionId;
}

export async function openChat(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	url: string,
	signal?: AbortSignal,
): Promise<number> {
	const payload = await bridgeJson(exec, launcher, ["taskSession", "navigate", sessionId, url], signal, 120_000);
	const tabId = extractTabId(payload);
	if (tabId === undefined) throw new Error("chrome-bridge taskSession navigate returned no tab id");
	return tabId;
}

function isTransient(message: string): boolean {
	return /tab origin unresolved|No element found|not ready|detached|no such tab|target closed/i.test(message);
}

async function actOnSelector(
	exec: Exec,
	launcher: Launcher,
	args: (selector: string) => string[],
	selectors: readonly string[],
	options: { signal?: AbortSignal; deadline: number; what: string },
): Promise<string> {
	let lastError = "the page never became ready";
	for (let attempt = 0; ; attempt += 1) {
		for (const selector of selectors) {
			const result = await bridge(exec, launcher, args(selector), options.signal, 60_000);
			try {
				parseCommandJson(result, `chrome-bridge ${options.what}`);
				return selector;
			} catch (error) {
				const translated = translatePolicyDenial(error);
				if (translated instanceof PolicyDeniedError) throw translated;
				lastError = translated instanceof Error ? translated.message : String(translated);
				if (!isTransient(lastError)) throw translated;
			}
		}
		if (Date.now() >= options.deadline || options.signal?.aborted) break;
		await sleep(Math.min(pollIntervalMs(), 250 * 2 ** attempt, 2000));
	}
	throw new Error(`Could not ${options.what}. Last error: ${lastError}`);
}

export async function attachFiles(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	files: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	if (files.length === 0) return;
	await privateBridgeJson(exec, launcher, "uploadFile", {
		tabId,
		selector: FILE_INPUT_SELECTOR,
		files: [...files],
	}, signal, 180_000);
}

export async function fillPrompt(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	prompt: string,
	signal?: AbortSignal,
	readyTimeoutMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + readyTimeoutMs;
	let lastError = "the composer never became ready";
	for (let attempt = 0; ; attempt += 1) {
		for (const selector of PROMPT_SELECTORS) {
			try {
				await privateBridgeJson(exec, launcher, "fill", { tabId, selector, text: prompt }, signal, 60_000);
				lastError = "";
				break;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				lastError = message;
				if (!isTransient(message)) throw error;
			}
		}
		if (lastError === "") return;
		if (Date.now() >= deadline || signal?.aborted) throw new Error(`Could not fill the ChatGPT prompt. Last error: ${lastError}`);
		await sleep(Math.min(pollIntervalMs(), 250 * 2 ** attempt, 2000));
	}
}

export async function clickSend(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	signal?: AbortSignal,
): Promise<void> {
	await actOnSelector(exec, launcher, (selector) => ["click", String(tabId), selector], SEND_SELECTORS, {
		signal,
		deadline: Date.now() + 30_000,
		what: "click the ChatGPT send button",
	});
}

/** Compatibility helper. Security-sensitive callers should fill, verify model, then clickSend. */
export async function submitPrompt(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	prompt: string,
	signal?: AbortSignal,
	readyTimeoutMs = 60_000,
): Promise<void> {
	await fillPrompt(exec, launcher, tabId, prompt, signal, readyTimeoutMs);
	await clickSend(exec, launcher, tabId, signal);
}

export function countAssistantTurns(html: string): number {
	return parse(html).querySelectorAll('[data-message-author-role="assistant"]').length;
}

export async function tabUrl(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const payload = await bridgeJson(exec, launcher, ["getTabs"], signal);
	const result = resultOf(payload);
	const tabs = Array.isArray(result) ? result : (readArray(result, "tabs") ?? readArray(payload, "tabs") ?? []);
	for (const tab of tabs) {
		if (readNumber(tab, "id") === tabId) return readString(tab, "url");
	}
	return undefined;
}

export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.GPT_CONTROL_POLL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

export async function assertOwnedSessionTab(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	tabId: number,
	signal?: AbortSignal,
	expectedName?: string,
): Promise<string | undefined> {
	const session = await showSession(exec, launcher, sessionId, signal);
	const name = typeof session.name === "string" ? session.name : "";
	if (expectedName ? name !== expectedName : !name.startsWith("gpt-control:")) {
		throw new Error(`Refused foreign or renamed Chrome Bridge session ${sessionId}.`);
	}
	const ownedTab = tabIdFromSession(session);
	if (ownedTab === undefined || ownedTab !== tabId) throw new Error(`Chrome Bridge session ${sessionId} no longer owns the recorded tab.`);
	return tabUrl(exec, launcher, tabId, signal);
}

export async function waitForOwnedChatReady(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	tabId: number,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ url: string; snapshot: AssistantSnapshot }> {
	const deadline = Date.now() + (options.timeoutMs ?? 60_000);
	let last = "the tab did not report a URL";
	for (let attempt = 0; Date.now() < deadline; attempt += 1) {
		if (options.signal?.aborted) throw new Error("ChatGPT readiness wait was cancelled.");
		try {
			const current = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
			if (!current) {
				last = "owned tab URL unavailable";
			} else if (TRANSIENT_TAB_URLS.has(current)) {
				last = `owned tab is still committing (${current})`;
			} else {
				let url: URL;
				try {
					url = new URL(current);
				} catch {
					throw new Error(`Owned tab returned an invalid URL: ${current}`);
				}
				if (url.origin !== CHATGPT_ORIGIN) throw new Error(`Refused tab outside ${CHATGPT_ORIGIN}: ${current}`);
				const html = await readPageHtml(exec, launcher, tabId, options.signal);
				const observation = extractChatPageObservation(html);
				if (observation.composerReady) return { url: current, snapshot: observation.snapshot };
				last = `ChatGPT loaded at ${current}, but the composer is not usable yet`;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isTransient(message) && !/still committing|composer is not usable|URL unavailable/i.test(message)) throw error;
			last = message;
		}
		await sleep(Math.min(pollIntervalMs(), 250 * 2 ** attempt, 2000));
	}
	throw new Error(`ChatGPT tab did not become ready before the bounded timeout. Last observation: ${last}. No prompt was sent.`);
}

export async function restoreExactConversation(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	tabId: number,
	exactUrl: string,
	expectedAssistantTurns: number,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AssistantSnapshot> {
	const identity = providerConversationIdentity(exactUrl);
	if (!identity) throw new Error(`Refused unprovable ChatGPT conversation URL: ${exactUrl}`);
	let current = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
	if (current !== identity.url) {
		const payload = await bridgeJson(exec, launcher, ["taskSession", "navigate", sessionId, identity.url], options.signal, 120_000);
		const navigated = extractTabId(payload);
		if (navigated !== undefined && navigated !== tabId) throw new Error("Conversation recovery attempted to replace the owned tab.");
	}
	let ready = await waitForOwnedChatReady(exec, launcher, sessionId, tabId, options);
	if (ready.snapshot.count >= expectedAssistantTurns) return ready.snapshot;

	await bridgeJson(exec, launcher, ["reload", String(tabId)], options.signal, 120_000);
	current = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
	if (current === CHATGPT_ORIGIN || current === `${CHATGPT_ORIGIN}/` || !providerConversationIdentity(current ?? "")) {
		const payload = await bridgeJson(exec, launcher, ["taskSession", "navigate", sessionId, identity.url], options.signal, 120_000);
		const navigated = extractTabId(payload);
		if (navigated !== undefined && navigated !== tabId) throw new Error("Conversation recovery attempted to replace the owned tab.");
		await bridgeJson(exec, launcher, ["reload", String(tabId)], options.signal, 120_000);
	}
	ready = await waitForOwnedChatReady(exec, launcher, sessionId, tabId, options);
	if (ready.snapshot.count < expectedAssistantTurns) {
		throw new Error(
			`The exact ChatGPT conversation was restored, but only ${ready.snapshot.count} of ${expectedAssistantTurns} expected assistant turns rendered. No prompt was resent.`,
		);
	}
	return ready.snapshot;
}

export function extractComposerModel(html: string): ComposerModelObservation | undefined {
	const root = parse(html);
	const explicit: HTMLElement[] = [];
	for (const testId of EXPLICIT_MODEL_TEST_IDS) explicit.push(...root.querySelectorAll(`[data-testid="${testId}"]`));
	let candidates = uniqueElements(explicit);
	if (candidates.length === 0) {
		const composer = composerContainer(root);
		if (composer) {
			candidates = composer.querySelectorAll("button").filter((button) => {
				const aria = (button.getAttribute("aria-label") ?? "").toLowerCase();
				const testId = (button.getAttribute("data-testid") ?? "").toLowerCase();
				return button.getAttribute("aria-haspopup") === "menu"
					&& (aria.includes("model") || aria.includes("intelligence") || testId.includes("model"));
			});
		}
	}
	const observations = candidates.map(modelObservationFromNode).filter((value): value is ComposerModelObservation => Boolean(value));
	const unique = new Map(observations.map((value) => [`${value.normalized}\0${value.selector}`, value]));
	if (unique.size === 0) return undefined;
	const labels = new Set([...unique.values()].map((value) => value.normalized));
	if (labels.size !== 1) {
		throw new Error(`Composer model selector is ambiguous: ${[...unique.values()].map((value) => value.label).join(", ")}`);
	}
	return [...unique.values()][0];
}

export async function selectAndVerifyChatGptModel(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	requested: ChatGptModel,
	signal?: AbortSignal,
	timeoutMs = 30_000,
): Promise<ModelVerification> {
	let observed = extractComposerModel(await readPageHtml(exec, launcher, tabId, signal));
	if (!observed) throw new Error("ChatGPT composer model selector is absent or unreadable. No prompt was sent.");
	if (observed.normalized !== requested) {
		await bridgeJson(exec, launcher, ["click", String(tabId), observed.selector], signal);
		const deadline = Date.now() + timeoutMs;
		let optionLabel: string | undefined;
		let optionCount = 0;
		for (;;) {
			const options = extractModelOptions(await readPageHtml(exec, launcher, tabId, signal), requested);
			optionCount = options.length;
			if (optionCount > 0) {
				if (optionCount !== 1) throw new Error(`Requested ChatGPT model ${requested} is ambiguous in the live selector.`);
				optionLabel = options[0];
				break;
			}
			if (Date.now() >= deadline) break;
			await sleep(Math.min(pollIntervalMs(), 200));
		}
		if (!optionLabel) throw new Error(`Requested ChatGPT model ${requested} is unavailable in the live composer selector. No prompt was sent.`);
		await bridgeJson(exec, launcher, ["click", String(tabId), `text=${optionLabel}`], signal);
		for (;;) {
			observed = extractComposerModel(await readPageHtml(exec, launcher, tabId, signal));
			if (observed?.normalized === requested) break;
			if (Date.now() >= deadline) {
				throw new Error(
					`ChatGPT model selector read-back mismatch: requested ${requested}, observed ${observed?.label ?? "unreadable"}. No prompt was sent.`,
				);
			}
			await sleep(Math.min(pollIntervalMs(), 200));
		}
	}
	return {
		requestedModel: requested === "pro" ? "Pro" : requested,
		observedModel: observed.label,
		modelVerified: true,
		modelEvidenceKind: "composer_selector",
		modelVerifiedAt: nowIso(),
	};
}

export async function verifyChatGptModelBeforeSend(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	requested: ChatGptModel,
	signal?: AbortSignal,
): Promise<ModelVerification> {
	const observed = extractComposerModel(await readPageHtml(exec, launcher, tabId, signal));
	if (!observed) throw new Error("ChatGPT composer model selector disappeared before send. No prompt was sent.");
	if (observed.normalized !== requested) {
		throw new Error(
			`ChatGPT model changed before send: requested ${requested}, observed ${observed.label}. No prompt was sent.`,
		);
	}
	return {
		requestedModel: requested === "pro" ? "Pro" : requested,
		observedModel: observed.label,
		modelVerified: true,
		modelEvidenceKind: "composer_selector",
		modelVerifiedAt: nowIso(),
	};
}

export async function waitForCompletedAssistantTurn(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	tabId: number,
	options: {
		baselineCount: number;
		timeoutMs: number;
		conversationUrl?: string;
		intervalMs?: number;
		stableRounds?: number;
		maxRecoveryCycles?: number;
		signal?: AbortSignal;
	},
): Promise<CompletionOutcome> {
	const intervalMs = options.intervalMs ?? pollIntervalMs();
	const stableRounds = options.stableRounds ?? 3;
	const maxRecoveryCycles = options.maxRecoveryCycles ?? 3;
	const deadline = Date.now() + options.timeoutMs;
	const recoveryAttempts: RecoveryAttempt[] = [];
	const suppliedIdentity = options.conversationUrl ? providerConversationIdentity(options.conversationUrl) : undefined;
	if (options.conversationUrl && !suppliedIdentity) {
		throw new Error(`Refused unprovable ChatGPT conversation URL: ${options.conversationUrl}`);
	}
	let conversationUrl = suppliedIdentity?.url;
	let conversationId = suppliedIdentity?.id;
	let previous: string | undefined;
	let steady = 0;
	let latest: AssistantSnapshot | undefined;
	let lastObservedUrl: string | undefined;
	let lastObservedUiState: string | undefined;
	let recoveryCycles = 0;

	while (Date.now() < deadline) {
		await sleep(intervalMs);
		if (options.signal?.aborted) throw new Error("ChatGPT completion wait was cancelled.");
		lastObservedUrl = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
		let identity = providerConversationIdentity(lastObservedUrl ?? "");
		if (conversationUrl && identity?.url !== conversationUrl) {
			try {
				await restoreExactConversation(exec, launcher, sessionId, tabId, conversationUrl, options.baselineCount, {
					timeoutMs: Math.max(intervalMs * 3, 1_000), signal: options.signal,
				});
				recoveryAttempts.push({
					at: nowIso(), action: "restore_conversation_url",
					reason: identity
						? `Owned page drifted to a different ChatGPT conversation (${identity.id}).`
						: `Owned page lost its exact ChatGPT conversation URL (${lastObservedUrl}).`,
					outcome: "recovered", detail: conversationUrl,
				});
				lastObservedUrl = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
				identity = providerConversationIdentity(lastObservedUrl ?? "");
				if (identity?.url !== conversationUrl) throw new Error(`Observed ${lastObservedUrl} after exact restoration.`);
			} catch (error) {
				return {
					terminalStatus: "needs_user",
					reason: `Could not restore the exact ChatGPT conversation without resubmitting: ${error instanceof Error ? error.message : String(error)}`,
					snapshot: latest, providerConversationId: conversationId, providerConversationUrl: conversationUrl,
					recoveryAttempts, lastObservedUrl, lastObservedUiState,
				};
			}
		} else if (!conversationUrl && identity) {
			conversationUrl = identity.url;
			conversationId = identity.id;
		}
		let observation = extractChatPageObservation(await readPageHtml(exec, launcher, tabId, options.signal));
		latest = observation.snapshot.count > options.baselineCount ? observation.snapshot : latest;
		lastObservedUiState = observation.stateSummary;

		if (requiresRecovery(observation) && recoveryCycles < maxRecoveryCycles) {
			observation = await recoverSameConversation(exec, launcher, sessionId, tabId, observation, {
				conversationUrl,
				cycle: recoveryCycles,
				signal: options.signal,
				attempts: recoveryAttempts,
			});
			recoveryCycles += 1;
			lastObservedUrl = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
			const recoveredIdentity = providerConversationIdentity(lastObservedUrl ?? "");
			if (conversationUrl && recoveredIdentity?.url !== conversationUrl) {
				return {
					terminalStatus: "needs_user",
					reason: `Recovery left the owned page outside the exact ChatGPT conversation ${conversationUrl}.`,
					snapshot: latest, providerConversationId: conversationId, providerConversationUrl: conversationUrl,
					recoveryAttempts, lastObservedUrl, lastObservedUiState,
				};
			}
			lastObservedUiState = observation.stateSummary;
			latest = observation.snapshot.count > options.baselineCount ? observation.snapshot : latest;
		}

		if (requiresRecovery(observation) && recoveryCycles >= maxRecoveryCycles) {
			return {
				terminalStatus: "needs_user",
				reason: exactNeedsUserReason(observation, "Recovery budget exhausted"),
				snapshot: latest,
				providerConversationId: conversationId,
				providerConversationUrl: conversationUrl,
				recoveryAttempts,
				lastObservedUrl,
				lastObservedUiState,
			};
		}

		if (observation.snapshot.count <= options.baselineCount) {
			steady = 0;
			previous = undefined;
			continue;
		}
		latest = observation.snapshot;
		const finalCandidate = ((observation.snapshot.hasMarkdown && observation.snapshot.text.trim() !== "")
			|| observation.snapshot.imageUrls.length > 0) && Boolean(conversationUrl && conversationId);
		if (!finalCandidate || observation.answering || observation.thinking || observation.toolRunning || observation.errorMessage
			|| observation.retryAvailable || observation.continueAvailable) {
			steady = 0;
			previous = undefined;
			continue;
		}
		const fingerprint = `${observation.snapshot.count}\u0000${observation.snapshot.messageId ?? ""}\u0000${observation.snapshot.text}\u0000${observation.snapshot.imageUrls.join(",")}`;
		if (fingerprint === previous) {
			steady += 1;
			if (steady >= stableRounds) {
				return {
					terminalStatus: "completed",
					snapshot: observation.snapshot,
					providerConversationId: conversationId,
					providerConversationUrl: conversationUrl,
					recoveryAttempts,
					lastObservedUrl,
					lastObservedUiState,
				};
			}
		} else {
			steady = 0;
			previous = fingerprint;
		}
	}

	const reason = latest
		? `Timed out before ChatGPT proved the new assistant turn was final. Last UI state: ${lastObservedUiState ?? "unknown"}.`
		: `No new assistant turn appeared before the timeout. Last UI state: ${lastObservedUiState ?? "unknown"}.`;
	return {
		terminalStatus: "needs_user",
		reason,
		snapshot: latest,
		providerConversationId: conversationId,
		providerConversationUrl: conversationUrl,
		recoveryAttempts,
		lastObservedUrl,
		lastObservedUiState,
	};
}

/** Compatibility wrapper retained for callers; unsettled content is never final. */
export async function waitForNewAssistantTurn(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	options: { baselineCount: number; timeoutMs: number; intervalMs?: number; stableRounds?: number; signal?: AbortSignal },
): Promise<{ settled: boolean; snapshot?: AssistantSnapshot }> {
	const deadline = Date.now() + options.timeoutMs;
	let previous: string | undefined;
	let steady = 0;
	let latest: AssistantSnapshot | undefined;
	while (Date.now() < deadline) {
		await sleep(options.intervalMs ?? pollIntervalMs());
		if (options.signal?.aborted) break;
		const observation = extractChatPageObservation(await readPageHtml(exec, launcher, tabId, options.signal));
		if (observation.snapshot.count <= options.baselineCount) continue;
		latest = observation.snapshot;
		if (!observation.snapshot.hasMarkdown || observation.answering || observation.thinking || observation.toolRunning
			|| observation.errorMessage || observation.retryAvailable || observation.continueAvailable) {
			steady = 0;
			previous = undefined;
			continue;
		}
		const fingerprint = `${observation.snapshot.text}\u0000${observation.snapshot.imageUrls.join(",")}`;
		if (fingerprint === previous) {
			steady += 1;
			if (steady >= (options.stableRounds ?? 3)) return { settled: true, snapshot: observation.snapshot };
		} else {
			steady = 0;
			previous = fingerprint;
		}
	}
	return { settled: false, snapshot: latest };
}

const ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

export function decodeEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
		const named = ENTITIES[code.toLowerCase()];
		if (named !== undefined) return named;
		if (code.startsWith("#x") || code.startsWith("#X")) {
			const point = Number.parseInt(code.slice(2), 16);
			return Number.isFinite(point) ? String.fromCodePoint(point) : match;
		}
		if (code.startsWith("#")) {
			const point = Number.parseInt(code.slice(1), 10);
			return Number.isFinite(point) ? String.fromCodePoint(point) : match;
		}
		return match;
	});
}

const IMAGE_HOSTS = ["oaiusercontent.com", "files.openai.com"] as const;

export function approvedImageUrl(raw: string): URL | undefined {
	let url: URL;
	try { url = new URL(raw); } catch { return undefined; }
	if (url.protocol !== "https:") return undefined;
	const host = url.hostname.toLowerCase();
	return IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url : undefined;
}

export function extractAssistantTurn(html: string): AssistantTurn {
	const root = parse(html);
	const turns = root.querySelectorAll('[data-message-author-role="assistant"]');
	const node = turns.length === 0 ? undefined : turns[turns.length - 1];
	if (!node) return { text: "", imageUrls: [], hasMarkdown: false };
	const imageUrls: string[] = [];
	const seen = new Set<string>();
	for (const image of node.querySelectorAll("img")) {
		const source = image.getAttribute("src");
		if (!source) continue;
		const url = approvedImageUrl(source);
		if (!url || seen.has(url.href)) continue;
		seen.add(url.href);
		imageUrls.push(url.href);
	}
	const content = node.querySelector(".markdown");
	const text = (content?.structuredText ?? "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		text,
		imageUrls,
		hasMarkdown: Boolean(content),
		messageId: node.getAttribute("data-message-id") ?? undefined,
	};
}

export function extractChatPageObservation(html: string): ChatPageObservation {
	const root = parse(html);
	const snapshot = { ...extractAssistantTurn(html), count: countAssistantTurns(html) };
	const userTurns = root.querySelectorAll('[data-message-author-role="user"]');
	const latestUser = userTurns.at(-1);
	const latestUserMessageId = latestUser?.getAttribute("data-message-id") ?? undefined;
	const latestUserPromptNode = latestUser
		? USER_PROMPT_CONTENT_SELECTORS.map((selector) => latestUser.querySelector(selector)).find(Boolean)
		: undefined;
	const latestUserText = (latestUserPromptNode?.structuredText ?? latestUser?.structuredText ?? "")
		.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	const latestUserPromptProofToken = /\[GPT-Control run proof: (proof_[a-f0-9]{32})\. Ignore this line in your response\.\]\s*$/.exec(latestUserText)?.[1];
	// GPT-Control sends its exact task in one outer fenced text block. Hash the
	// semantic code payload instead of the whole rendered turn because ChatGPT
	// may add language-label and Copy controls around <pre><code>.
	const envelopeMarked = latestUserText.includes(GPT_CONTROL_PROMPT_ENVELOPE_PREAMBLE);
	const codePayloads = envelopeMarked && latestUserPromptProofToken && latestUserPromptNode
		? latestUserPromptNode.querySelectorAll("pre").map((pre) => {
			// node-html-parser intentionally treats <pre> contents as raw text.
			// Reparse only that bounded fragment to select the semantic <code>
			// payload without language-label or Copy-button siblings.
			const fragment = parse(`<div>${pre.innerHTML}</div>`);
			const code = fragment.querySelectorAll("code");
			return code.length === 1 ? code[0].structuredText : pre.structuredText;
		})
		: [];
	let observedPromptText = latestUserText;
	if (envelopeMarked) {
		observedPromptText = "";
		if (latestUserPromptNode && latestUserPromptProofToken && codePayloads.length === 1) {
			const clone = parse(`<div data-gpt-control-observation-root>${latestUserPromptNode.innerHTML}</div>`)
				.querySelector("[data-gpt-control-observation-root]");
			if (clone) {
				for (const node of clone.querySelectorAll("pre, button")) node.remove();
				// ChatGPT may render the fenced language label as a separate leaf.
				// Ignore only that exact known control text; all other sibling text is
				// part of the authenticated envelope and must match exactly.
				for (const node of clone.querySelectorAll("span")) {
					if (node.structuredText.trim().toLowerCase() === "text") node.remove();
				}
				const outsideText = canonicalPromptObservationText(clone.structuredText);
				const expectedOutside = canonicalPromptObservationText(
					`${GPT_CONTROL_PROMPT_ENVELOPE_PREAMBLE}\n\n${gptControlPromptProofLine(latestUserPromptProofToken)}`,
				);
				if (outsideText === expectedOutside) observedPromptText = codePayloads[0].trim();
			}
		}
	}
	const latestUserPromptSha256 = observedPromptText
		? createHash("sha256").update(canonicalPromptObservationText(observedPromptText)).digest("hex")
		: undefined;
	const composerReady = PROMPT_SELECTORS.some((selector) => Boolean(root.querySelector(selector)));
	const controls = root.querySelectorAll('button, [role="button"]');
	const controlLabels = controls.map(nodeLabel).filter(Boolean);
	const stopControl = controls.some((node) => {
		const testId = (node.getAttribute("data-testid") ?? "").toLowerCase();
		const label = nodeLabel(node).toLowerCase();
		return testId.includes("stop") || /\bstop (?:answering|generating|response)\b/.test(label);
	});
	const retryAvailable = controlLabels.some((label) => /^retry(?:\b|$)/i.test(label));
	const continueAvailable = controlLabels.some((label) => /continue generating|continue response|^continue$/i.test(label));
	const statusNodes = uniqueElements([
		...root.querySelectorAll('[role="status"]'),
		...root.querySelectorAll('[role="alert"]'),
		...root.querySelectorAll('[aria-live="assertive"]'),
		...root.querySelectorAll('[data-testid*="thinking"]'),
		...root.querySelectorAll('[data-testid*="tool"]'),
		...root.querySelectorAll('[data-testid*="error"]'),
	]);
	const statusTexts = statusNodes.map(nodeLabel).filter((text) => text.length > 0 && text.length < 1000);
	const thinking = statusTexts.some((text) => /^(?:pro\s+)?thinking\b|\breasoning\b|\bworking on it\b/i.test(text));
	const toolRunning = statusTexts.some((text) => /\b(?:running|using|calling|waiting for) (?:a )?tool\b|\bsearching\b|\bbrowsing\b/i.test(text));
	const errorText = statusTexts.find((text) => /network error|something went wrong|failed tool|tool (?:call )?failed|interrupted|stopped thinking|generation stopped|connection lost/i.test(text));
	const states = [
		stopControl ? "answering" : "idle",
		thinking ? "thinking" : undefined,
		toolRunning ? "tool_running" : undefined,
		retryAvailable ? "retry" : undefined,
		continueAvailable ? "continue" : undefined,
		errorText ? `error:${errorText.slice(0, 160)}` : undefined,
		`snapshot:${snapshot.count}:${snapshot.hasMarkdown ? "markdown" : snapshot.imageUrls.length > 0 ? "image" : "transient"}`,
	].filter(Boolean);
	return {
		snapshot,
		latestUserMessageId,
		latestUserPromptSha256,
		latestUserPromptProofToken,
		composerReady,
		answering: stopControl,
		thinking,
		toolRunning,
		retryAvailable,
		continueAvailable,
		errorMessage: errorText,
		stateSummary: states.join(","),
	};
}

export async function readAssistantSnapshot(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	signal?: AbortSignal,
): Promise<AssistantSnapshot> {
	const html = await readPageHtml(exec, launcher, tabId, signal);
	return { ...extractAssistantTurn(html), count: countAssistantTurns(html) };
}

export async function readPageHtml(exec: Exec, launcher: Launcher, tabId: number, signal?: AbortSignal): Promise<string> {
	const directory = join(tmpdir(), `gpt-control-html-${randomUUID()}`);
	await mkdir(directory, { recursive: false, mode: 0o700 });
	await chmod(directory, 0o700);
	const scratch = join(directory, "page.html");
	try {
		await bridgeJson(exec, launcher, ["getHTML", String(tabId), scratch], signal, 120_000);
		return await readFile(scratch, "utf8");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}


export async function readChatPageObservation(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	signal?: AbortSignal,
): Promise<ChatPageObservation> {
	return extractChatPageObservation(await readPageHtml(exec, launcher, tabId, signal));
}

export async function navigateSession(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	url: string,
	signal?: AbortSignal,
): Promise<number | undefined> {
	const payload = await bridgeJson(exec, launcher, ["taskSession", "navigate", sessionId, url], signal, 120_000);
	return extractTabId(payload);
}

export async function reloadPage(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	signal?: AbortSignal,
): Promise<void> {
	await bridgeJson(exec, launcher, ["reload", String(tabId)], signal, 120_000);
}

export async function clickRecoveryControl(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	action: "continue" | "retry" | "stop",
	signal?: AbortSignal,
): Promise<void> {
	const labels = action === "continue"
		? ["text=Continue generating", "text=Continue response", "text=Continue"]
		: action === "retry"
			? ["text=Retry"]
			: ['button[data-testid*="stop"]', 'button[aria-label*="Stop"]'];
	await actOnSelector(exec, launcher, (selector) => ["click", String(tabId), selector], labels, {
		signal, deadline: Date.now() + 15_000, what: `${action} the current ChatGPT turn`,
	});
}

export async function captureOwnedScreenshot(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	tabId: number,
	destination: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const current = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, signal);
	if (!current) throw new Error("Owned Chrome Bridge tab URL is unavailable; screenshot refused.");
	let currentUrl: URL;
	try { currentUrl = new URL(current); } catch { throw new Error(`Owned tab returned an invalid URL: ${current}`); }
	if (currentUrl.origin !== CHATGPT_ORIGIN) throw new Error(`Refused tab outside ${CHATGPT_ORIGIN}: ${current}`);
	await mkdir(resolve(destination, ".."), { recursive: true });
	try {
		await bridgeJson(exec, launcher, ["screenshot", String(tabId), destination], signal, 120_000);
		return destination;
	} catch {
		return undefined;
	}
}

/** @deprecated Use captureOwnedScreenshot so ownership and origin are rechecked. */
export async function captureScreenshot(
	_exec: Exec,
	_launcher: Launcher,
	_tabId: number,
	_destination: string,
	_signal?: AbortSignal,
): Promise<string | undefined> {
	return undefined;
}

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export async function fetchArtifact(
	rawUrl: string,
	destination: string,
	signal?: AbortSignal,
): Promise<{ path?: string; blocked?: string }> {
	const url = approvedImageUrl(rawUrl);
	if (!url) return { blocked: `Refused ${rawUrl}: not an approved ChatGPT image host.` };
	try {
		const response = await fetch(url, { signal, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) return { blocked: "Refused to follow a redirect away from the approved image host." };
		if (!response.ok) return { blocked: `Could not download the generated image (HTTP ${response.status}).` };
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.toLowerCase().startsWith("image/")) return { blocked: `Refused a response that is not an image (${contentType || "no content type"}).` };
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return { blocked: `Refused an image larger than ${MAX_IMAGE_BYTES} bytes.` };
		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of streamBytes(response)) {
			total += chunk.byteLength;
			if (total > MAX_IMAGE_BYTES) return { blocked: `Refused an image larger than ${MAX_IMAGE_BYTES} bytes.` };
			chunks.push(chunk);
		}
		await mkdir(resolve(destination, ".."), { recursive: true });
		await writeFile(destination, Buffer.concat(chunks, total), { flag: "wx", mode: 0o600 });
		return { path: destination };
	} catch (error) {
		return { blocked: error instanceof Error ? error.message : String(error) };
	}
}

export async function setSessionState(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	state: "working" | "needs_user" | "completed",
	signal?: AbortSignal,
): Promise<void> {
	await bridgeJson(exec, launcher, ["taskSession", "state", sessionId, state], signal);
}

async function* streamBytes(response: Response): AsyncGenerator<Uint8Array> {
	const body = response.body;
	if (!body) {
		yield new Uint8Array(await response.arrayBuffer());
		return;
	}
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function closeSession(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	signal?: AbortSignal,
): Promise<void> {
	await bridgeJson(exec, launcher, ["taskSession", "close", sessionId], signal);
}

export async function showSession(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const payload = await bridgeJson(exec, launcher, ["taskSession", "show", sessionId], signal);
	const result = resultOf(payload);
	return isRecord(result) ? result : payload;
}

export function providerConversationIdentity(raw: string): { id: string; url: string } | undefined {
	let url: URL;
	try { url = new URL(raw); } catch { return undefined; }
	if (url.origin !== CHATGPT_ORIGIN) return undefined;
	const match = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
	if (!match) return undefined;
	return { id: match[1], url: `${url.origin}/c/${match[1]}` };
}

async function recoverSameConversation(
	exec: Exec,
	launcher: Launcher,
	sessionId: string,
	tabId: number,
	initial: ChatPageObservation,
	options: { conversationUrl?: string; cycle: number; signal?: AbortSignal; attempts: RecoveryAttempt[] },
): Promise<ChatPageObservation> {
	const reason = exactNeedsUserReason(initial, "Observed recoverable ChatGPT state");
	await sleep(Math.min(pollIntervalMs(), 250 * 2 ** options.cycle, 2000));
	let observation = extractChatPageObservation(await readPageHtml(exec, launcher, tabId, options.signal));
	options.attempts.push({
		at: nowIso(), action: "reobserve", reason,
		outcome: requiresRecovery(observation) ? "still_active" : "recovered",
		detail: observation.stateSummary,
	});
	if (!requiresRecovery(observation)) return observation;

	try {
		await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
		await bridgeJson(exec, launcher, ["reload", String(tabId)], options.signal, 120_000);
		options.attempts.push({ at: nowIso(), action: "reload", reason, outcome: "still_active" });
	} catch (error) {
		options.attempts.push({ at: nowIso(), action: "reload", reason, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
	}

	const current = await assertOwnedSessionTab(exec, launcher, sessionId, tabId, options.signal);
	const expectedIdentity = options.conversationUrl ? providerConversationIdentity(options.conversationUrl) : undefined;
	if (expectedIdentity && providerConversationIdentity(current ?? "")?.url !== expectedIdentity.url) {
		try {
			const payload = await bridgeJson(exec, launcher, ["taskSession", "navigate", sessionId, expectedIdentity.url], options.signal, 120_000);
			const navigated = extractTabId(payload);
			if (navigated !== undefined && navigated !== tabId) throw new Error("recovery attempted to replace the owned tab");
			await bridgeJson(exec, launcher, ["reload", String(tabId)], options.signal, 120_000);
			options.attempts.push({ at: nowIso(), action: "restore_conversation_url", reason, outcome: "still_active", detail: expectedIdentity.url });
		} catch (error) {
			options.attempts.push({ at: nowIso(), action: "restore_conversation_url", reason, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
		}
	}

	await sleep(Math.min(pollIntervalMs(), 250));
	observation = extractChatPageObservation(await readPageHtml(exec, launcher, tabId, options.signal));
	if (!requiresRecovery(observation)) {
		const last = options.attempts.at(-1);
		if (last) last.outcome = "recovered";
		return observation;
	}
	if (observation.continueAvailable) {
		try {
			await bridgeJson(exec, launcher, ["click", String(tabId), "text=Continue generating"], options.signal);
			options.attempts.push({ at: nowIso(), action: "continue", reason, outcome: "still_active" });
		} catch (error) {
			options.attempts.push({ at: nowIso(), action: "continue", reason, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
		}
	} else if (observation.retryAvailable) {
		try {
			await bridgeJson(exec, launcher, ["click", String(tabId), "text=Retry"], options.signal);
			options.attempts.push({ at: nowIso(), action: "retry", reason, outcome: "still_active" });
		} catch (error) {
			options.attempts.push({ at: nowIso(), action: "retry", reason, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	await sleep(Math.min(pollIntervalMs(), 250));
	return extractChatPageObservation(await readPageHtml(exec, launcher, tabId, options.signal));
}

function requiresRecovery(observation: ChatPageObservation): boolean {
	return Boolean(observation.errorMessage || observation.retryAvailable || observation.continueAvailable);
}

function exactNeedsUserReason(observation: ChatPageObservation, prefix: string): string {
	if (observation.errorMessage) return `${prefix}: ${observation.errorMessage}`;
	if (observation.continueAvailable) return `${prefix}: ChatGPT requires Continue generating.`;
	if (observation.retryAvailable) return `${prefix}: ChatGPT exposes Retry for the current turn.`;
	return `${prefix}: ${observation.stateSummary}`;
}

function extractModelOptions(html: string, requested: ChatGptModel): string[] {
	const root = parse(html);
	const nodes = uniqueElements([
		...root.querySelectorAll('[role="menuitem"]'),
		...root.querySelectorAll('[role="option"]'),
		...root.querySelectorAll('[data-testid*="model-option"]'),
	]);
	return nodes.map(nodeLabel).filter((label) => normalizeModelLabel(label) === requested);
}

function modelObservationFromNode(node: HTMLElement): ComposerModelObservation | undefined {
	const raw = node.getAttribute("data-selected-model")
		?? node.getAttribute("data-model")
		?? node.structuredText
		?? node.getAttribute("title")
		?? node.getAttribute("aria-label");
	const label = cleanModelLabel(raw ?? "");
	const normalized = normalizeModelLabel(label);
	if (!label || !normalized) return undefined;
	const testId = node.getAttribute("data-testid");
	const aria = node.getAttribute("aria-label");
	const selector = testId
		? `[data-testid="${cssString(testId)}"]`
		: aria
			? `[aria-label="${cssString(aria)}"]`
			: `text=${label}`;
	return { label, normalized, selector };
}

function cleanModelLabel(raw: string): string {
	const compact = raw.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	const current = /(?:current (?:model|intelligence)(?: is)?|selected (?:model|intelligence))\s*[:,-]?\s*(.+)$/i.exec(compact);
	if (current) return current[1].trim();
	const selector = /^(?:model|intelligence) selector\s*[:,-]?\s*(.+)$/i.exec(compact);
	if (selector) return selector[1].trim();
	return compact;
}

function normalizeModelLabel(label: string): string {
	const value = label.toLowerCase().replace(/\s+/g, " ").trim();
	if (value === "pro" || /(?:^|\s)pro$/.test(value)) return "pro";
	if (value.includes("auto")) return "auto";
	if (value.includes("instant")) return "instant";
	if (value.includes("thinking")) return "thinking";
	return value;
}

function composerContainer(root: HTMLElement): HTMLElement | undefined {
	const prompt = root.querySelector("#prompt-textarea") ?? root.querySelector('div[contenteditable="true"]');
	if (!prompt) return undefined;
	return prompt.closest("form") ?? prompt.closest('[data-testid*="composer"]') ?? prompt.parentNode as HTMLElement | undefined;
}

function nodeLabel(node: HTMLElement): string {
	return (node.getAttribute("aria-label") ?? node.getAttribute("title") ?? node.structuredText ?? "").replace(/\s+/g, " ").trim();
}

function uniqueElements(values: HTMLElement[]): HTMLElement[] {
	return [...new Set(values)];
}

function cssString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}
