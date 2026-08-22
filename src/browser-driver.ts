import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	CHATGPT_ORIGIN,
	attachFiles,
	captureOwnedScreenshot,
	clickRecoveryControl,
	clickSend,
	closeSession,
	createSession,
	fillPrompt,
	navigateSession,
	providerConversationIdentity,
	readChatPageObservation,
	reloadPage,
	discoverChatGptModels,
	discoverChatGptProjects,
	dismissChatGptRateLimitNotice,
	manageChatGptConversation,
	selectAndVerifyChatGptModel,
	setSessionState,
	showSession,
	tabIdFromSession,
	tabUrl,
	verifyChatGptModelBeforeSend,
	openChat,
	probeExpectedTargetEnforcement,
	type ExactBrowserActionTarget,
	type AssistantSnapshot,
	type ChatPageObservation,
	type ChatGptModelCatalog,
	type ChatGptProjectCatalog,
	type ChatGptConversationAction,
	type ChatGptConversationActionResult,
	type ChatGptSelection,
	type ModelVerification,
} from "./chatgpt";
import { nowIso, type ChatGptModel, type RecoveryAttempt } from "./domain";
import { probeBridge, resolveBridgeLauncher, splitCommandLine, type Launcher } from "./transport";
import type { Exec } from "./types";

export const BROWSER_DRIVER_PROTOCOL_VERSION = 2;
export type DriverPageId = string | number;
export type DriverSessionState = "working" | "needs_user" | "completed";
export type DriverRecoveryAction = "reload" | "continue" | "retry" | "stop";

export interface DriverProbe {
	ready: boolean;
	driver: string;
	secureInput: boolean;
	protocolVersion: typeof BROWSER_DRIVER_PROTOCOL_VERSION;
	reason?: string;
}

export interface DriverSession {
	sessionId: string;
	pageId: DriverPageId;
	name: string;
	url: string;
}

export interface WebChatDriver {
	readonly id: string;
	probe(signal?: AbortSignal): Promise<DriverProbe>;
	create(name: string, url: string, signal?: AbortSignal): Promise<DriverSession>;
	show(sessionId: string, signal?: AbortSignal): Promise<DriverSession>;
	navigate(session: DriverSession, url: string, signal?: AbortSignal): Promise<DriverSession>;
	upload(session: DriverSession, files: readonly string[], signal?: AbortSignal): Promise<void>;
	fill(session: DriverSession, prompt: string, signal?: AbortSignal): Promise<void>;
	discoverModels(session: DriverSession, signal?: AbortSignal): Promise<ChatGptModelCatalog>;
	discoverProjects(session: DriverSession, signal?: AbortSignal): Promise<ChatGptProjectCatalog>;
	manageConversation(session: DriverSession, action: ChatGptConversationAction, signal?: AbortSignal): Promise<ChatGptConversationActionResult>;
	selectModel(session: DriverSession, selection: ChatGptSelection | ChatGptModel, signal?: AbortSignal): Promise<ModelVerification>;
	verifyModel(session: DriverSession, selection: ChatGptSelection | ChatGptModel, signal?: AbortSignal): Promise<ModelVerification>;
	send(session: DriverSession, signal?: AbortSignal): Promise<void>;
	observe(session: DriverSession, signal?: AbortSignal): Promise<ChatPageObservation>;
	dismissRateLimitNotice?(session: DriverSession, signal?: AbortSignal): Promise<string | undefined>;
	recover(session: DriverSession, action: DriverRecoveryAction, signal?: AbortSignal): Promise<void>;
	setState(sessionId: string, state: DriverSessionState, signal?: AbortSignal): Promise<void>;
	close(sessionId: string, signal?: AbortSignal): Promise<void>;
	screenshot(session: DriverSession, outputPath: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface DriverCompletionOutcome {
	terminalStatus: "completed" | "needs_user";
	reason?: string;
	snapshot?: AssistantSnapshot;
	providerConversationId?: string;
	providerConversationUrl?: string;
	recoveryAttempts: RecoveryAttempt[];
	lastObservedUrl?: string;
	lastObservedUiState?: string;
}

export interface ExpectedDriverSession {
	sessionId: string;
	pageId: DriverPageId;
	name: string;
}

export async function assertExactDriverSession(
	driver: WebChatDriver,
	expected: ExpectedDriverSession,
	signal?: AbortSignal,
): Promise<DriverSession> {
	const current = await driver.show(expected.sessionId, signal);
	if (current.sessionId !== expected.sessionId) throw new Error("Browser driver returned a different session id.");
	if (String(current.pageId) !== String(expected.pageId)) {
		throw new Error(`Browser session ${expected.sessionId} no longer owns the recorded page.`);
	}
	if (current.name !== expected.name) {
		throw new Error(`Refused renamed or foreign browser session ${expected.sessionId}.`);
	}
	assertChatGptUrl(current.url, true);
	return current;
}

export async function waitForDriverReady(
	driver: WebChatDriver,
	expected: ExpectedDriverSession,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ session: DriverSession; observation: ChatPageObservation }> {
	const deadline = Date.now() + (options.timeoutMs ?? 60_000);
	let last = "the driver did not expose a ready composer";
	for (let attempt = 0; Date.now() < deadline; attempt += 1) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Browser readiness wait was cancelled.");
		try {
			const session = await assertExactDriverSession(driver, expected, options.signal);
			if (isTransientUrl(session.url)) {
				last = `owned page is still committing (${session.url})`;
			} else {
				const observation = await driver.observe(session, options.signal);
				if (observation.composerReady) return { session, observation };
				last = `ChatGPT loaded at ${session.url}, but its composer is not ready (${observation.stateSummary})`;
			}
		} catch (error) {
			const message = errorMessage(error);
			if (!isTransientDriverError(message)) throw error;
			last = message;
		}
		await abortableSleep(Math.min(browserPollIntervalMs(), 250 * 2 ** attempt, 2_000), options.signal);
	}
	throw new Error(`The owned ChatGPT page did not become ready before the bounded timeout. Last observation: ${last}. No prompt was sent.`);
}

export async function waitForCompletedDriverTurn(
	driver: WebChatDriver,
	expected: ExpectedDriverSession,
	options: {
		baselineCount: number;
		timeoutMs: number;
		conversationUrl?: string;
		intervalMs?: number;
		stableRounds?: number;
		maxRecoveryCycles?: number;
		signal?: AbortSignal;
		onConversationIdentity?: (identity: { id: string; url: string }) => Promise<void>;
		onConversationObservation?: (
			identity: { id: string; url: string },
			observation: ChatPageObservation,
		) => Promise<"approved" | "unavailable" | "mismatch">;
		providerTurnIdentityPersisted?: boolean;
		onRateLimit?: (message: string) => Promise<void>;
	},
): Promise<DriverCompletionOutcome> {
	const intervalMs = options.intervalMs ?? browserPollIntervalMs();
	const stableRounds = options.stableRounds ?? 3;
	const maxRecoveryCycles = options.maxRecoveryCycles ?? 3;
	const deadline = Date.now() + options.timeoutMs;
	const recoveryAttempts: RecoveryAttempt[] = [];
	const suppliedIdentity = options.conversationUrl ? providerConversationIdentity(options.conversationUrl) : undefined;
	if (options.conversationUrl && !suppliedIdentity) {
		throw new Error(`Refused unprovable ChatGPT conversation URL: ${options.conversationUrl}`);
	}
	let exactUrl = suppliedIdentity?.url;
	let conversationId = suppliedIdentity?.id;
	let identityPersisted = options.onConversationObservation
		? options.providerTurnIdentityPersisted === true
		: Boolean(suppliedIdentity);
	let previous: string | undefined;
	let steady = 0;
	let latest: AssistantSnapshot | undefined;
	let lastObservedUrl: string | undefined;
	let lastObservedUiState: string | undefined;
	let recoveryCycles = 0;
	const validateObservedTurn = async (
		session: DriverSession,
		observation: ChatPageObservation,
	): Promise<"approved" | "pending" | "drifted"> => {
		if (!options.onConversationObservation) return "approved";
		const observedIdentity = providerConversationIdentity(session.url);
		if (!observedIdentity) return identityPersisted ? "drifted" : "pending";
		const decision = await options.onConversationObservation(observedIdentity, observation);
		if (decision === "mismatch") return "drifted";
		if (decision === "unavailable") return "pending";
		if (exactUrl && exactUrl !== observedIdentity.url) return "drifted";
		exactUrl = observedIdentity.url;
		conversationId = observedIdentity.id;
		identityPersisted = true;
		return "approved";
	};

	while (Date.now() < deadline) {
		await abortableSleep(intervalMs, options.signal);
		let session = await assertExactDriverSession(driver, expected, options.signal);
		lastObservedUrl = session.url;
		const currentIdentity = providerConversationIdentity(session.url);

		if (exactUrl) {
			if (!currentIdentity || currentIdentity.url !== exactUrl) {
				const restored = await restoreExactDriverConversation(driver, expected, session, exactUrl, options.baselineCount, options.signal);
				recoveryAttempts.push({
					at: nowIso(), action: "restore_conversation_url",
					reason: currentIdentity
						? `Owned page drifted to a different ChatGPT conversation (${currentIdentity.id}).`
						: `Owned page lost its exact ChatGPT conversation URL (${session.url}).`,
					outcome: restored.ok ? "recovered" : "failed",
					detail: restored.detail,
				});
				if (!restored.ok) {
					return needsUser(restored.detail, latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState);
				}
				session = restored.session;
				lastObservedUrl = session.url;
			}
		} else if (currentIdentity && !options.onConversationObservation) {
			exactUrl = currentIdentity.url;
			conversationId = currentIdentity.id;
			if (!identityPersisted && !options.onConversationIdentity) identityPersisted = true;
			if (!identityPersisted && options.onConversationIdentity) {
				try {
					await options.onConversationIdentity(currentIdentity);
					identityPersisted = true;
				} catch (error) {
					return needsUser(
						`The exact provider conversation was discovered but could not be durably recorded: ${errorMessage(error)}`,
						latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState,
					);
				}
			}
		}

		let observation = await driver.observe(session, options.signal);
		if (observation.rateLimited) {
			const message = observation.rateLimitMessage ?? "ChatGPT reported too many requests.";
			await options.onRateLimit?.(message);
			if (!driver.dismissRateLimitNotice) {
				return needsUser(
					`ChatGPT is temporarily rate limited and this browser driver cannot dismiss the notice safely: ${message}`,
					latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, observation.stateSummary,
				);
			}
			try {
				await driver.dismissRateLimitNotice(session, options.signal);
				recoveryAttempts.push({
					at: nowIso(), action: "dismiss_rate_limit", reason: message, outcome: "recovered",
				});
			} catch (error) {
				recoveryAttempts.push({
					at: nowIso(), action: "dismiss_rate_limit", reason: message, outcome: "failed", detail: errorMessage(error),
				});
				return needsUser(
					`ChatGPT rate-limit notice could not be dismissed safely: ${errorMessage(error)}`,
					latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, observation.stateSummary,
				);
			}
			previous = undefined;
			steady = 0;
			continue;
		}
		let providerTurnIdentityPending = false;
		lastObservedUiState = observation.stateSummary;
		if (observation.snapshot.count > options.baselineCount) latest = observation.snapshot;
		try {
			const validation = await validateObservedTurn(session, observation);
			if (validation === "drifted") {
				return needsUser(
					"The latest provider user turn changed after the submitted turn was identified. Completion was not attributed to this run.",
					latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState,
				);
			}
			providerTurnIdentityPending = validation === "pending";
		} catch (error) {
			return needsUser(
				`The observed provider turn identity could not be durably recorded: ${errorMessage(error)}`,
				latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState,
			);
		}

		if (requiresRecovery(observation) && recoveryCycles < maxRecoveryCycles) {
			const recovered = await recoverSameDriverConversation(driver, expected, session, observation, {
				exactUrl,
				baselineCount: options.baselineCount,
				cycle: recoveryCycles,
				signal: options.signal,
				attempts: recoveryAttempts,
			});
			recoveryCycles += 1;
			if (!recovered.ok) {
				return needsUser(recovered.reason, latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState);
			}
			session = recovered.session;
			observation = recovered.observation;
			lastObservedUrl = session.url;
			lastObservedUiState = observation.stateSummary;
			if (observation.snapshot.count > options.baselineCount) latest = observation.snapshot;
			try {
				const validation = await validateObservedTurn(session, observation);
				if (validation === "drifted") {
					return needsUser(
						"The latest provider user turn changed during recovery. Completion was not attributed to this run.",
						latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState,
					);
				}
				providerTurnIdentityPending = validation === "pending";
			} catch (error) {
				return needsUser(
					`The recovered provider turn identity could not be durably validated: ${errorMessage(error)}`,
					latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState,
				);
			}
		}

		if (requiresRecovery(observation) && recoveryCycles >= maxRecoveryCycles) {
			return needsUser(
				exactNeedsUserReason(observation, "Recovery budget exhausted"),
				latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState,
			);
		}
		if (providerTurnIdentityPending) {
			steady = 0;
			previous = undefined;
			continue;
		}
		if (observation.snapshot.count <= options.baselineCount) {
			steady = 0;
			previous = undefined;
			continue;
		}
		latest = observation.snapshot;
		const finalCandidate = ((observation.snapshot.hasMarkdown && observation.snapshot.text.trim() !== "")
			|| observation.snapshot.imageUrls.length > 0)
			&& Boolean(exactUrl && conversationId && identityPersisted);
		if (!finalCandidate || observation.answering || observation.thinking || observation.toolRunning
			|| observation.errorMessage || observation.retryAvailable || observation.continueAvailable) {
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
					providerConversationUrl: exactUrl,
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
		? `Timed out before the exact ChatGPT conversation proved the new assistant turn was final. Last UI state: ${lastObservedUiState ?? "unknown"}.`
		: `No new assistant turn appeared before the timeout. Last UI state: ${lastObservedUiState ?? "unknown"}.`;
	return needsUser(reason, latest, conversationId, exactUrl, recoveryAttempts, lastObservedUrl, lastObservedUiState);
}

async function restoreExactDriverConversation(
	driver: WebChatDriver,
	expected: ExpectedDriverSession,
	session: DriverSession,
	exactUrl: string,
	baselineCount: number,
	signal?: AbortSignal,
): Promise<{ ok: true; session: DriverSession; detail: string } | { ok: false; detail: string }> {
	try {
		const navigated = await driver.navigate(session, exactUrl, signal);
		if (String(navigated.pageId) !== String(expected.pageId) || navigated.sessionId !== expected.sessionId || navigated.name !== expected.name) {
			return { ok: false, detail: "Exact-conversation recovery attempted to replace or rename the owned page." };
		}
		const restored = await assertExactDriverSession(driver, expected, signal);
		const identity = providerConversationIdentity(restored.url);
		if (!identity || identity.url !== exactUrl) return { ok: false, detail: `Driver did not restore ${exactUrl}; observed ${restored.url}.` };
		const observation = await driver.observe(restored, signal);
		if (observation.snapshot.count < baselineCount) {
			return { ok: false, detail: `The exact conversation rendered ${observation.snapshot.count} assistant turns, below the durable baseline ${baselineCount}. No prompt was resent.` };
		}
		return { ok: true, session: restored, detail: exactUrl };
	} catch (error) {
		return { ok: false, detail: `Could not restore the exact conversation without creating a new page: ${errorMessage(error)}` };
	}
}

async function recoverSameDriverConversation(
	driver: WebChatDriver,
	expected: ExpectedDriverSession,
	session: DriverSession,
	initial: ChatPageObservation,
	options: {
		exactUrl?: string;
		baselineCount: number;
		cycle: number;
		signal?: AbortSignal;
		attempts: RecoveryAttempt[];
	},
): Promise<{ ok: true; session: DriverSession; observation: ChatPageObservation } | { ok: false; reason: string }> {
	const reason = exactNeedsUserReason(initial, "Observed recoverable ChatGPT state");
	await abortableSleep(Math.min(browserPollIntervalMs(), 250 * 2 ** options.cycle, 2_000), options.signal);
	let observation = await driver.observe(session, options.signal);
	options.attempts.push({
		at: nowIso(), action: "reobserve", reason,
		outcome: requiresRecovery(observation) ? "still_active" : "recovered",
		detail: observation.stateSummary,
	});
	if (!requiresRecovery(observation)) return { ok: true, session, observation };

	try {
		await driver.recover(session, "reload", options.signal);
		options.attempts.push({ at: nowIso(), action: "reload", reason, outcome: "still_active" });
	} catch (error) {
		options.attempts.push({ at: nowIso(), action: "reload", reason, outcome: "failed", detail: errorMessage(error) });
	}

	let current: DriverSession;
	try {
		current = await assertExactDriverSession(driver, expected, options.signal);
	} catch (error) {
		return { ok: false, reason: `Owned browser identity was lost during recovery: ${errorMessage(error)}` };
	}
	if (options.exactUrl) {
		const identity = providerConversationIdentity(current.url);
		if (!identity || identity.url !== options.exactUrl) {
			const restored = await restoreExactDriverConversation(driver, expected, current, options.exactUrl, options.baselineCount, options.signal);
			options.attempts.push({
				at: nowIso(), action: "restore_conversation_url", reason,
				outcome: restored.ok ? "recovered" : "failed",
				detail: restored.detail,
			});
			if (!restored.ok) return { ok: false, reason: restored.detail };
			current = restored.session;
		}
	}

	await abortableSleep(Math.min(browserPollIntervalMs(), 250), options.signal);
	observation = await driver.observe(current, options.signal);
	if (!requiresRecovery(observation)) {
		const last = options.attempts.at(-1);
		if (last) last.outcome = "recovered";
		return { ok: true, session: current, observation };
	}
	if (observation.retryAvailable) {
		return {
			ok: false,
			reason: `${exactNeedsUserReason(observation, "Provider retry requires operator review")} Automatic Retry is disabled because the prior turn may already have caused external side effects.`,
		};
	}

	const action: DriverRecoveryAction | undefined = observation.continueAvailable ? "continue" : undefined;
	if (action) {
		try {
			await driver.recover(current, action, options.signal);
			options.attempts.push({ at: nowIso(), action, reason, outcome: "still_active" });
		} catch (error) {
			options.attempts.push({ at: nowIso(), action, reason, outcome: "failed", detail: errorMessage(error) });
		}
	}
	await abortableSleep(Math.min(browserPollIntervalMs(), 250), options.signal);
	observation = await driver.observe(current, options.signal);
	return { ok: true, session: current, observation };
}

function needsUser(
	reason: string,
	snapshot: AssistantSnapshot | undefined,
	providerConversationId: string | undefined,
	providerConversationUrl: string | undefined,
	recoveryAttempts: RecoveryAttempt[],
	lastObservedUrl?: string,
	lastObservedUiState?: string,
): DriverCompletionOutcome {
	return {
		terminalStatus: "needs_user",
		reason,
		snapshot,
		providerConversationId,
		providerConversationUrl,
		recoveryAttempts,
		lastObservedUrl,
		lastObservedUiState,
	};
}

function requiresRecovery(observation: ChatPageObservation): boolean {
	return Boolean(observation.rateLimited || observation.errorMessage || observation.retryAvailable || observation.continueAvailable);
}

function exactNeedsUserReason(observation: ChatPageObservation, prefix: string): string {
	if (observation.rateLimitMessage) return `${prefix}: ChatGPT is temporarily rate limited: ${observation.rateLimitMessage}`;
	if (observation.errorMessage) return `${prefix}: ${observation.errorMessage}`;
	if (observation.continueAvailable) return `${prefix}: ChatGPT requires Continue generating.`;
	if (observation.retryAvailable) return `${prefix}: ChatGPT exposes Retry for the current turn.`;
	return `${prefix}: ${observation.stateSummary}`;
}

export function browserPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.GPT_CONTROL_POLL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
}

export interface ResolvedBrowserDriver {
	driver?: WebChatDriver;
	probe: DriverProbe;
	source: string;
}

export async function resolveBrowserDriver(
	exec: Exec,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<ResolvedBrowserDriver> {
	const external = env.GPT_CONTROL_BROWSER_DRIVER?.trim();
	if (external) {
		const parts = splitCommandLine(external);
		if (parts.length === 0) {
			return { probe: offlineProbe("external", "GPT_CONTROL_BROWSER_DRIVER is empty"), source: "GPT_CONTROL_BROWSER_DRIVER" };
		}
		const driver = new ExternalCommandBrowserDriver(parts[0], parts.slice(1));
		const probe = await driver.probe(signal).catch((error): DriverProbe => offlineProbe(driver.id, errorMessage(error)));
		return { driver: probe.ready && probe.secureInput ? driver : undefined, probe, source: "GPT_CONTROL_BROWSER_DRIVER" };
	}
	const launcher = resolveBridgeLauncher(env);
	if (launcher) {
		const driver = new ChromeBridgeBrowserDriver(exec, launcher);
		const probe = await driver.probe(signal).catch((error): DriverProbe => offlineProbe(driver.id, errorMessage(error)));
		return { driver: probe.ready && probe.secureInput ? driver : undefined, probe, source: launcher.origin };
	}
	return {
		probe: offlineProbe("none", "No browser driver configured. Set GPT_CONTROL_BROWSER_DRIVER or install an adapter such as Chrome Bridge."),
		source: "none",
	};
}

export class ChromeBridgeBrowserDriver implements WebChatDriver {
	readonly id = "chrome-bridge/private-rpc-v2";
	constructor(private readonly exec: Exec, private readonly launcher: Launcher) {}

	private async assertActionTarget(session: DriverSession, signal?: AbortSignal): Promise<DriverSession> {
		const current = await this.show(session.sessionId, signal);
		if (String(current.pageId) !== String(session.pageId)) {
			throw new Error(`Browser session ${session.sessionId} no longer owns the recorded page; action refused.`);
		}
		if (current.name !== session.name) {
			throw new Error(`Refused action on renamed or foreign browser session ${session.sessionId}.`);
		}
		assertChatGptUrl(current.url, true);
		if (canonicalActionUrl(current.url) !== canonicalActionUrl(session.url)) {
			throw new Error(`Owned browser page drifted from ${session.url} to ${current.url}; action refused.`);
		}
		return current;
	}

	async probe(signal?: AbortSignal): Promise<DriverProbe> {
		const result = await probeBridge(this.exec, this.launcher, signal);
		const secureInput = Boolean(this.launcher.privateRpc);
		const exactTargetEnforced = secureInput && result.ready
			? await probeExpectedTargetEnforcement(this.exec, this.launcher, signal)
			: false;
		return {
			ready: result.ready && secureInput && exactTargetEnforced,
			driver: this.id,
			secureInput,
			protocolVersion: BROWSER_DRIVER_PROTOCOL_VERSION,
			reason: !secureInput
				? "Chrome Bridge is reachable, but its private request-file RPC adapter is unavailable; prompt submission is disabled."
				: !exactTargetEnforced
					? "Chrome Bridge is reachable, but exact expectedTarget enforcement is unavailable; browser mutation is disabled."
				: result.reason,
		};
	}

	async create(name: string, url: string, signal?: AbortSignal): Promise<DriverSession> {
		const sessionId = await createSession(this.exec, this.launcher, name, signal);
		const pageId = await openChat(this.exec, this.launcher, sessionId, url, signal);
		const created = await this.show(sessionId, signal);
		if (created.name !== name || String(created.pageId) !== String(pageId)) {
			await closeSession(this.exec, this.launcher, sessionId, signal).catch(() => undefined);
			throw new Error("Chrome Bridge did not preserve the newly-created exact session/page identity.");
		}
		return created;
	}

	async show(sessionId: string, signal?: AbortSignal): Promise<DriverSession> {
		const session = await showSession(this.exec, this.launcher, sessionId, signal);
		const pageId = tabIdFromSession(session);
		if (pageId === undefined) throw new Error(`Browser session ${sessionId} owns no page.`);
		const url = await tabUrl(this.exec, this.launcher, pageId, signal);
		return { sessionId, pageId, name: typeof session.name === "string" ? session.name : "", url: url ?? "" };
	}

	async navigate(session: DriverSession, url: string, signal?: AbortSignal): Promise<DriverSession> {
		assertChatGptUrl(url, false);
		const pageId = await navigateSession(this.exec, this.launcher, session.sessionId, url, signal);
		if (pageId !== undefined && String(pageId) !== String(session.pageId)) {
			throw new Error("Chrome Bridge navigation attempted to replace the owned page.");
		}
		return this.show(session.sessionId, signal);
	}

	async upload(session: DriverSession, files: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.assertActionTarget(session, signal);
		await attachFiles(this.exec, this.launcher, numericPageId(session.pageId), files, signal, exactActionTarget(session));
	}

	async fill(session: DriverSession, prompt: string, signal?: AbortSignal): Promise<void> {
		await this.assertActionTarget(session, signal);
		await fillPrompt(this.exec, this.launcher, numericPageId(session.pageId), prompt, signal, 60_000, exactActionTarget(session));
	}

	async discoverModels(session: DriverSession, signal?: AbortSignal): Promise<ChatGptModelCatalog> {
		await this.assertActionTarget(session, signal);
		return discoverChatGptModels(this.exec, this.launcher, numericPageId(session.pageId), signal, 30_000, exactActionTarget(session));
	}

	async discoverProjects(session: DriverSession, signal?: AbortSignal): Promise<ChatGptProjectCatalog> {
		await this.assertActionTarget(session, signal);
		return discoverChatGptProjects(this.exec, this.launcher, numericPageId(session.pageId), signal);
	}

	async manageConversation(session: DriverSession, action: ChatGptConversationAction, signal?: AbortSignal): Promise<ChatGptConversationActionResult> {
		await this.assertActionTarget(session, signal);
		return manageChatGptConversation(this.exec, this.launcher, numericPageId(session.pageId), action, signal, 30_000, exactActionTarget(session));
	}

	async selectModel(session: DriverSession, model: ChatGptSelection | ChatGptModel, signal?: AbortSignal): Promise<ModelVerification> {
		await this.assertActionTarget(session, signal);
		return selectAndVerifyChatGptModel(this.exec, this.launcher, numericPageId(session.pageId), model, signal, 30_000, exactActionTarget(session));
	}

	async verifyModel(session: DriverSession, model: ChatGptSelection | ChatGptModel, signal?: AbortSignal): Promise<ModelVerification> {
		await this.assertActionTarget(session, signal);
		return verifyChatGptModelBeforeSend(this.exec, this.launcher, numericPageId(session.pageId), model, signal, exactActionTarget(session));
	}

	async send(session: DriverSession, signal?: AbortSignal): Promise<void> {
		await this.assertActionTarget(session, signal);
		await clickSend(this.exec, this.launcher, numericPageId(session.pageId), signal, exactActionTarget(session));
	}

	async observe(session: DriverSession, signal?: AbortSignal): Promise<ChatPageObservation> {
		return readChatPageObservation(this.exec, this.launcher, numericPageId(session.pageId), signal);
	}

	async dismissRateLimitNotice(session: DriverSession, signal?: AbortSignal): Promise<string | undefined> {
		await this.assertActionTarget(session, signal);
		return dismissChatGptRateLimitNotice(
			this.exec, this.launcher, numericPageId(session.pageId), signal, exactActionTarget(session),
		);
	}

	async recover(session: DriverSession, action: DriverRecoveryAction, signal?: AbortSignal): Promise<void> {
		await this.assertActionTarget(session, signal);
		const pageId = numericPageId(session.pageId);
		const target = exactActionTarget(session);
		if (action === "reload") return reloadPage(this.exec, this.launcher, pageId, signal, target);
		return clickRecoveryControl(this.exec, this.launcher, pageId, action, signal, target);
	}

	async setState(sessionId: string, state: DriverSessionState, signal?: AbortSignal): Promise<void> {
		await setSessionState(this.exec, this.launcher, sessionId, state, signal);
	}

	async close(sessionId: string, signal?: AbortSignal): Promise<void> {
		await closeSession(this.exec, this.launcher, sessionId, signal);
	}

	async screenshot(session: DriverSession, outputPath: string, signal?: AbortSignal): Promise<string | undefined> {
		await this.assertActionTarget(session, signal);
		return captureOwnedScreenshot(this.exec, this.launcher, session.sessionId, numericPageId(session.pageId), outputPath, signal, exactActionTarget(session));
	}
}

function canonicalActionUrl(raw: string): string {
	return new URL(raw).toString();
}

function exactActionTarget(session: DriverSession): ExactBrowserActionTarget {
	return {
		sessionId: session.sessionId,
		tabId: numericPageId(session.pageId),
		name: session.name,
		url: canonicalActionUrl(session.url),
	};
}

const DriverIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const SessionSchema = z.object({
	sessionId: z.string().min(1),
	pageId: z.union([z.string(), z.number()]),
	name: z.string(),
	url: z.string(),
}).strict();
const SnapshotSchema = z.object({
	count: z.number().int().nonnegative(),
	text: z.string(),
	imageUrls: z.array(z.string()),
	hasMarkdown: z.boolean(),
	messageId: z.string().optional(),
}).strict();
const ObservationSchema = z.object({
	snapshot: SnapshotSchema,
	latestUserMessageId: z.string().min(1).optional(),
	latestUserPromptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	latestUserPromptProofToken: z.string().regex(/^proof_[a-f0-9]{32}$/).optional(),
	composerReady: z.boolean(),
	answering: z.boolean(),
	thinking: z.boolean(),
	toolRunning: z.boolean(),
	visibleToolCards: z.array(z.object({
		label: z.string().min(1).max(256),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	}).strict()).default([]),
	retryAvailable: z.boolean(),
	continueAvailable: z.boolean(),
	rateLimited: z.boolean().default(false),
	rateLimitMessage: z.string().optional(),
	errorMessage: z.string().optional(),
	stateSummary: z.string(),
}).strict();
const ModelVerificationSchema = z.object({
	requestedModel: z.string().min(1),
	observedModel: z.string().min(1),
	requestedEffort: z.string().min(1).optional(),
	observedEffort: z.string().min(1).optional(),
	modelVerified: z.literal(true),
	modelEvidenceKind: z.literal("composer_selector"),
	modelVerifiedAt: z.string().min(1),
}).strict();
const CatalogOptionSchema = z.object({ label: z.string().min(1), note: z.string().min(1).optional() }).strict();
const ModelCatalogSchema = z.object({
	currentModel: z.string().min(1).optional(),
	currentEffort: z.string().min(1).optional(),
	models: z.array(CatalogOptionSchema),
	efforts: z.array(CatalogOptionSchema),
	discoveredAt: z.string().min(1),
}).strict();
const ProjectCatalogSchema = z.object({
	projects: z.array(z.object({ name: z.string().min(1) }).strict()),
	discoveredAt: z.string().min(1),
}).strict();
const ConversationActionResultSchema = z.object({
	pinned: z.boolean().optional(),
	archived: z.boolean().optional(),
	title: z.string().min(1).optional(),
	project: z.string().min(1).optional(),
	verifiedAt: z.string().min(1),
}).strict();
const ProbeSchema = z.object({
	ready: z.boolean(),
	driver: DriverIdSchema,
	secureInput: z.boolean(),
	protocolVersion: z.literal(BROWSER_DRIVER_PROTOCOL_VERSION),
	reason: z.string().optional(),
}).strict();
const EnvelopeSchema = z.object({
	version: z.literal(BROWSER_DRIVER_PROTOCOL_VERSION),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
}).strict();

export class ExternalCommandBrowserDriver implements WebChatDriver {
	private readonly command: string;
	private readonly args: string[];
	private readonly fallbackId: string;
	private resolvedId?: string;

	constructor(command: string, args: string[] = []) {
		this.command = command;
		this.args = [...args];
		this.fallbackId = `external-command/${createHash("sha256").update(JSON.stringify([command, args])).digest("hex").slice(0, 16)}`;
	}

	get id(): string {
		return this.resolvedId ?? this.fallbackId;
	}

	async probe(signal?: AbortSignal): Promise<DriverProbe> {
		const result = ProbeSchema.parse(await this.call("probe", {}, signal));
		if (this.resolvedId && result.driver !== this.resolvedId) {
			throw new Error(`Browser driver identity changed from ${this.resolvedId} to ${result.driver}.`);
		}
		this.resolvedId = result.driver;
		if (result.ready && !result.secureInput) {
			return { ...result, ready: false, reason: result.reason ?? "Protocol-v2 driver did not attest secure stdin input." };
		}
		return result;
	}

	async create(name: string, url: string, signal?: AbortSignal): Promise<DriverSession> {
		return SessionSchema.parse(await this.call("create", { name, url }, signal));
	}

	async show(sessionId: string, signal?: AbortSignal): Promise<DriverSession> {
		return SessionSchema.parse(await this.call("show", { sessionId }, signal));
	}

	async navigate(session: DriverSession, url: string, signal?: AbortSignal): Promise<DriverSession> {
		return SessionSchema.parse(await this.call("navigate", { session, url }, signal));
	}

	async upload(session: DriverSession, files: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.call("upload", { session, files }, signal);
	}

	async fill(session: DriverSession, prompt: string, signal?: AbortSignal): Promise<void> {
		await this.call("fill", { session, prompt }, signal);
	}

	async discoverModels(session: DriverSession, signal?: AbortSignal): Promise<ChatGptModelCatalog> {
		return ModelCatalogSchema.parse(await this.call("discover_models", { session }, signal));
	}

	async discoverProjects(session: DriverSession, signal?: AbortSignal): Promise<ChatGptProjectCatalog> {
		return ProjectCatalogSchema.parse(await this.call("discover_projects", { session }, signal));
	}

	async manageConversation(session: DriverSession, action: ChatGptConversationAction, signal?: AbortSignal): Promise<ChatGptConversationActionResult> {
		return ConversationActionResultSchema.parse(await this.call("manage_conversation", { session, operation: action }, signal));
	}

	async selectModel(session: DriverSession, model: ChatGptSelection | ChatGptModel, signal?: AbortSignal): Promise<ModelVerification> {
		return ModelVerificationSchema.parse(await this.call("select_model", { session, model }, signal));
	}

	async verifyModel(session: DriverSession, model: ChatGptSelection | ChatGptModel, signal?: AbortSignal): Promise<ModelVerification> {
		return ModelVerificationSchema.parse(await this.call("verify_model", { session, model }, signal));
	}

	async send(session: DriverSession, signal?: AbortSignal): Promise<void> {
		await this.call("send", { session }, signal);
	}

	async observe(session: DriverSession, signal?: AbortSignal): Promise<ChatPageObservation> {
		return ObservationSchema.parse(await this.call("observe", { session }, signal));
	}

	async recover(session: DriverSession, action: DriverRecoveryAction, signal?: AbortSignal): Promise<void> {
		await this.call("recover", { session, action }, signal);
	}

	async setState(sessionId: string, state: DriverSessionState, signal?: AbortSignal): Promise<void> {
		await this.call("set_state", { sessionId, state }, signal);
	}

	async close(sessionId: string, signal?: AbortSignal): Promise<void> {
		await this.call("close", { sessionId }, signal);
	}

	async screenshot(session: DriverSession, outputPath: string, signal?: AbortSignal): Promise<string | undefined> {
		const result = await this.call("screenshot", { session, outputPath }, signal);
		return typeof result === "string" ? result : undefined;
	}

	private async call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const request = JSON.stringify({ version: BROWSER_DRIVER_PROTOCOL_VERSION, action, params });
		const response = await invokeJsonCommand(this.command, this.args, request, signal);
		const envelope = EnvelopeSchema.parse(response);
		if (!envelope.ok) throw new Error(envelope.error ?? `Browser driver ${action} failed.`);
		return envelope.result;
	}
}

async function invokeJsonCommand(
	command: string,
	args: string[],
	request: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const limit = 16 * 1024 * 1024;
	if (Buffer.byteLength(request, "utf8") > limit) throw new Error("Browser driver request exceeded 16 MiB.");
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (work: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			work();
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["pipe", "pipe", "pipe"],
				signal,
				env: sanitizedDriverEnv(process.env),
			});
		} catch (error) {
			reject(error);
			return;
		}
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error("Browser driver command exceeded its 180-second bound.")));
		}, 180_000);
		timer.unref();
		child.stdout!.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > limit) child.kill("SIGKILL");
			else stdout.push(chunk);
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= limit) stderr.push(chunk);
		});
		child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") finish(() => reject(error));
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => finish(() => {
			if (stdoutBytes > limit) return reject(new Error("Browser driver response exceeded 16 MiB."));
			const output = Buffer.concat(stdout).toString("utf8").trim();
			if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Browser driver exited ${code}.`));
			if (output === "") return reject(new Error("Browser driver returned no JSON."));
			try {
				resolve(JSON.parse(output));
			} catch {
				reject(new Error(`Browser driver returned invalid JSON: ${output.slice(0, 400)}`));
			}
		}));
		child.stdin!.end(`${request}\n`);
	});
}

function sanitizedDriverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const safe = new Set(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
	const output: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (safe.has(key) || key.startsWith("GPT_CONTROL_DRIVER_") || key.startsWith("CHROME_BRIDGE_")) output[key] = value;
	}
	return output;
}

function offlineProbe(driver: string, reason: string): DriverProbe {
	return { ready: false, driver, secureInput: false, protocolVersion: BROWSER_DRIVER_PROTOCOL_VERSION, reason };
}

function numericPageId(value: DriverPageId): number {
	if (typeof value !== "number") throw new Error(`Chrome Bridge requires a numeric page id, received ${value}.`);
	return value;
}

function assertChatGptUrl(raw: string, allowTransient: boolean): void {
	if (allowTransient && isTransientUrl(raw)) return;
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error(`Owned page returned an invalid URL: ${raw}`); }
	if (url.origin !== CHATGPT_ORIGIN) throw new Error(`Refused browser page outside ${CHATGPT_ORIGIN}: ${raw}`);
}

function isTransientUrl(raw: string): boolean {
	return raw === "" || raw === "about:blank" || raw === "chrome://newtab" || raw === "chrome://newtab/";
}

function isTransientDriverError(message: string): boolean {
	return /not ready|still committing|composer is not ready|detached|no such (?:tab|page)|target closed|url unavailable/i.test(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Operation was cancelled."));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Operation was cancelled."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
