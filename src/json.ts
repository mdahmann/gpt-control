import type { ExecResult } from "./types";

/**
 * Chrome Bridge and the Oracle CLI both emit unversioned JSON, so every read
 * goes through narrowing helpers rather than an assumed shape.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

export function readNumber(source: unknown, key: string): number | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "number" ? value : undefined;
}

export function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return isRecord(value) ? value : undefined;
}

export function readArray(source: unknown, key: string): unknown[] | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return Array.isArray(value) ? value : undefined;
}

/**
 * Parses one CLI invocation. A non-zero or killed process is always a failure,
 * even when stdout contains valid JSON or a superficially successful envelope.
 */
export function parseCommandJson(result: ExecResult, operation: string): Record<string, unknown> {
	const stdout = result.stdout.trim();
	let parsed: unknown;
	if (stdout !== "") {
		try {
			parsed = JSON.parse(stdout);
		} catch {
			if (result.code !== 0 || result.killed) {
				throw new Error(result.stderr.trim() || `${operation} exited ${result.code}`);
			}
			throw new Error(`${operation} returned invalid JSON: ${stdout.slice(0, 400)}`);
		}
	}

	if (result.code !== 0 || result.killed) {
		if (isRecord(parsed)) {
			const detail = failureDetail(parsed) ?? (result.stderr.trim() || `${operation} exited ${result.code}`);
			throw new BridgeCommandError(detail, parsed, readString(parsed, "confirmationToken"));
		}
		throw new Error(result.stderr.trim() || `${operation} exited ${result.code}`);
	}
	if (!isRecord(parsed)) {
		if (stdout === "") throw new Error(`${operation} returned an empty response`);
		throw new Error(`${operation} returned a non-object payload`);
	}
	if (parsed.success === false) {
		throw new BridgeCommandError(failureDetail(parsed) ?? `${operation} failed`, parsed, readString(parsed, "confirmationToken"));
	}
	const inner = readRecord(parsed, "result");
	if (inner?.success === false) {
		throw new BridgeCommandError(failureDetail(parsed) ?? `${operation} failed`, parsed, readString(parsed, "confirmationToken"));
	}
	return parsed;
}

function failureDetail(parsed: Record<string, unknown>): string | undefined {
	const inner = readRecord(parsed, "result");
	return readString(inner, "err")
		?? readString(inner, "error")
		?? readString(inner, "reason")
		?? readString(parsed, "error")
		?? readString(parsed, "reason");
}

/** Carries the raw payload so callers can react to policy gates without reparsing. */
export class BridgeCommandError extends Error {
	readonly payload: Record<string, unknown>;
	readonly confirmationToken?: string;

	constructor(message: string, payload: Record<string, unknown>, confirmationToken?: string) {
		super(message);
		this.name = "BridgeCommandError";
		this.payload = payload;
		this.confirmationToken = confirmationToken;
	}
}
