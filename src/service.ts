import { createHash } from "node:crypto";
import { type DriverSession, type WebChatDriver, waitForNewDriverSnapshot } from "./browser-driver";
import { describeCapabilities, resetCapabilityCache, resolveCapabilities, selectRoute, type TransportChoice } from "./capability";
import { CHATGPT_ORIGIN } from "./chatgpt";
import {
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
import { buildReviewPrompt, parseReviewReport } from "./review";
import { RunStore } from "./store";
import type { Exec } from "./types";

const activeRuns = new Map<string, AbortController>();
const TERMINAL = new Set(["completed", "failed", "cancelled", "needs_user"]);

interface ProviderTurnResult {
	provider: Provider;
	text: string;
	providerConversationId?: string;
	providerRunId?: string;
	model?: string;
	transportVersion?: string;
	imageUrls?: string[];
}

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
			if (TERMINAL.has(run.status) || Date.now() >= deadline) return run;
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
		if (conversation.provider === "browser") {
			const capabilities = await resolveCapabilities(this.exec);
			const driver = this.requireMatchingDriver(conversation, capabilities.browser?.driver);
			const session = await this.assertOwnedBrowserConversation(conversation, driver);
			await driver.close(session.sessionId);
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
		if (route.kind === "browser") {
			const driver = required(route.driver, "browser driver");
			const session = await driver.create(`gpt-control:${request.kind}:${conversation.id}`, CHATGPT_ORIGIN);
			conversation.browserDriverId = driver.id;
			conversation.browserSessionId = session.sessionId;
			conversation.browserPageId = session.pageId;
			conversation.providerConversationId = session.sessionId;
		}
		await this.store.putConversation(conversation);
		return conversation;
	}

	private async resumeConversation(id: string, transport?: TransportChoice): Promise<ConversationRecord> {
		const conversation = await this.store.getConversation(id);
		if (conversation.closedAt) throw new Error(`Conversation ${id} is closed.`);
		if (transport && transport !== conversation.provider) throw new Error(`Conversation ${id} uses ${conversation.provider}; it cannot be resumed through ${transport}.`);
		if (conversation.provider === "oracle_browser" || conversation.provider === "oracle_api") throw new Error("Oracle fallback is one-shot only. Omit conversation_id or use the browser transport.");
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
			await this.store.updateConversation(conversation.id, { providerConversationId: result.providerConversationId ?? conversation.providerConversationId });
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
			resetCapabilityCache();
			return this.store.updateRun(run.id, {
				status: signal.aborted ? "cancelled" : "failed",
				error: error instanceof Error ? error.message : String(error),
				completedAt: nowIso(),
			});
		}
	}

	private async executeProvider(conversation: ConversationRecord, run: RunRecord, request: StartRequest, prompt: string, signal: AbortSignal): Promise<ProviderTurnResult> {
		const capabilities = await resolveCapabilities(this.exec);
		if (conversation.provider === "browser") {
			const driver = this.requireMatchingDriver(conversation, capabilities.browser?.driver);
			return this.runBrowserTurn(conversation, run, prompt, driver, signal, request.timeoutMs ?? 10 * 60_000);
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

	private async runBrowserTurn(conversation: ConversationRecord, run: RunRecord, prompt: string, driver: WebChatDriver, signal: AbortSignal, timeoutMs: number): Promise<ProviderTurnResult> {
		const session = await this.assertOwnedBrowserConversation(conversation, driver);
		const baseline = await driver.snapshot(session, signal);
		await this.store.updateRun(run.id, { baselineMessageCount: baseline.count });
		await driver.upload(session, run.attachmentManifest.files.map((file) => file.path), signal);
		await driver.submit(session, prompt, signal);
		const next = await waitForNewDriverSnapshot(driver, session, { baselineCount: baseline.count, timeoutMs, signal });
		if (!next.snapshot) {
			await driver.setState(session.sessionId, "needs_user", signal).catch(() => undefined);
			throw new Error("No new assistant turn appeared before the timeout. Inspect the run later; the previous answer was not returned.");
		}
		await driver.setState(session.sessionId, next.settled ? "completed" : "needs_user", signal).catch(() => undefined);
		return {
			provider: "browser",
			text: next.snapshot.text,
			providerConversationId: session.sessionId,
			providerRunId: `assistant_turn_${next.snapshot.count}`,
			transportVersion: driver.id,
			imageUrls: next.snapshot.imageUrls,
		};
	}

	private requireMatchingDriver(conversation: ConversationRecord, driver?: WebChatDriver): WebChatDriver {
		if (!driver) throw new Error("The recorded browser driver is unavailable. No fallback browser was launched.");
		if (driver.id !== conversation.browserDriverId) throw new Error(`Conversation ${conversation.id} belongs to browser driver ${conversation.browserDriverId}, not ${driver.id}.`);
		return driver;
	}

	private async assertOwnedBrowserConversation(conversation: ConversationRecord, driver: WebChatDriver): Promise<DriverSession> {
		const sessionId = required(conversation.browserSessionId, "browser session id");
		const session = await driver.show(sessionId);
		if (!session.name.startsWith("gpt-control:")) throw new Error(`Refused foreign browser session ${sessionId}.`);
		if (session.pageId !== conversation.browserPageId) throw new Error(`Browser session ${sessionId} no longer owns the recorded page.`);
		if (new URL(session.url).origin !== CHATGPT_ORIGIN) throw new Error(`Refused page outside ${CHATGPT_ORIGIN}.`);
		return session;
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`Missing ${name}.`);
	return value;
}
