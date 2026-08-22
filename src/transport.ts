import { accessSync, constants, realpathSync } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommandJson, readString } from "./json";
import type { Exec, ExecOptions, ExecResult } from "./types";

export interface PrivateBridgeRpc {
	command: string;
	args: string[];
	clientScript: string;
	origin: string;
}

/** A resolved argv, ready to hand to `exec`. */
export interface Launcher {
	command: string;
	args: string[];
	cwd?: string;
	/** Human-readable provenance, surfaced by the diagnose action. */
	origin: string;
	/** Private request-file adapter required for prompts and upload paths. */
	privateRpc?: PrivateBridgeRpc;
}

export interface BridgeProbe {
	ready: boolean;
	endpoint?: string;
	extension?: string;
	reason?: string;
}

const DEFAULT_BRIDGE_ROOTS = ["Projects/chrome-bridge", "Projects/chrome-native-bridge", "chrome-bridge", "src/chrome-bridge"];
const BRIDGE_RPC_HELPERS = [
	fileURLToPath(new URL("./bridge_rpc.py", import.meta.url)),
	fileURLToPath(new URL("../src/bridge_rpc.py", import.meta.url)),
];

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

function attachPrivateRpc(launcher: Launcher, env: NodeJS.ProcessEnv, explicitClient?: string): Launcher {
	const python = resolvePython(env);
	const helper = BRIDGE_RPC_HELPERS.find(isReadable);
	if (!python || !helper) return launcher;
	let client = explicitClient;
	if (!client && launcher.args.length > 0) {
		const first = isAbsolute(launcher.args[0]) ? launcher.args[0] : resolve(launcher.cwd ?? process.cwd(), launcher.args[0]);
		if (basename(first) === "test_client.py" && isReadable(first)) client = first;
	}
	if (!client) {
		try {
			const target = realpathSync(launcher.command);
			if (basename(target) === "test_client.py" && isReadable(target)) client = target;
		} catch {}
	}
	if (!client || !isReadable(client)) return launcher;
	return {
		...launcher,
		privateRpc: {
			command: python,
			args: [helper],
			clientScript: resolve(client),
			origin: `private request-file RPC via ${client}`,
		},
	};
}

/**
 * Resolves the Chrome Bridge client. Sensitive payloads require a discoverable
 * `test_client.py` so GPT-Control can import its local socket client through a
 * private request file instead of placing prompts or upload paths in argv.
 */
export function resolveBridgeLauncher(env: NodeJS.ProcessEnv = process.env): Launcher | undefined {
	const explicitClient = env.GPT_CONTROL_BRIDGE_CLIENT_SCRIPT;
	const explicit = env.GPT_CONTROL_BRIDGE;
	if (explicit) {
		const launcher = launcherFromCommandLine(explicit, "GPT_CONTROL_BRIDGE");
		if (launcher) return attachPrivateRpc(launcher, env, explicitClient);
	}

	const onPath = findOnPath("chrome-bridge", env);
	if (onPath) return attachPrivateRpc({ command: onPath, args: [], origin: "chrome-bridge on PATH" }, env, explicitClient);

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
		if (isReadable(client)) {
			return attachPrivateRpc({ command: python, args: [client], cwd: root.path, origin: root.origin }, env, explicitClient ?? client);
		}
	}
	return undefined;
}

/**
 * Resolves the Oracle CLI for passive compatibility reporting only. Hardened
 * routing refuses to execute it until Oracle exposes a non-argv request path.
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
 * Sends a Chrome Bridge payload through a mode-0600 request file. The only
 * request-specific argv value is the random request-file name; prompt bodies
 * and attachment paths remain inside the private file and are deleted after use.
 */
export async function runPrivateBridgeRequest(
	exec: Exec,
	launcher: Launcher,
	action: string,
	payload: Record<string, unknown>,
	options?: ExecOptions & { readTimeoutMs?: number },
): Promise<ExecResult> {
	const rpc = launcher.privateRpc;
	if (!rpc) {
		throw new Error(
			"Chrome Bridge is installed, but GPT-Control cannot find test_client.py for private request-file transport. Set trusted GPT_CONTROL_BRIDGE_CLIENT_SCRIPT to that file before sending prompts or attachments.",
		);
	}
	const directory = await mkdtemp(join(tmpdir(), "gpt-control-bridge-rpc-"));
	await chmod(directory, 0o700);
	const requestPath = join(directory, "request.json");
	const handle = await open(requestPath, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify({ action, payload, readTimeoutMs: options?.readTimeoutMs }));
	} finally {
		await handle.close();
	}
	try {
		return await exec(rpc.command, [...rpc.args, rpc.clientScript, requestPath], {
			cwd: dirname(rpc.clientScript),
			signal: options?.signal,
			timeout: options?.timeout,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Readiness budget for the bridge probe. */
export function probeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.GPT_CONTROL_PROBE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

export async function probeBridge(
	exec: Exec,
	launcher: Launcher,
	signal?: AbortSignal,
	timeoutMs = probeTimeoutMs(),
): Promise<BridgeProbe> {
	const result = await runLauncher(exec, launcher, ["ready", String(timeoutMs), "250"], { signal, timeout: timeoutMs + 2000 });
	const stdout = result.stdout.trim();
	if (result.code !== 0 || result.killed) {
		return { ready: false, reason: result.stderr.trim() || `chrome-bridge ready exited ${result.code}` };
	}
	if (stdout === "") return { ready: false, reason: result.stderr.trim() || "chrome-bridge ready returned no JSON" };
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
	if (result.code !== 0 || result.killed) return undefined;
	return result.stdout.trim().split("\n").pop()?.trim() || undefined;
}

export function passiveTransportDiscovery(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
	const bridge = resolveBridgeLauncher(env);
	const oracle = resolveOracleLauncher(env);
	return {
		mode: "passive",
		browserDriver: {
			externalConfigured: Boolean(env.GPT_CONTROL_BROWSER_DRIVER?.trim()),
			protocolRequired: 2,
			secureStdinRequired: true,
		},
		chromeBridge: bridge
			? {
				installed: true,
				origin: bridge.origin,
				privateRequestTransport: Boolean(bridge.privateRpc),
				privateRequestOrigin: bridge.privateRpc?.origin,
			}
			: { installed: false },
		legacyOracle: oracle
			? { installed: true, origin: oracle.origin, executionEnabled: false, reason: "legacy CLI exposes request data in argv" }
			: { installed: false, executionEnabled: false },
		paidApiFallback: { configured: false, executionEnabled: false },
		note: "No discovered browser driver, Chrome Bridge adapter, legacy provider CLI, browser, or model was executed.",
	};
}

export { parseCommandJson };
