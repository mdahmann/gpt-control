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
 * Parses one CLI invocation.
 *
 * Chrome Bridge reports failure three ways: a non-zero exit code, a
 * `success: false` envelope, and a `success: true` envelope wrapping a
 * `result.success: false` with the real reason in `result.err`. Missing the
 * third form makes a failed page action look like a successful one, so all
 * three become thrown errors here.
 */
export function parseCommandJson(result: ExecResult, operation: string): Record<string, unknown> {
	const stdout = result.stdout.trim();
	if (result.code !== 0 && stdout === "") {
		throw new Error(result.stderr.trim() || `${operation} exited ${result.code}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		if (result.code !== 0) throw new Error(result.stderr.trim() || `${operation} exited ${result.code}`);
		throw new Error(`${operation} returned invalid JSON: ${stdout.slice(0, 400)}`);
	}
	if (!isRecord(parsed)) throw new Error(`${operation} returned a non-object payload`);
	if (result.code !== 0) {
		const inner = readRecord(parsed, "result");
		const detail = readString(parsed, "error")
			|| readString(parsed, "reason")
			|| readString(inner, "err")
			|| readString(inner, "error")
			|| result.stderr.trim()
			|| `${operation} exited ${result.code}`;
		throw new BridgeCommandError(detail, parsed, readString(parsed, "confirmationToken"));
	}
	if (parsed.success === false) {
		const detail = readString(parsed, "error") ?? readString(parsed, "reason") ?? `${operation} failed`;
		throw new BridgeCommandError(detail, parsed, readString(parsed, "confirmationToken"));
	}
	const inner = readRecord(parsed, "result");
	if (inner?.success === false) {
		const detail = readString(inner, "err") ?? readString(inner, "error") ?? `${operation} failed`;
		throw new BridgeCommandError(detail, parsed, readString(parsed, "confirmationToken"));
	}
	return parsed;
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
