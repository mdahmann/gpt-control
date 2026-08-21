import { isRecord, readString } from "./json";
import { runLauncher, type Launcher } from "./transport";
import type { Exec } from "./types";

/**
 * Fallback path for users without Chrome Bridge.
 *
 * Oracle is Kyle McCleary's ChatGPT/GPT-5 Pro runner. Its `--json` payload is
 * unversioned, so the answer is located by trying the plausible field names and
 * falling back to raw stdout rather than binding to one shape.
 */

const ANSWER_KEYS = ["text", "answer", "output", "response", "content", "message", "result"] as const;

export interface OracleRun {
	text: string;
	raw: string;
	structured?: Record<string, unknown>;
}

/** Walks the payload for the first string that reads like a model answer. */
export function extractOracleAnswer(payload: unknown, depth = 0): string | undefined {
	if (typeof payload === "string") return payload.trim() === "" ? undefined : payload;
	if (depth > 4 || !isRecord(payload)) return undefined;
	for (const key of ANSWER_KEYS) {
		const direct = readString(payload, key);
		if (direct !== undefined && direct.trim() !== "") return direct;
	}
	for (const key of ANSWER_KEYS) {
		const nested = payload[key];
		if (nested === undefined) continue;
		const found = extractOracleAnswer(nested, depth + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

export interface OracleRequest {
	prompt: string;
	files?: readonly string[];
	model?: string;
	/** `api` bills the user's OpenAI key; `browser` drives Oracle's own Chrome. */
	engine: "api" | "browser";
	/** Oracle session or response id from a previous run, not a conversation URL. */
	followup?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Builds argv for Oracle's root one-shot.
 *
 * No `--json`: the root command does not accept it. Several Oracle
 * subcommands do, which makes the flag look universal in the source, and the
 * mistake surfaces only as `unknown option '--json'` at runtime.
 */
export function buildOracleArgs(request: OracleRequest): string[] {
	const args = ["--engine", request.engine, "--prompt", request.prompt];
	if (request.model) args.push("--model", request.model);
	for (const file of request.files ?? []) args.push("--file", file);
	if (request.followup) args.push("--followup", request.followup);
	return args;
}

export async function runOracle(exec: Exec, launcher: Launcher, request: OracleRequest): Promise<OracleRun> {
	const result = await runLauncher(exec, launcher, buildOracleArgs(request), {
		signal: request.signal,
		timeout: request.timeoutMs ?? 20 * 60_000,
	});
	const raw = result.stdout.trim();
	if (result.code !== 0 && raw === "") {
		throw new Error(result.stderr.trim() || `oracle exited ${result.code}`);
	}

	let structured: Record<string, unknown> | undefined;
	let text: string | undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed)) structured = parsed;
		text = extractOracleAnswer(parsed);
	} catch {
		// Oracle prints progress lines alongside prose when not emitting JSON.
	}
	if (text === undefined) text = raw;
	if (text.trim() === "") throw new Error(result.stderr.trim() || "oracle returned an empty response");
	return { text, raw, structured };
}
