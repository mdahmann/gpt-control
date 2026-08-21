import { resolveBrowserDriver, type DriverProbe, type WebChatDriver } from "./browser-driver";
import { probeOracle, resolveOracleLauncher, type Launcher } from "./transport";
import type { Provider } from "./domain";
import type { Exec } from "./types";

export type TransportChoice = Provider;

export interface Capabilities {
	browser?: { driver: WebChatDriver; probe: DriverProbe; source: string };
	browserOffline?: { probe: DriverProbe; source: string };
	oracle?: { launcher: Launcher; version?: string };
}

export interface Route {
	kind: Provider;
	driver?: WebChatDriver;
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
		cached = { at: Date.now(), value, positive: Boolean(value.browser || value.oracle) };
		return value;
	} finally {
		inFlight = undefined;
	}
}

async function probeCapabilities(exec: Exec, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Capabilities> {
	const value: Capabilities = {};
	const oracleLauncher = resolveOracleLauncher(env);
	const [browser, oracleVersion] = await Promise.all([
		resolveBrowserDriver(exec, env, signal),
		oracleLauncher ? probeOracle(exec, oracleLauncher, signal).catch(() => undefined) : undefined,
	]);
	if (browser.driver && browser.probe.ready) value.browser = { driver: browser.driver, probe: browser.probe, source: browser.source };
	else value.browserOffline = { probe: browser.probe, source: browser.source };
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

export function selectRoute(capabilities: Capabilities, options: RouteOptions = {}): Route {
	const requested = options.transport;
	if (requested === "browser" || requested === undefined) {
		if (capabilities.browser) return { kind: "browser", driver: capabilities.browser.driver };
		throw new NoTransportError(browserUnavailable(capabilities));
	}
	if (requested === "oracle_browser") {
		if (!options.allowFocusSteal) throw new NoTransportError("Oracle browser mode can foreground its own browser. Re-run with allow_focus_steal=true to choose it explicitly.");
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

function browserUnavailable(capabilities: Capabilities): string {
	return `${capabilities.browserOffline?.probe.reason ?? "No browser driver is ready."} No fallback browser was launched. Configure GPT_CONTROL_BROWSER_DRIVER or retry the current adapter.`;
}

export function describeCapabilities(capabilities: Capabilities): Record<string, unknown> {
	return {
		preferred: capabilities.browser ? "browser" : "browser_unavailable",
		browser: capabilities.browser
			? { available: true, driver: capabilities.browser.driver.id, source: capabilities.browser.source }
			: { available: false, driver: capabilities.browserOffline?.probe.driver ?? "none", source: capabilities.browserOffline?.source ?? "none", reason: capabilities.browserOffline?.probe.reason },
		oracle: capabilities.oracle
			? { available: true, explicitOnly: true, version: capabilities.oracle.version }
			: { available: false, explicitOnly: true },
		focusSafety: "No unavailable driver triggers another browser. Oracle browser mode requires allow_focus_steal=true.",
	};
}
