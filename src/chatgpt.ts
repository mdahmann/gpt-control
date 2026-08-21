import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeCommandError, isRecord, parseCommandJson, readArray, readNumber, readRecord, readString } from "./json";
import { runLauncher, type Launcher } from "./transport";
import type { Exec } from "./types";

export const CHATGPT_ORIGIN = "https://chatgpt.com";

/**
 * ChatGPT ships no stable automation contract, so every selector here is a
 * guess that can rot. They are kept in one place and each has a fallback.
 *
 * A bare `textarea` is deliberately absent. The real composer is a
 * contenteditable div, and a generic textarea can sit inside a form whose
 * submit navigates the tab to `?prompt-textarea=<the prompt>` as a GET instead
 * of sending a message, which was observed in testing.
 */
const PROMPT_SELECTORS = ["#prompt-textarea", 'div[contenteditable="true"]'];
const SEND_SELECTORS = ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[data-testid="composer-send-button"]'];
const FILE_INPUT_SELECTOR = 'input[type="file"]';
const ASSISTANT_MARKER = 'data-message-author-role="assistant"';

export interface ChatSession {
	sessionId: string;
	tabId: number;
}

export interface AssistantTurn {
	text: string;
	imageUrls: string[];
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

/**
 * Turns a fail-closed refusal into the specific fix.
 *
 * Only `egress` and `origin` denials are fixed by widening policy. A `target`
 * denial means the request carried no resolvable origin, which happens while a
 * tab is still committing, so it stays a plain retryable error. Advising a
 * policy grant there would tell the user to loosen security to work around a
 * timing bug.
 */
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

function resultOf(payload: Record<string, unknown>): unknown {
	return payload.result ?? payload;
}

/** Task-session payloads nest their tab list one or two levels deep. */
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

/** Failures that mean "the page is not there yet" rather than "this is wrong". */
function isTransient(message: string): boolean {
	return /tab origin unresolved|No element found|not ready|detached|no such tab/i.test(message);
}

/**
 * Retries the action across candidate selectors until the deadline.
 *
 * This doubles as the readiness wait. Navigation returns before the tab commits
 * an origin, and ChatGPT renders its composer after the document completes, so
 * the two failure windows are cleared by retrying the real action instead of
 * watching a proxy signal that can disagree with it.
 */
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
		await new Promise((done) => setTimeout(done, Math.min(250 * 2 ** attempt, 2000)));
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
	await bridgeJson(exec, launcher, ["uploadFile", String(tabId), FILE_INPUT_SELECTOR, ...files], signal, 180_000);
}

export async function submitPrompt(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	prompt: string,
	signal?: AbortSignal,
	readyTimeoutMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + readyTimeoutMs;
	await actOnSelector(exec, launcher, (selector) => ["fill", String(tabId), selector, prompt], PROMPT_SELECTORS, {
		signal,
		deadline,
		what: "fill the ChatGPT prompt",
	});
	await actOnSelector(exec, launcher, (selector) => ["click", String(tabId), selector], SEND_SELECTORS, {
		signal,
		deadline: Date.now() + 30_000,
		what: "click the ChatGPT send button",
	});
}

export async function pageText(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	maxChars: number,
	signal?: AbortSignal,
): Promise<string> {
	const payload = await bridgeJson(exec, launcher, ["extractText", String(tabId), String(maxChars)], signal);
	const result = resultOf(payload);
	return readString(result, "text") ?? readString(payload, "text") ?? "";
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

/**
 * Poll cadence for answer-stability detection. Slow machines and fast test
 * runs both need to move this, so it is one knob rather than a literal.
 */
export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.CHATGPT_CONTROL_POLL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

/**
 * Waits for the answer to stop changing.
 *
 * ChatGPT exposes no completion flag that survives UI revisions, so this
 * watches for the page text to hold steady instead of matching a spinner
 * selector. Streaming pauses are absorbed by requiring several equal reads.
 */
export async function waitForStableText(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	options: { timeoutMs: number; intervalMs?: number; stableRounds?: number; signal?: AbortSignal },
): Promise<{ settled: boolean; text: string }> {
	const intervalMs = options.intervalMs ?? pollIntervalMs();
	const stableRounds = options.stableRounds ?? 3;
	const deadline = Date.now() + options.timeoutMs;
	let previous = "";
	let steady = 0;

	while (Date.now() < deadline) {
		await new Promise((done) => setTimeout(done, intervalMs));
		if (options.signal?.aborted) break;
		const current = await pageText(exec, launcher, tabId, 200_000, options.signal);
		if (current === previous && current.trim() !== "") {
			steady += 1;
			if (steady >= stableRounds) return { settled: true, text: current };
		} else {
			steady = 0;
			previous = current;
		}
	}
	return { settled: false, text: previous };
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	"#39": "'",
	"#x27": "'",
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

/**
 * Hosts that serve ChatGPT's generated images.
 *
 * Matching is on the parsed hostname, never on the raw string. A substring test
 * would accept a page-supplied URL such as
 * `http://169.254.169.254/latest/meta-data/oaiusercontent.com`, and the fetch
 * runs in this process rather than behind Chrome Bridge's policy, so a loose
 * check turns page content into a request forgery primitive.
 */
const IMAGE_HOSTS = ["oaiusercontent.com", "files.openai.com"] as const;

export function approvedImageUrl(raw: string): URL | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	const host = url.hostname.toLowerCase();
	return IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url : undefined;
}

/** Slices the final assistant turn out of a saved ChatGPT page. */
export function extractAssistantTurn(html: string): AssistantTurn {
	const marker = html.lastIndexOf(ASSISTANT_MARKER);
	// Advance past the rest of the enclosing opening tag: the marker sits inside
	// it, so slicing at the marker would leave `…="assistant">` as literal text.
	const tagEnd = marker === -1 ? -1 : html.indexOf(">", marker);
	const region = marker === -1 ? "" : html.slice(tagEnd === -1 ? marker : tagEnd + 1);
	const imageUrls: string[] = [];
	const seen = new Set<string>();
	for (const match of region.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
		const url = approvedImageUrl(decodeEntities(match[1]));
		if (!url || seen.has(url.href)) continue;
		seen.add(url.href);
		imageUrls.push(url.href);
	}

	const text = decodeEntities(
		region
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|li|h[1-6]|pre|tr)>/gi, "\n")
			.replace(/<li\b[^>]*>/gi, "- ")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { text, imageUrls };
}

export async function readAssistantTurn(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	signal?: AbortSignal,
): Promise<AssistantTurn> {
	const scratch = join(tmpdir(), `chatgpt-control-${tabId}-${Date.now()}.html`);
	try {
		await bridgeJson(exec, launcher, ["getHTML", String(tabId), scratch], signal, 120_000);
		return extractAssistantTurn(await readFile(scratch, "utf8"));
	} finally {
		await rm(scratch, { force: true });
	}
}

export async function captureScreenshot(
	exec: Exec,
	launcher: Launcher,
	tabId: number,
	destination: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	await mkdir(resolve(destination, ".."), { recursive: true });
	try {
		await bridgeJson(exec, launcher, ["screenshot", String(tabId), destination], signal, 120_000);
		return destination;
	} catch {
		return undefined;
	}
}

/** Refuse anything larger than this; the page controls the URL, not the size. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Saves a generated image.
 *
 * The bridge's `downloadUrl` is deliberately unused: it takes a bare filename
 * rather than a destination, so the output directory cannot be controlled, and
 * the shipped policy gates it behind a confirmation. Fetching the pre-signed
 * URL directly is simpler and directory-accurate, but it leaves Chrome Bridge's
 * policy behind, so this function re-imposes the equivalent limits itself: an
 * approved HTTPS host, no redirects, an image content type, and a byte cap
 * enforced while streaming rather than trusting `content-length`.
 *
 * A refusal is expected and never fails the surrounding request.
 */
export async function fetchArtifact(
	rawUrl: string,
	destination: string,
	signal?: AbortSignal,
): Promise<{ path?: string; blocked?: string }> {
	const url = approvedImageUrl(rawUrl);
	if (!url) return { blocked: `Refused ${rawUrl}: not an approved ChatGPT image host.` };
	try {
		const response = await fetch(url, { signal, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			return { blocked: "Refused to follow a redirect away from the approved image host." };
		}
		if (!response.ok) return { blocked: `Could not download the generated image (HTTP ${response.status}).` };

		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.toLowerCase().startsWith("image/")) {
			return { blocked: `Refused a response that is not an image (${contentType || "no content type"}).` };
		}
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
			return { blocked: `Refused an image larger than ${MAX_IMAGE_BYTES} bytes.` };
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of streamBytes(response)) {
			total += chunk.byteLength;
			if (total > MAX_IMAGE_BYTES) return { blocked: `Refused an image larger than ${MAX_IMAGE_BYTES} bytes.` };
			chunks.push(chunk);
		}

		await mkdir(resolve(destination, ".."), { recursive: true });
		await writeFile(destination, Buffer.concat(chunks, total));
		return { path: destination };
	} catch (error) {
		return { blocked: error instanceof Error ? error.message : String(error) };
	}
}

/** Yields body chunks, tolerating runtimes that expose no readable stream. */
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
