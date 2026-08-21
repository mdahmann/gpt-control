import { describe, expect, test } from "bun:test";
import { selectRoute, type Capabilities } from "./src/capability";
import { buildOracleArgs } from "./src/oracle";

const bridge = { launcher: { command: "chrome-bridge", args: [], origin: "test" }, probe: { ready: true } };
const oracle = { launcher: { command: "oracle", args: [], origin: "test" }, version: "0.17.1" };

describe("focus-safe ChatGPT web routing", () => {
	test("uses a live Chrome Bridge by default", () => {
		expect(selectRoute({ bridge }).kind).toBe("chrome_bridge");
	});

	test("does not launch Oracle when an installed bridge is temporarily leased", () => {
		const capabilities: Capabilities = {
			bridgeOffline: { launcher: bridge.launcher, probe: { ready: false, reason: "leased by another client" } },
			oracle,
		};
		expect(() => selectRoute(capabilities)).toThrow("No foreground browser was launched");
	});

	test("does not silently select Oracle when Chrome Bridge is absent", () => {
		expect(() => selectRoute({ oracle })).toThrow("Chrome Bridge is required");
	});

	test("requires explicit acknowledgement before Oracle browser mode", () => {
		expect(() => selectRoute({ oracle }, { transport: "oracle_browser" })).toThrow("allow_focus_steal=true");
		expect(selectRoute({ oracle }, { transport: "oracle_browser", allowFocusSteal: true }).kind).toBe("oracle_browser");
	});

	test("requires paid confirmation before Oracle API mode", () => {
		expect(() => selectRoute({ oracle }, { transport: "oracle_api" })).toThrow("api_confirmed=true");
		expect(selectRoute({ oracle }, { transport: "oracle_api", apiConfirmed: true }).kind).toBe("oracle_api");
	});
});

describe("Oracle explicit fallback argv", () => {
	test("uses only real root flags", () => {
		expect(buildOracleArgs({ prompt: "why", engine: "browser", followup: "sess_1" })).toEqual([
			"--engine", "browser", "--prompt", "why", "--followup", "sess_1",
		]);
		expect(buildOracleArgs({ prompt: "why", engine: "browser" })).not.toContain("--json");
	});
});
