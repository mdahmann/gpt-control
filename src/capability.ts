import {
	findOnPath,
	probeBridge,
	probeOracle,
	resolveBridgeLauncher,
	resolveOracleLauncher,
	runLauncher,
	type BridgeProbe,
	type Launcher,
} from "./transport";
import type { Provider } from "./domain";
import type { Exec } from "./types";

export const BRIDGE_REPO = "https://github.com/wolfiesch/chrome-bridge";
export type TransportChoice = Provider;

export interface Capabilities {
	bridge?: { launcher: Launcher; probe: BridgeProbe };
	bridgeOffline?: { launcher: Launcher; probe: BridgeProbe };
	codex?: { version?: string; origin: string };
	responses?: { available: true };
	oracle?: { launcher: Launcher; version?: string };
}

export interface Route {
	kind: Provider;
	launcher?: Launcher;
}

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 12_000;
let cached: { at: number; value: Capabilities; positive: boolean } | undefined;
let inFlight: Promise<Capabilities> | undefined;

export function resetCapabilityCache(): void {
	cached = undefined;
	inFlight = undefined;
}

/** Active transport readiness, used only by run execution or explicit smoke tests. */
export async function resolveCapabilities(
	exec: Exec,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<Capabilities> {
	const ttl = cached?.positive ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
	if (cached && Date.now() - cached.at < ttl) return cached.value;
	if (inFlight) return inFlight;
	inFlight = probeCapabilities(exec, env, signal);
	try {
		const value = await inFlight;
		cached = { at: Date.now(), value, positive: Boolean(value.bridge || value.codex || value.responses || value.oracle) };
		return value;
	} finally {
		inFlight = undefined;
	}
}

async function probeCapabilities(exec: Exec, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Capabilities> {
	const value: Capabilities = {};
	const bridgeLauncher = resolveBridgeLauncher(env);
	const oracleLauncher = resolveOracleLauncher(env);
	const codexPath = findOnPath("codex", env);
	const [bridgeProbe, oracleVersion, codexVersion] = await Promise.all([
		bridgeLauncher ? probeBridge(exec, bridgeLauncher, signal).catch((): BridgeProbe => ({ ready: false, reason: "probe failed" })) : undefined,
		oracleLauncher ? probeOracle(exec, oracleLauncher, signal).catch(() => undefined) : undefined,
		codexPath
			? runLauncher(exec, { command: codexPath, args: [], origin: "codex on PATH" }, ["--version"], { signal, timeout: 10_000 })
				.then((result) => result.code === 0 && !result.killed ? result.stdout.trim() : undefined)
				.catch(() => undefined)
			: undefined,
	]);
	if (bridgeLauncher && bridgeProbe) {
		if (bridgeProbe.ready) value.bridge = { launcher: bridgeLauncher, probe: bridgeProbe };
		else value.bridgeOffline = { launcher: bridgeLauncher, probe: bridgeProbe };
	}
	if (codexVersion) value.codex = { version: codexVersion, origin: "codex on PATH" };
	if (env.OPENAI_API_KEY) value.responses = { available: true };
	if (oracleLauncher && oracleVersion) value.oracle = { launcher: oracleLauncher, version: oracleVersion };
	return value;
}

export class NoTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoTransportError";
	}
}

export interface RouteOptions {
	transport?: TransportChoice;
}

/**
 * Selects only a technically available route. Authority is enforced separately
 * by trusted OperatorPolicy. Oracle is deliberately unavailable because its
 * legacy CLI exposes prompt and attachment data through argv.
 */
export function selectRoute(capabilities: Capabilities, options: RouteOptions = {}): Route {
	const requested = options.transport;
	if (requested === "chrome_bridge") {
		if (capabilities.bridge) return { kind: "chrome_bridge", launcher: capabilities.bridge.launcher };
		throw new NoTransportError(bridgeUnavailable(capabilities));
	}
	if (requested === "codex") {
		if (!capabilities.codex) throw new NoTransportError("Codex transport requested, but `codex --version` did not succeed.");
		return { kind: "codex" };
	}
	if (requested === "responses") {
		if (!capabilities.responses) throw new NoTransportError("Responses API requested, but OPENAI_API_KEY is not available to this process.");
		return { kind: "responses" };
	}
	if (requested === "oracle_browser" || requested === "oracle_api") {
		throw new NoTransportError(
			"Oracle transport is disabled by the hardened broker because the current Oracle CLI puts prompt or attachment data in child-process argv.",
		);
	}

	if (capabilities.bridge) return { kind: "chrome_bridge", launcher: capabilities.bridge.launcher };
	if (capabilities.bridgeOffline) throw new NoTransportError(bridgeUnavailable(capabilities));
	if (capabilities.codex) return { kind: "codex" };
	throw new NoTransportError(setupGuidance(capabilities));
}

function bridgeUnavailable(capabilities: Capabilities): string {
	const reason = capabilities.bridgeOffline?.probe.reason ?? "Chrome Bridge is not installed";
	return `Chrome Bridge is unavailable: ${reason}. No foreground browser was launched. Retry, or explicitly choose transport=codex.`;
}

export function setupGuidance(capabilities: Capabilities): string {
	const lines = ["No GPT-Control transport is available.", ""];
	lines.push("Preferred browser path: Chrome Bridge opens an inactive tab without taking focus.", `  ${BRIDGE_REPO}`);
	if (!capabilities.codex) lines.push("Official local path: install and authenticate the Codex CLI (`npm i -g @openai/codex`).");
	lines.push("Paid Responses API is explicit-only and requires a fresh trusted operator confirmation for every request.");
	lines.push("Oracle is disabled until it provides a non-argv request transport.");
	return lines.join("\n");
}

export function describeCapabilities(capabilities: Capabilities): Record<string, unknown> {
	return {
		mode: "active_smoke_test",
		preferred: capabilities.bridge ? "chrome_bridge" : capabilities.bridgeOffline ? "chrome_bridge_unavailable" : capabilities.codex ? "codex" : "none",
		chromeBridge: capabilities.bridge
			? {
				available: true,
				origin: capabilities.bridge.launcher.origin,
				endpoint: capabilities.bridge.probe.endpoint,
				privateRequestTransport: Boolean(capabilities.bridge.launcher.privateRpc),
			}
			: capabilities.bridgeOffline
				? { available: false, installed: true, origin: capabilities.bridgeOffline.launcher.origin, reason: capabilities.bridgeOffline.probe.reason }
				: { available: false, installed: false, install: BRIDGE_REPO },
		codex: capabilities.codex ?? { available: false, install: "npm i -g @openai/codex" },
		responses: capabilities.responses ?? { available: false, reason: "OPENAI_API_KEY unavailable" },
		oracle: capabilities.oracle
			? { installed: true, executionEnabled: false, version: capabilities.oracle.version }
			: { installed: false, executionEnabled: false },
		focusSafety: "No transport is permitted to foreground a browser during automatic execution.",
	};
}
