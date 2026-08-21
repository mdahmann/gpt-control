import { probeBridge, probeOracle, resolveBridgeLauncher, resolveOracleLauncher, type BridgeProbe, type Launcher } from "./transport";
import type { Exec } from "./types";

export const BRIDGE_REPO = "https://github.com/wolfiesch/chrome-bridge";

export type RouteKind = "chrome-bridge" | "oracle-browser" | "oracle-api";

export interface Capabilities {
	bridge?: { launcher: Launcher; probe: BridgeProbe };
	/** Present when a Chrome Bridge client exists on disk but is not answering. */
	bridgeOffline?: { launcher: Launcher; probe: BridgeProbe };
	oracle?: { launcher: Launcher; version?: string };
}

export interface Route {
	kind: RouteKind;
	launcher: Launcher;
	/** Shown once per process when the chosen route is not the preferred one. */
	notice?: string;
}

const CACHE_TTL_MS = 60_000;
let cached: { at: number; value: Capabilities } | undefined;
const noticed = new Set<RouteKind>();

/** Test seam: forces the next resolution to re-probe. */
export function resetCapabilityCache(): void {
	cached = undefined;
	noticed.clear();
}

export async function resolveCapabilities(
	exec: Exec,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<Capabilities> {
	if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.value.bridge) return cached.value;

	const value: Capabilities = {};
	const bridgeLauncher = resolveBridgeLauncher(env);
	const oracleLauncher = resolveOracleLauncher(env);

	const [probe, version] = await Promise.all([
		bridgeLauncher ? probeBridge(exec, bridgeLauncher, signal).catch((): BridgeProbe => ({ ready: false, reason: "probe failed" })) : undefined,
		oracleLauncher ? probeOracle(exec, oracleLauncher, signal).catch(() => undefined) : undefined,
	]);

	if (bridgeLauncher && probe) {
		if (probe.ready) value.bridge = { launcher: bridgeLauncher, probe };
		else value.bridgeOffline = { launcher: bridgeLauncher, probe };
	}
	if (oracleLauncher && version) value.oracle = { launcher: oracleLauncher, version };

	cached = { at: Date.now(), value };
	return value;
}

function once(kind: RouteKind, notice: string): string | undefined {
	if (noticed.has(kind)) return undefined;
	noticed.add(kind);
	return notice;
}

export class NoTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoTransportError";
	}
}

/**
 * Picks the least disruptive transport that can serve the request.
 *
 * Chrome Bridge wins whenever it is live: it reuses the browser the user is
 * already signed into and never takes focus. Oracle's browser mode is correct
 * but drives its own Chrome, and the API path bills the user, so both are
 * announced the first time they are chosen.
 */
export function selectRoute(
	capabilities: Capabilities,
	options: { engine?: "browser" | "api"; apiConfirmed?: boolean } = {},
): Route {
	if (options.engine === "api") {
		if (!capabilities.oracle) throw new NoTransportError(missingOracleMessage(capabilities));
		if (!options.apiConfirmed) {
			throw new NoTransportError("Paid API mode bills your OpenAI key. Re-run with api_confirmed=true to authorise it.");
		}
		return { kind: "oracle-api", launcher: capabilities.oracle.launcher };
	}

	if (capabilities.bridge) return { kind: "chrome-bridge", launcher: capabilities.bridge.launcher };

	if (capabilities.oracle) {
		return {
			kind: "oracle-browser",
			launcher: capabilities.oracle.launcher,
			notice: once(
				"oracle-browser",
				`Running through Oracle's own Chrome, which can take window focus. Chrome Bridge would run this in a background tab of the Chrome you are already signed into: ${BRIDGE_REPO}`,
			),
		};
	}

	throw new NoTransportError(setupGuidance(capabilities));
}

function missingOracleMessage(capabilities: Capabilities): string {
	return capabilities.bridge
		? "Paid API mode needs the Oracle CLI (`npm i -g @steipete/oracle`). Chrome Bridge is available, so omit engine=api to use your signed-in ChatGPT session instead."
		: setupGuidance(capabilities);
}

/** The single place that teaches an unconfigured user what to install. */
export function setupGuidance(capabilities: Capabilities): string {
	const lines = ["No ChatGPT transport is available.", ""];

	if (capabilities.bridgeOffline) {
		const reason = capabilities.bridgeOffline.probe.reason ?? "the bridge did not answer";
		lines.push(
			`Chrome Bridge is installed at ${capabilities.bridgeOffline.launcher.origin} but is not responding: ${reason}`,
			"Open Chrome, confirm the bridge extension is enabled, then retry.",
			"",
		);
	} else {
		lines.push(
			"Recommended: Chrome Bridge drives the Chrome you are already signed into, in a background tab, with no remote-debugging flag and no focus stealing.",
			`  ${BRIDGE_REPO}`,
			"  git clone, run ./setup.sh, load the unpacked extension, then verify with `chrome-bridge ready`.",
			"",
		);
	}

	if (!capabilities.oracle) {
		lines.push(
			"Alternative: the Oracle CLI runs ChatGPT in its own browser, or against a paid API key.",
			"  npm i -g @steipete/oracle",
			"",
		);
	}

	lines.push(
		"Point this extension at a non-standard install with CHATGPT_CONTROL_BRIDGE, CHROME_BRIDGE_HOME, or CHATGPT_CONTROL_ORACLE.",
	);
	return lines.join("\n");
}

export function describeCapabilities(capabilities: Capabilities): Record<string, unknown> {
	return {
		preferred: capabilities.bridge ? "chrome-bridge" : capabilities.oracle ? "oracle-browser" : "none",
		chromeBridge: capabilities.bridge
			? { available: true, origin: capabilities.bridge.launcher.origin, endpoint: capabilities.bridge.probe.endpoint }
			: capabilities.bridgeOffline
				? { available: false, origin: capabilities.bridgeOffline.launcher.origin, reason: capabilities.bridgeOffline.probe.reason }
				: { available: false, reason: "no Chrome Bridge client found", install: BRIDGE_REPO },
		oracle: capabilities.oracle
			? { available: true, origin: capabilities.oracle.launcher.origin, version: capabilities.oracle.version }
			: { available: false, install: "npm i -g @steipete/oracle" },
		images: capabilities.bridge ? "supported" : "requires Chrome Bridge",
	};
}
