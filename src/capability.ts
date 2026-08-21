import {
	probeBridge,
	probeOracle,
	resolveBridgeLauncher,
	resolveOracleLauncher,
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
	oracle?: { launcher: Launcher; version?: string };
}

export interface Route {
	kind: Provider;
	launcher: Launcher;
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
		cached = { at: Date.now(), value, positive: Boolean(value.bridge || value.oracle) };
		return value;
	} finally {
		inFlight = undefined;
	}
}

async function probeCapabilities(exec: Exec, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Capabilities> {
	const value: Capabilities = {};
	const bridgeLauncher = resolveBridgeLauncher(env);
	const oracleLauncher = resolveOracleLauncher(env);
	const [bridgeProbe, oracleVersion] = await Promise.all([
		bridgeLauncher ? probeBridge(exec, bridgeLauncher, signal).catch((): BridgeProbe => ({ ready: false, reason: "probe failed" })) : undefined,
		oracleLauncher ? probeOracle(exec, oracleLauncher, signal).catch(() => undefined) : undefined,
	]);
	if (bridgeLauncher && bridgeProbe) {
		if (bridgeProbe.ready) value.bridge = { launcher: bridgeLauncher, probe: bridgeProbe };
		else value.bridgeOffline = { launcher: bridgeLauncher, probe: bridgeProbe };
	}
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
 * Selects a ChatGPT-web transport without surprising the user.
 *
 * A temporarily leased or sleeping Chrome Bridge is not permission to launch a
 * foreground browser. Oracle browser mode is reachable only by explicitly
 * naming it and acknowledging focus stealing.
 */
export function selectRoute(capabilities: Capabilities, options: RouteOptions = {}): Route {
	const requested = options.transport;
	if (requested === "chrome_bridge" || requested === undefined) {
		if (capabilities.bridge) return { kind: "chrome_bridge", launcher: capabilities.bridge.launcher };
		throw new NoTransportError(bridgeUnavailable(capabilities));
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
	throw new NoTransportError(`Unknown transport: ${requested}`);
}

function bridgeUnavailable(capabilities: Capabilities): string {
	if (capabilities.bridgeOffline) {
		return `Chrome Bridge is unavailable: ${capabilities.bridgeOffline.probe.reason ?? "the bridge did not answer"}. No foreground browser was launched. Retry after the lease or outage clears.`;
	}
	return `${setupGuidance(capabilities)}\nNo foreground browser was launched.`;
}

export function setupGuidance(capabilities: Capabilities): string {
	const lines = [
		"Chrome Bridge is required for the default GPT-Control web transport.",
		`  ${BRIDGE_REPO}`,
		"  Install it, open Chrome, and verify with `chrome-bridge ready`.",
	];
	if (!capabilities.oracle) lines.push("Optional legacy fallback: install Oracle and select oracle_browser explicitly.");
	lines.push("Oracle browser mode is never selected automatically because it can take focus.");
	return lines.join("\n");
}

export function describeCapabilities(capabilities: Capabilities): Record<string, unknown> {
	return {
		preferred: capabilities.bridge ? "chrome_bridge" : capabilities.bridgeOffline ? "chrome_bridge_unavailable" : "none",
		chromeBridge: capabilities.bridge
			? { available: true, origin: capabilities.bridge.launcher.origin, endpoint: capabilities.bridge.probe.endpoint }
			: capabilities.bridgeOffline
				? { available: false, installed: true, origin: capabilities.bridgeOffline.launcher.origin, reason: capabilities.bridgeOffline.probe.reason }
				: { available: false, installed: false, install: BRIDGE_REPO },
		oracle: capabilities.oracle
			? { available: true, explicitOnly: true, version: capabilities.oracle.version }
			: { available: false, explicitOnly: true },
		focusSafety: "Oracle browser mode requires allow_focus_steal=true and is never a fallback.",
	};
}
