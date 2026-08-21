import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { parseCommandJson, readString } from "./json";
import type { Exec, ExecOptions, ExecResult } from "./types";

/** A resolved argv, ready to hand to `exec`. */
export interface Launcher {
	command: string;
	args: string[];
	cwd?: string;
	/** Human-readable provenance, surfaced by the diagnose action. */
	origin: string;
}

export interface BridgeProbe {
	ready: boolean;
	endpoint?: string;
	extension?: string;
	reason?: string;
}

const DEFAULT_BRIDGE_ROOTS = ["Projects/chrome-bridge", "Projects/chrome-native-bridge", "chrome-bridge", "src/chrome-bridge"];

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function isReadable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** Locates an executable on PATH without spawning a shell. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (name.includes("/")) return isExecutable(name) ? name : undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

/** Splits an env-provided command line while honouring simple quoting. */
export function splitCommandLine(value: string): string[] {
	const parts = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return parts.map((part) =>
		(part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
			? part.slice(1, -1)
			: part,
	);
}

function launcherFromCommandLine(value: string, origin: string): Launcher | undefined {
	const parts = splitCommandLine(value.trim());
	if (parts.length === 0) return undefined;
	const [command, ...args] = parts;
	return { command, args, origin };
}

function resolvePython(env: NodeJS.ProcessEnv): string | undefined {
	const explicit = env.GPT_CONTROL_PYTHON;
	if (explicit && isExecutable(explicit)) return explicit;
	return findOnPath("python3", env) ?? findOnPath("python", env);
}

/**
 * Resolves the Chrome Bridge client.
 *
 * Order: explicit command line, `chrome-bridge` on PATH, an explicit repository
 * root, then conventional checkout locations. Chrome Bridge ships its client as
 * `test_client.py` and only documents the `chrome-bridge` symlink as optional,
 * so the repository form has to be a first-class path rather than a fallback.
 */
export function resolveBridgeLauncher(env: NodeJS.ProcessEnv = process.env): Launcher | undefined {
	const explicit = env.GPT_CONTROL_BRIDGE;
	if (explicit) {
		const launcher = launcherFromCommandLine(explicit, "GPT_CONTROL_BRIDGE");
		if (launcher) return launcher;
	}

	const onPath = findOnPath("chrome-bridge", env);
	if (onPath) return { command: onPath, args: [], origin: "chrome-bridge on PATH" };

	const python = resolvePython(env);
	if (!python) return undefined;

	const roots: Array<{ path: string; origin: string }> = [];
	for (const key of ["CHROME_BRIDGE_HOME", "BRIDGE_REPO_ROOT", "CHROME_BRIDGE_REPO"]) {
		const value = env[key];
		if (value) roots.push({ path: value, origin: key });
	}
	const home = env.HOME ?? homedir();
	for (const relative of DEFAULT_BRIDGE_ROOTS) {
		roots.push({ path: isAbsolute(relative) ? relative : resolve(home, relative), origin: `checkout at ~/${relative}` });
	}

	for (const root of roots) {
		const client = resolve(root.path, "test_client.py");
		if (isReadable(client)) return { command: python, args: [client], cwd: root.path, origin: root.origin };
	}
	return undefined;
}

/**
 * Resolves the Oracle CLI, Kyle McCleary's ChatGPT/GPT-5 Pro runner.
 * Deliberately never falls back to `npx`: an implicit network install inside a
 * tool call is slow and silently version-drifting.
 */
export function resolveOracleLauncher(env: NodeJS.ProcessEnv = process.env): Launcher | undefined {
	const explicit = env.GPT_CONTROL_ORACLE;
	if (explicit) {
		const launcher = launcherFromCommandLine(explicit, "GPT_CONTROL_ORACLE");
		if (launcher) return launcher;
	}
	const onPath = findOnPath("oracle", env);
	if (onPath) return { command: onPath, args: [], origin: "oracle on PATH" };
	return undefined;
}

export function launcherArgs(launcher: Launcher, args: string[]): string[] {
	return launcher.args.length === 0 ? args : [...launcher.args, ...args];
}

export function runLauncher(
	exec: Exec,
	launcher: Launcher,
	args: string[],
	options?: ExecOptions,
): Promise<ExecResult> {
	return exec(launcher.command, launcherArgs(launcher, args), { cwd: launcher.cwd, ...options });
}

/**
 * Readiness budget for the bridge probe.
 *
 * Chrome's MV3 service worker idles out, so the first `ready` after a quiet
 * period pays a wake-up cost. Observed times ranged from 435ms to just under
 * 2s on a healthy install, and a tight budget reports a live bridge as absent.
 */
export function probeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.GPT_CONTROL_PROBE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/**
 * Asks Chrome Bridge whether the endpoint, native host, and extension are all
 * live. `ready` exits non-zero when it is not, so the payload is read directly
 * instead of going through the throwing parser.
 */
export async function probeBridge(
	exec: Exec,
	launcher: Launcher,
	signal?: AbortSignal,
	timeoutMs = probeTimeoutMs(),
): Promise<BridgeProbe> {
	const result = await runLauncher(exec, launcher, ["ready", String(timeoutMs), "250"], { signal, timeout: timeoutMs + 2000 });
	const stdout = result.stdout.trim();
	if (stdout === "") {
		return { ready: false, reason: result.stderr.trim() || `chrome-bridge ready exited ${result.code}` };
	}
	try {
		const payload: unknown = JSON.parse(stdout);
		return {
			ready: readString(payload, "endpointStatus") === "reachable" && readString(payload, "extension") === "connected",
			endpoint: readString(payload, "endpoint"),
			extension: readString(payload, "extension"),
			reason: readString(payload, "reason"),
		};
	} catch {
		return { ready: false, reason: `chrome-bridge ready returned invalid JSON: ${stdout.slice(0, 200)}` };
	}
}

/** Confirms the Oracle CLI actually runs, rather than merely existing on disk. */
export async function probeOracle(exec: Exec, launcher: Launcher, signal?: AbortSignal): Promise<string | undefined> {
	const result = await runLauncher(exec, launcher, ["--version"], { signal, timeout: 20_000 });
	if (result.code !== 0) return undefined;
	return result.stdout.trim().split("\n").pop()?.trim() || undefined;
}

export { parseCommandJson };
