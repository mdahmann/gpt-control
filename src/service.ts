import { createHash } from "node:crypto";
import {
	describeCapabilities,
	resetCapabilityCache,
	resolveCapabilities,
	selectRoute,
	type Route,
	type TransportChoice,
} from "./capability";
import {
	CHATGPT_ORIGIN,
	attachFiles,
	closeSession,
	createSession,
	openChat,
	readAssistantSnapshot,
	setSessionState,
	showSession,
	submitPrompt,
	tabIdFromSession,
	tabUrl,
	waitForNewAssistantTurn,
} from "./chatgpt";
import {
	PACKAGE_VERSION,
	STORAGE_VERSION,
	nowIso,
	opaqueId,
	type AttachmentManifest,
	type ConversationRecord,
	type Provider,
	type ReviewReceipt,
	type RunKind,
	type RunRecord,
} from "./domain";
import { buildAttachmentManifest } from "./files";
import { runOracle } from "./oracle";
import { runCodexTurn, runResponsesTurn, type ProviderTurnResult } from "./providers";
import { buildReviewPrompt, parseReviewReport } from "./review";
import { RunStore } from "./store";
import type { Exec } from "./types";

const activeRuns = new Map<string, AbortController>();
const TERMINAL = new Set(["completed", "failed", "cancelled", "needs_user"]);

export interface StartRequest {
	kind: RunKind;
	prompt: string;
	files?: string[];
	conversationId?: string;
	transport?: TransportChoice;
	model?: string;
	workspaceRoot?: string;
	allowOutsideWorkspace?: boolean;
	allowSensitiveFiles?: boolean;
	apiConfirmed?: boolean;
	allowFocusSteal?: boolean;
	wait?: boolean;
	timeoutMs?: number;
}

export interface StartResult {
	conversation: ConversationRecord;
	run: RunRecord;
}

export class GptControlService {
	readonly store: RunStore;
	private readonly exec: Exec;

	constructor(exec: Exec, store = new RunStore()) {
		this.exec = exec;
		this.store = store;
	}

	async start(request: StartRequest): Promise<StartResult> {
		if (request.prompt.trim() === "") throw new Error("prompt is required");
		await this.store.init();
		const manifest = await buildAttachmentManifest(request.files ?? [], {
			workspaceRoot: request.workspaceRoot,
			allowOutsideWorkspace: request.allowOutsideWorkspace,
			allowSensitiveFiles: request.allowSensitiveFiles,
		});
		const conversation = request.conversationId
			? await this.resumeConversation(request.conversationId, request.transport)
			: await this.createConversation(request, manifest);
		const run = await this.createRun(request, conversation, manifest);
		const controller = new AbortController();
		activeRuns.set(run.id, controller);
		const work = this.store.withConversationLock(conversation.id, async () => {
			try {
				return await this.executeRun(run.id, request, controller.signal);
			} finally {
				activeRuns.delete(run.id);
			}
		});
		if (request.wait === false) {
			void work.catch(() => undefined);
			return { conversation, run };
		}
		return { conversation: await this.store.getConversation(conversation.id), run: await work };
	}

	async getRun(runId: string): Promise<RunRecord> {
		return this.store.getRun(runId);
	}

	async waitForRun(runId: string, timeoutMs = 10 * 60_000): Promise<RunRecord> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const run = await this.store.getRun(runId);
			if (TERMINAL.has(run.status)) return run;
			if (Date.now() >= deadline) return run;
			await new Promise((done) => setTimeout(done, 200));
		}
	}

	async cancelRun(runId: string): Promise<RunRecord> {
		const run = await this.store.getRun(runId);
		if (TERMINAL.has(run.status)) return run;
		activeRuns.get(runId)?.abort();
		return this.store.updateRun(runId, { status: "cancelled", completedAt: nowIso(), error: "Cancelled by caller." });
	}

	async closeConversation(conversationId: string): Promise<ConversationRecord> {
		const conversation = await this.store.getConversation(conversationId);
		if (conversation.provider === "chrome_bridge") {
			const capabilities = await resolveCapabilities(this.exec);
			if (!capabilities.bridge) throw new Error("Chrome Bridge is unavailable; the conversation tabs were not closed.");
			await this.assertOwnedBrowserConversation(conversation, capabilities.bridge.launcher);
			await closeSession(this.exec, capabilities.bridge.launcher, required(conversation.bridgeSessionId, "bridge session id"));
		}
		return this.store.updateConversation(conversationId, { closedAt: nowIso() });
	}

	async diagnose(): Promise<Record<string, unknown>> {
		return describeCapabilities(await resolveCapabilities(this.exec));
	}

	private async createConversation(request: StartRequest, manifest: AttachmentManifest): Promise<ConversationRecord> {
		const capabilities = await resolveCapabilities(this.exec);
		const route = selectRoute(capabilities, {
			transport: request.transport,
			apiConfirmed: request.apiConfirmed,
			allowFocusSteal: request.allowFocusSteal,
		});
		const timestamp = nowIso();
		const conversation: ConversationRecord = {
			version: STORAGE_VERSION,
			id: opaqueId("conv"),
			provider: route.kind,
			workspaceRoot: manifest.workspaceRoot,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (route.kind === "chrome_bridge") {
			const launcher = required(route.launcher, "Chrome Bridge launcher");
			const sessionId = await createSession(this.exec, launcher, `gpt-control:${request.kind}:${conversation.id}`);
			const tabId = await openChat(this.exec, launcher, sessionId, CHATGPT_ORIGIN);
			conversation.bridgeSessionId = sessionId;
			conversation.bridgeTabId = tabId;
			conversation.providerConversationId = sessionId;
		}
		await this.store.putConversation(conversation);
		return conversation;
	}

	private async resumeConversation(id: string, transport?: TransportChoice): Promise<ConversationRecord> {
		const conversation = await this.store.getConversation(id);
		if (conversation.closedAt) throw new Error(`Conversation ${id} is closed.`);
		if (transport && transport !== conversation.provider) {
			throw new Error(`Conversation ${id} uses ${conversation.provider}; it cannot be resumed through ${transport}.`);
		}
		if (conversation.provider === "oracle_browser" || conversation.provider === "oracle_api") {
			throw new Error("Oracle fallback is one-shot only. Omit conversation_id or choose an official transport.");
		}
		return conversation;
	}

	private async createRun(request: StartRequest, conversation: ConversationRecord, manifest: AttachmentManifest): Promise<RunRecord> {
		const timestamp = nowIso();
		const id = opaqueId("run");
		const prompt = request.kind === "consult" ? buildReviewPrompt(request.prompt, manifest) : request.prompt;
		const promptSha256 = sha256(prompt);
		const receipt: ReviewReceipt = {
			provider: conversation.provider,
			model: request.model,
			promptSha256,
			attachments: manifest.files,
			startedAt: timestamp,
			conversationId: conversation.id,
			runId: id,
			providerConversationId: conversation.providerConversationId,
		};
		const run: RunRecord = {
			version: STORAGE_VERSION,
			id,
			conversationId: conversation.id,
			kind: request.kind,
			status: "queued",
			promptSha256,
			attachmentManifest: manifest,
			receipt,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.store.putRun(run);
		return run;
	}

	private async executeRun(runId: string, request: StartRequest, signal: AbortSignal): Promise<RunRecord> {
		let run = await this.store.updateRun(runId, { status: "running" });
		const conversation = await this.store.getConversation(run.conversationId);
		const prompt = request.kind === "consult" ? buildReviewPrompt(request.prompt, run.attachmentManifest) : request.prompt;
		try {
			const result = await this.executeProvider(conversation, run, request, prompt, signal);
			const completedAt = nowIso();
			const report = request.kind === "consult" ? parseReviewReport(result.text) : undefined;
			const resultSha256 = sha256(result.text);
			await this.store.updateConversation(conversation.id, {
				providerConversationId: result.providerConversationId ?? conversation.providerConversationId,
			});
			run = await this.store.updateRun(run.id, {
				status: "completed",
				providerRunId: result.providerRunId,
				resultText: result.text,
				result: report,
				artifactUrls: result.imageUrls,
				completedAt,
				receipt: {
					...run.receipt,
					model: result.model ?? run.receipt.model,
					transportVersion: result.transportVersion,
					providerConversationId: result.providerConversationId,
					providerRunId: result.providerRunId,
					resultSha256,
					completedAt,
				},
			});
			return run;
		} catch (error) {
			const cancelled = signal.aborted;
			resetCapabilityCache();
			return this.store.updateRun(run.id, {
				status: cancelled ? "cancelled" : "failed",
				error: error instanceof Error ? error.message : String(error),
				completedAt: nowIso(),
			});
		}
	}

	private async executeProvider(
		conversation: ConversationRecord,
		run: RunRecord,
		request: StartRequest,
		prompt: string,
		signal: AbortSignal,
	): Promise<ProviderTurnResult> {
		if (conversation.provider === "codex") {
			return runCodexTurn({ kind: run.kind, prompt, manifest: run.attachmentManifest, providerConversationId: conversation.providerConversationId, model: request.model, signal });
		}
		if (conversation.provider === "responses") {
			return runResponsesTurn({ kind: run.kind, prompt, manifest: run.attachmentManifest, providerConversationId: conversation.providerConversationId, model: request.model, signal });
		}
		const capabilities = await resolveCapabilities(this.exec);
		if (conversation.provider === "chrome_bridge") {
			const bridge = capabilities.bridge;
			if (!bridge) throw new Error("Chrome Bridge became unavailable. No foreground fallback was launched.");
			return this.runBrowserTurn(conversation, run, prompt, bridge.launcher, signal, request.timeoutMs ?? 10 * 60_000);
		}
		const oracle = capabilities.oracle;
		if (!oracle) throw new Error("Oracle CLI became unavailable.");
		const response = await runOracle(this.exec, oracle.launcher, {
			prompt,
			files: run.attachmentManifest.files.map((file) => file.path),
			model: request.model,
			engine: conversation.provider === "oracle_api" ? "api" : "browser",
			timeoutMs: request.timeoutMs,
			signal,
		});
		return { provider: conversation.provider, text: response.text, model: request.model, transportVersion: oracle.version };
	}

	private async runBrowserTurn(
		conversation: ConversationRecord,
		run: RunRecord,
		prompt: string,
		launcher: NonNullable<Route["launcher"]>,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<ProviderTurnResult> {
		const owned = await this.assertOwnedBrowserConversation(conversation, launcher);
		const baseline = await readAssistantSnapshot(this.exec, launcher, owned.tabId, signal);
		await this.store.updateRun(run.id, { baselineMessageCount: baseline.count });
		await attachFiles(this.exec, launcher, owned.tabId, run.attachmentManifest.files.map((file) => file.path), signal);
		await submitPrompt(this.exec, launcher, owned.tabId, prompt, signal);
		const next = await waitForNewAssistantTurn(this.exec, launcher, owned.tabId, { baselineCount: baseline.count, timeoutMs, signal });
		if (!next.snapshot) {
			await setSessionState(this.exec, launcher, owned.sessionId, "needs_user", signal).catch(() => undefined);
			throw new Error("No new assistant turn appeared before the timeout. Inspect the run later; the previous answer was not returned.");
		}
		await setSessionState(this.exec, launcher, owned.sessionId, next.settled ? "completed" : "needs_user", signal).catch(() => undefined);
		return {
			provider: "chrome_bridge",
			text: next.snapshot.text,
			providerConversationId: owned.sessionId,
			providerRunId: `assistant_turn_${next.snapshot.count}`,
			transportVersion: "chrome-bridge",
			imageUrls: next.snapshot.imageUrls,
		};
	}

	private async assertOwnedBrowserConversation(conversation: ConversationRecord, launcher: NonNullable<Route["launcher"]>): Promise<{ sessionId: string; tabId: number }> {
		const sessionId = required(conversation.bridgeSessionId, "bridge session id");
		const session = await showSession(this.exec, launcher, sessionId);
		const name = typeof session.name === "string" ? session.name : "";
		if (!name.startsWith("gpt-control:")) throw new Error(`Refused foreign Chrome Bridge session ${sessionId}.`);
		const tabId = tabIdFromSession(session);
		if (tabId === undefined || tabId !== conversation.bridgeTabId) throw new Error(`Chrome Bridge session ${sessionId} no longer owns the recorded tab.`);
		const current = await tabUrl(this.exec, launcher, tabId);
		if (!current || new URL(current).origin !== CHATGPT_ORIGIN) throw new Error(`Refused tab outside ${CHATGPT_ORIGIN}.`);
		return { sessionId, tabId };
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`Missing ${name}.`);
	return value;
}
