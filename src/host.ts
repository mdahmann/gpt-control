import { execFile } from "node:child_process";
import { Type as BundledType } from "@sinclair/typebox";
import type { Exec, ExecResult, ExecOptions, ExtensionAPI, TypeBuilder } from "./types";

/**
 * `child_process` execution for hosts that do not provide `pi.exec`.
 * Never rejects: a failed spawn is reported as a non-zero result so callers
 * only have to handle one shape.
 */
export function fallbackExec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve) => {
		execFile(
			command,
			args,
			{
				signal: options?.signal,
				timeout: options?.timeout,
				cwd: options?.cwd,
				maxBuffer: 32 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
				const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
				if (!error) {
					resolve({ stdout: out, stderr: err, code: 0, killed: false });
					return;
				}
				resolve({
					stdout: out,
					stderr: err || error.message,
					code: typeof error.code === "number" ? error.code : 1,
					killed: Boolean(error.killed) || typeof error.signal === "string",
				});
			},
		);
	});
}

/** OMP supplies `pi.exec`; Pi does not. */
export function resolveExec(pi: ExtensionAPI): Exec {
	return typeof pi.exec === "function" ? pi.exec.bind(pi) : fallbackExec;
}

/**
 * Both hosts expose TypeBox, but only when loaded as a first-class extension.
 * The bundled builder keeps direct imports and tests working.
 *
 * The cast is structural: `@sinclair/typebox` returns branded `TSchema` values
 * that carry symbol keys TypeScript cannot unify with a plain record, and the
 * host hands the same builder back untyped.
 */
const bundledTypeBuilder = BundledType as unknown as TypeBuilder;

export function resolveType(pi: ExtensionAPI): TypeBuilder {
	return pi.typebox?.Type ?? bundledTypeBuilder;
}

/** `setLabel(label)` is the OMP single-argument form; Pi's takes an entry id first. */
export function applyLabel(pi: ExtensionAPI, label: string): void {
	if (Boolean(pi.zod) && typeof pi.setLabel === "function") pi.setLabel(label);
}
