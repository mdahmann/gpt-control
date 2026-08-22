import { BROWSER_DRIVER_PROTOCOL_VERSION, resolveBrowserDriver, type DriverProbe, type WebChatDriver } from "./browser-driver";
import type { Provider } from "./domain";
import type { Exec } from "./types";

export type TransportChoice = Provider | "oracle_browser" | "oracle_api";

export interface Capabilities {
	browser?: { driver: WebChatDriver; probe: DriverProbe; source: string };
	browserOffline?: { probe: DriverProbe; source: string };
}

export interface Route {
	kind: "browser";
	driver: WebChatDriver;
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
		cached = { at: Date.now(), value, positive: Boolean(value.browser) };
		return value;
	} finally {
		inFlight = undefined;
	}
}

async function probeCapabilities(exec: Exec, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Capabilities> {
	const value: Capabilities = {};
	const browser = await resolveBrowserDriver(exec, env, signal);
	if (browser.driver && browser.probe.ready && browser.probe.secureInput) {
		value.browser = { driver: browser.driver, probe: browser.probe, source: browser.source };
	} else {
		value.browserOffline = { probe: browser.probe, source: browser.source };
	}
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
	/** Legacy request fields are intentionally ignored as authority. */
	apiConfirmed?: boolean;
	allowFocusSteal?: boolean;
}

export function selectRoute(capabilities: Capabilities, options: RouteOptions = {}): Route {
	const requested = options.transport ?? "browser";
	if (requested !== "browser") {
		throw new NoTransportError(
			`Transport ${requested} is disabled by the hardened 0.3 broker because its current CLI request path exposes sensitive data through argv.`,
		);
	}
	if (capabilities.browser) return { kind: "browser", driver: capabilities.browser.driver };
	throw new NoTransportError(browserUnavailable(capabilities));
}

function browserUnavailable(capabilities: Capabilities): string {
	return `${capabilities.browserOffline?.probe.reason ?? "No secure browser driver is ready."} No fallback browser or paid API was launched.`;
}

export function describeCapabilities(capabilities: Capabilities): Record<string, unknown> {
	return {
		preferred: capabilities.browser ? "browser" : "browser_unavailable",
		browser: capabilities.browser
			? {
				available: true,
				driver: capabilities.browser.driver.id,
				source: capabilities.browser.source,
				protocolVersion: BROWSER_DRIVER_PROTOCOL_VERSION,
				secureInput: true,
			}
			: {
				available: false,
				driver: capabilities.browserOffline?.probe.driver ?? "none",
				source: capabilities.browserOffline?.source ?? "none",
				reason: capabilities.browserOffline?.probe.reason,
				protocolVersion: BROWSER_DRIVER_PROTOCOL_VERSION,
				secureInput: false,
			},
		oracle: {
			available: false,
			executionEnabled: false,
			reason: "Legacy Oracle CLI request data is argv-visible; active probing and execution are disabled.",
		},
		focusSafety: "No unavailable driver triggers another browser. No focus-stealing fallback is executed.",
	};
}
