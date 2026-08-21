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
				.then((result) => result.code === 0 ? result.stdout.trim() : undefined)
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
	apiConfirmed?: boolean;
	allowFocusSteal?: boolean;
}

/**
 * Chooses a transport without surprising the user.
 *
 * A temporarily leased or sleeping Chrome Bridge is not permission to launch a
 * foreground browser. Oracle browser mode is reachable only by explicitly
 * naming it and acknowledging focus stealing.
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
		if (!options.apiConfirmed) throw new NoTransportError("Responses API is paid. Re-run with api_confirmed=true.");
		if (!capabilities.responses) throw new NoTransportError("Responses API requested, but OPENAI_API_KEY is not available to this process.");
		return { kind: "responses" };
	}
	if (requested === "oracle_browser") {
		if (!options.allowFocusSteal) {
			throw new NoTransportError("Oracle browser mode can foreground its own Chrome. Re-run with allow_focus_steal=true to choose it explicitly.");
		}
		if (!capabilities.oracle) throw new NoTransportError("Oracle browser mode requested, but the Oracle CLI is unavailable.");
		return { kind: "oracle_browser", launcher: capabilities.oracle.launcher };
	}
	if (requested === "oracle_api") {
		if (!options.apiConfirmed) throw new NoTransportError("Oracle API mode is paid. Re-run with api_confirmed=true.");
		if (!capabilities.oracle) throw new NoTransportError("Oracle API mode requested, but the Oracle CLI is unavailable.");
		return { kind: "oracle_api", launcher: capabilities.oracle.launcher };
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
	lines.push("Paid API path: set OPENAI_API_KEY and pass transport=responses plus api_confirmed=true.");
	lines.push("Oracle browser mode is never selected automatically because it can take focus.");
	return lines.join("\n");
}

export function describeCapabilities(capabilities: Capabilities): Record<string, unknown> {
	return {
		preferred: capabilities.bridge ? "chrome_bridge" : capabilities.bridgeOffline ? "chrome_bridge_unavailable" : capabilities.codex ? "codex" : "none",
		chromeBridge: capabilities.bridge
			? { available: true, origin: capabilities.bridge.launcher.origin, endpoint: capabilities.bridge.probe.endpoint }
			: capabilities.bridgeOffline
				? { available: false, installed: true, origin: capabilities.bridgeOffline.launcher.origin, reason: capabilities.bridgeOffline.probe.reason }
				: { available: false, installed: false, install: BRIDGE_REPO },
		codex: capabilities.codex ?? { available: false, install: "npm i -g @openai/codex" },
		responses: capabilities.responses ?? { available: false, reason: "OPENAI_API_KEY unavailable" },
		oracle: capabilities.oracle
			? { available: true, explicitOnly: true, version: capabilities.oracle.version }
			: { available: false, explicitOnly: true },
		focusSafety: "Oracle browser mode requires allow_focus_steal=true and is never a fallback.",
	};
}
