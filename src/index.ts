import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve, sep } from "node:path";
import {
	BRIDGE_REPO,
	NoTransportError,
	describeCapabilities,
	resolveCapabilities,
	selectRoute,
	setupGuidance,
	type Capabilities,
	type Route,
} from "./capability";
import {
	CHATGPT_ORIGIN,
	PolicyDeniedError,
	attachFiles,
	captureScreenshot,
	closeSession,
	createSession,
	fetchArtifact,
	openChat,
	readAssistantTurn,
	showSession,
	submitPrompt,
	tabIdFromSession,
	tabUrl,
	waitForStableText,
} from "./chatgpt";
import { applyLabel, resolveExec, resolveType } from "./host";
import { readString } from "./json";
import { runOracle } from "./oracle";
import type { Exec, ExtensionAPI, ToolResult, TypeBuilder } from "./types";

export const GENERATED_ROOT = resolve(homedir(), ".chatgpt-control", "generated");

const SESSION_PREFIX = "chatgpt-control";
const DEFAULT_WAIT_MS = 10 * 60_000;

function textResult(text: string, details?: unknown, isError = false): ToolResult {
	return {
		content: [{ type: "text", text }],
		...(details === undefined ? {} : { details, structuredContent: details }),
		...(isError ? { isError: true } : {}),
	};
}

/**
 * Keeps generated files inside the extension's own directory unless the caller
 * explicitly opts out, so a model cannot be talked into writing anywhere.
 */
export function resolveOutputDir(value: unknown, allowExternal: unknown): string {
	if (typeof value !== "string" || value.length === 0) return GENERATED_ROOT;
	const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
	const absolute = isAbsolute(expanded) ? expanded : resolve(GENERATED_ROOT, expanded);
	if (allowExternal === true) return absolute;
	if (absolute === GENERATED_ROOT || absolute.startsWith(GENERATED_ROOT + sep)) return absolute;
	throw new Error(`${absolute} is outside ${GENERATED_ROOT}. Pass allow_external_output=true to write there.`);
}

export function mimeForPath(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

/** Session names carry their kind so a later process can still classify them. */
export function sessionName(kind: "consult" | "chat" | "image"): string {
	return `${SESSION_PREFIX}:${kind}:${Date.now().toString(36)}`;
}

export function sessionKind(name: string | undefined): "consult" | "chat" | "image" | undefined {
	if (!name?.startsWith(`${SESSION_PREFIX}:`)) return undefined;
	const kind = name.split(":")[1];
	return kind === "consult" || kind === "chat" || kind === "image" ? kind : undefined;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function describeError(error: unknown): ToolResult {
	if (error instanceof PolicyDeniedError) {
		return textResult(`${error.message}\n\nAllow it with:\n  ${error.remediation}`, { policyDenied: true }, true);
	}
	if (error instanceof NoTransportError) return textResult(error.message, { transport: "none" }, true);
	return textResult(error instanceof Error ? error.message : String(error), undefined, true);
}

interface BrowserTurn {
	jobId: string;
	tabId: number;
	text: string;
	settled: boolean;
	conversationUrl?: string;
	imageUrls: string[];
}

async function runBrowserTurn(
	exec: Exec,
	route: Route,
	options: {
		sessionId?: string;
		kind: "consult" | "chat" | "image";
		prompt: string;
		files: string[];
		wait: boolean;
		timeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<BrowserTurn> {
	// Navigating an existing session reuses its one tab, so sending the session
	// back to the root URL would replace the very conversation being continued.
	// A continuation therefore resolves the live tab and submits into it.
	const sessionId = options.sessionId ?? (await createSession(exec, route.launcher, sessionName(options.kind), options.signal));
	const tabId = options.sessionId
		? resolveContinuationTab(await showSession(exec, route.launcher, options.sessionId, options.signal), options.sessionId)
		: await openChat(exec, route.launcher, sessionId, CHATGPT_ORIGIN, options.signal);
	await attachFiles(exec, route.launcher, tabId, options.files, options.signal);
	await submitPrompt(exec, route.launcher, tabId, options.prompt, options.signal);

	if (!options.wait) {
		return { jobId: sessionId, tabId, text: "", settled: false, imageUrls: [] };
	}

	const stable = await waitForStableText(exec, route.launcher, tabId, { timeoutMs: options.timeoutMs, signal: options.signal });
	const turn = await readAssistantTurn(exec, route.launcher, tabId, options.signal);
	return {
		jobId: sessionId,
		tabId,
		text: turn.text || stable.text,
		settled: stable.settled,
		conversationUrl: await tabUrl(exec, route.launcher, tabId, options.signal),
		imageUrls: turn.imageUrls,
	};
}

function withNotice(text: string, route: Route): string {
	return route.notice ? `${text}\n\n---\n${route.notice}` : text;
}

export default function chatgptControl(pi: ExtensionAPI): void {
	const exec = resolveExec(pi);
	const Type: TypeBuilder = resolveType(pi);
	applyLabel(pi, "ChatGPT Control");

	const capabilities = (signal?: AbortSignal): Promise<Capabilities> => resolveCapabilities(exec, process.env, signal);

	pi.registerTool({
		name: "chatgpt_consult",
		label: "ChatGPT Consult",
		description:
			"Ask ChatGPT for an independent review with explicit files attached. Runs in a background tab of your signed-in Chrome when Chrome Bridge is available. Returns the answer, plus a job id for later inspection.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({
			prompt: Type.String({ description: "Self-contained question: context, constraints, and the output you want." }),
			files: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths to attach. Keep the set small and relevant." })),
			engine: Type.Optional(Type.Union([Type.Literal("browser"), Type.Literal("api")])),
			api_confirmed: Type.Optional(Type.Boolean({ description: "Required for engine=api, which bills your OpenAI key." })),
			model: Type.Optional(Type.String({ description: "Model id for engine=api." })),
			wait: Type.Optional(Type.Boolean({ description: "Default true. False returns a job id immediately." })),
			timeout_ms: Type.Optional(Type.Integer({ description: "Default 600000." })),
		}),
		execute: async (_id, params, signal) => {
			try {
				const engine = params.engine === "api" ? "api" : "browser";
				const route = selectRoute(await capabilities(signal), { engine, apiConfirmed: params.api_confirmed === true });
				const prompt = String(params.prompt ?? "");
				const files = stringList(params.files);
				const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : DEFAULT_WAIT_MS;

				if (route.kind !== "chrome-bridge") {
					const run = await runOracle(exec, route.launcher, {
						prompt,
						files,
						engine: route.kind === "oracle-api" ? "api" : "browser",
						model: typeof params.model === "string" ? params.model : undefined,
						timeoutMs,
						signal,
					});
					return textResult(withNotice(run.text, route), { transport: route.kind, engine });
				}

				const turn = await runBrowserTurn(exec, route, {
					kind: "consult",
					prompt,
					files,
					wait: params.wait !== false,
					timeoutMs,
					signal,
				});
				const body = turn.text || `Submitted. Inspect it with chatgpt_job action="result" job_id="${turn.jobId}".`;
				return textResult(withNotice(body, route), {
					transport: route.kind,
					jobId: turn.jobId,
					settled: turn.settled,
					conversationUrl: turn.conversationUrl,
				});
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "chatgpt_chat",
		label: "ChatGPT Chat",
		description: "Start a ChatGPT conversation or send another turn into one you already opened. Use chatgpt_consult when the question needs files.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({
			prompt: Type.String(),
			job_id: Type.Optional(Type.String({ description: "Continue the conversation behind this job id." })),
			files: Type.Optional(Type.Array(Type.String())),
			wait: Type.Optional(Type.Boolean({ description: "Default true." })),
			timeout_ms: Type.Optional(Type.Integer()),
		}),
		execute: async (_id, params, signal) => {
			try {
				const route = selectRoute(await capabilities(signal), { engine: "browser" });
				const prompt = String(params.prompt ?? "");
				const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : DEFAULT_WAIT_MS;

				if (route.kind !== "chrome-bridge") {
					const run = await runOracle(exec, route.launcher, { prompt, engine: "browser", timeoutMs, signal });
					return textResult(withNotice(run.text, route), { transport: route.kind });
				}

				const turn = await runBrowserTurn(exec, route, {
					sessionId: typeof params.job_id === "string" ? params.job_id : undefined,
					kind: "chat",
					prompt,
					files: stringList(params.files),
					wait: params.wait !== false,
					timeoutMs,
					signal,
				});
				const body = turn.text || `Submitted. Inspect it with chatgpt_job action="result" job_id="${turn.jobId}".`;
				return textResult(withNotice(body, route), {
					transport: route.kind,
					jobId: turn.jobId,
					settled: turn.settled,
					conversationUrl: turn.conversationUrl,
				});
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "chatgpt_image",
		label: "ChatGPT Image",
		description:
			"Generate or iterate on images in ChatGPT and return them inline plus on disk. Requires Chrome Bridge, because image artifacts are read out of the live page.",
		loadMode: "discoverable",
		approval: "write",
		parameters: Type.Object({
			prompt: Type.String({ description: "Image instruction, or the change to make to the previous image." }),
			job_id: Type.Optional(Type.String({ description: "Iterate inside this existing image conversation." })),
			files: Type.Optional(Type.Array(Type.String(), { description: "Reference images to attach." })),
			output_dir: Type.Optional(Type.String()),
			allow_external_output: Type.Optional(Type.Boolean()),
			timeout_ms: Type.Optional(Type.Integer({ description: "Default 600000." })),
		}),
		execute: async (_id, params, signal) => {
			try {
				const resolved = await capabilities(signal);
				if (!resolved.bridge) {
					return textResult(
						`Image generation needs Chrome Bridge, which reads the finished image out of the live ChatGPT page.\n\n${setupGuidance(resolved)}`,
						{ transport: "none", images: "requires Chrome Bridge" },
						true,
					);
				}
				const route = selectRoute(resolved, { engine: "browser" });
				const outputDir = resolveOutputDir(params.output_dir, params.allow_external_output);
				const turn = await runBrowserTurn(exec, route, {
					sessionId: typeof params.job_id === "string" ? params.job_id : undefined,
					kind: "image",
					prompt: String(params.prompt ?? ""),
					files: stringList(params.files),
					wait: true,
					timeoutMs: typeof params.timeout_ms === "number" ? params.timeout_ms : DEFAULT_WAIT_MS,
					signal,
				});
				return await imageResult(exec, route, turn, outputDir, signal);
			} catch (error) {
				return describeError(error);
			}
		},
	});

	pi.registerTool({
		name: "chatgpt_job",
		label: "ChatGPT Job",
		description: "Inspect, retrieve, or close ChatGPT work started by the other tools, and check which transport this extension is using.",
		loadMode: "discoverable",
		approval: "read",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("result"), Type.Literal("close"), Type.Literal("diagnose")]),
			job_id: Type.Optional(Type.String()),
			output_dir: Type.Optional(Type.String()),
			allow_external_output: Type.Optional(Type.Boolean()),
		}),
		execute: async (_id, params, signal) => {
			try {
				const resolved = await capabilities(signal);
				const action = String(params.action);

				if (action === "diagnose") {
					const detail = describeCapabilities(resolved);
					const advice = resolved.bridge
						? `Using Chrome Bridge at ${resolved.bridge.probe.endpoint ?? "127.0.0.1:9223"}. Requests open a background tab in the Chrome you are already signed into.`
						: setupGuidance(resolved);
					return textResult(advice, detail);
				}

				if (!resolved.bridge) {
					return textResult(
						`Job inspection tracks Chrome Bridge task sessions, and no bridge is available.\n\n${setupGuidance(resolved)}`,
						describeCapabilities(resolved),
						true,
					);
				}
				const launcher = resolved.bridge.launcher;
				const route: Route = { kind: "chrome-bridge", launcher };


				const jobId = typeof params.job_id === "string" ? params.job_id : "";
				if (jobId === "") return textResult(`action="${action}" needs job_id.`, undefined, true);

				if (action === "close") {
					await closeSession(exec, launcher, jobId, signal);
					return textResult(`Closed ${jobId} and the tabs it owned.`, { jobId, closed: true });
				}

				const session = await showSession(exec, launcher, jobId, signal);
				const tabId = tabIdFromSession(session);
				if (tabId === undefined) return textResult(`Job ${jobId} owns no open tab.`, { jobId, session }, true);

				const turn = await readAssistantTurn(exec, launcher, tabId, signal);
				const detail = {
					jobId,
					tabId,
					state: readString(session, "state"),
					conversationUrl: await tabUrl(exec, launcher, tabId, signal),
				};
				if (sessionKind(readString(session, "name")) !== "image" || turn.imageUrls.length === 0) {
					return textResult(turn.text || "No assistant message yet.", detail);
				}
				return await imageResult(
					exec,
					route,
					{ jobId, tabId, text: turn.text, settled: true, imageUrls: turn.imageUrls, conversationUrl: detail.conversationUrl },
					resolveOutputDir(params.output_dir, params.allow_external_output),
					signal,
				);
			} catch (error) {
				return describeError(error);
			}
		},
	});
}

/**
 * Resolves the tab a continuation must submit into.
 *
 * Failing loudly matters here: silently opening a fresh tab would answer in a
 * new conversation while still reporting the old job id.
 */
function resolveContinuationTab(session: Record<string, unknown>, jobId: string): number {
	const tabId = tabIdFromSession(session);
	if (tabId === undefined) {
		throw new Error(`Job ${jobId} owns no open tab, so its conversation cannot be continued. Omit job_id to start a new one.`);
	}
	return tabId;
}

/**
 * Saves each generated image and returns it inline, falling back to a
 * screenshot of the tab when the fetch is refused.
 */
async function imageResult(
	exec: Exec,
	route: Route,
	turn: BrowserTurn,
	outputDir: string,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const content: Array<Record<string, unknown>> = [];
	const saved: string[] = [];
	const blocked: string[] = [];

	for (const [index, url] of turn.imageUrls.entries()) {
		const destination = resolve(outputDir, `${turn.jobId}-${index + 1}.png`);
		const outcome = await fetchArtifact(url, destination, signal);
		if (outcome.path) {
			saved.push(outcome.path);
			content.push({ type: "image", data: (await readFile(outcome.path)).toString("base64"), mimeType: mimeForPath(outcome.path) ?? "image/png" });
		} else if (outcome.blocked) {
			blocked.push(outcome.blocked);
		}
	}

	if (saved.length === 0) {
		const shot = await captureScreenshot(exec, route.launcher, turn.tabId, resolve(outputDir, `${turn.jobId}.png`), signal);
		if (shot) {
			saved.push(shot);
			content.push({ type: "image", data: (await readFile(shot)).toString("base64"), mimeType: "image/png" });
		}
	}

	const notes = [turn.text || "Image ready.", ...(blocked.length > 0 ? ["", blocked[0]] : [])].join("\n");
	content.push({ type: "text", text: withNotice(notes, route) });
	return {
		content,
		details: { transport: route.kind, jobId: turn.jobId, images: saved, imageUrls: turn.imageUrls, conversationUrl: turn.conversationUrl },
		structuredContent: { jobId: turn.jobId, images: saved },
	};
}

export { BRIDGE_REPO, describeCapabilities, resolveCapabilities, selectRoute, setupGuidance } from "./capability";
export { extractAssistantTurn, decodeEntities, extractTabId } from "./chatgpt";
export { extractOracleAnswer, buildOracleArgs } from "./oracle";
export { fallbackExec, resolveExec, resolveType } from "./host";
export { findOnPath, resolveBridgeLauncher, resolveOracleLauncher, splitCommandLine } from "./transport";
