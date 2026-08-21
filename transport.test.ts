import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRIDGE_REPO,
	NoTransportError,
	describeCapabilities,
	resetCapabilityCache,
	resolveCapabilities,
	selectRoute,
	setupGuidance,
	type Capabilities,
} from "./src/capability";
import { findOnPath, resolveBridgeLauncher, resolveOracleLauncher, splitCommandLine } from "./src/transport";
import type { ExecResult } from "./src/types";

const scratch: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chatgpt-control-"));
	scratch.push(dir);
	return dir;
}

afterEach(() => {
	while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
	resetCapabilityCache();
});

function ok(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function fail(stderr: string, code = 1): ExecResult {
	return { stdout: "", stderr, code, killed: false };
}

const READY = JSON.stringify({ ready: true, endpoint: "127.0.0.1:9223", endpointStatus: "reachable", backend: "reachable", extension: "connected" });
const NOT_READY = JSON.stringify({ ready: false, endpointStatus: "refused", extension: "unavailable", reason: "browser unavailable" });

describe("command line splitting", () => {
	test("keeps quoted path segments together", () => {
		expect(splitCommandLine(`/usr/bin/python3 "/My Files/test_client.py"`)).toEqual(["/usr/bin/python3", "/My Files/test_client.py"]);
	});
});

describe("launcher discovery", () => {
	test("finds an executable on a synthetic PATH", () => {
		const dir = tempDir();
		const bin = join(dir, "chrome-bridge");
		writeFileSync(bin, "#!/bin/sh\n");
		chmodSync(bin, 0o755);
		expect(findOnPath("chrome-bridge", { PATH: dir })).toBe(bin);
		expect(findOnPath("chrome-bridge", { PATH: tempDir() })).toBeUndefined();
	});

	test("an explicit command line wins over everything else", () => {
		const launcher = resolveBridgeLauncher({ CHATGPT_CONTROL_BRIDGE: "/usr/bin/python3 /opt/bridge/test_client.py" });
		expect(launcher).toMatchObject({ command: "/usr/bin/python3", args: ["/opt/bridge/test_client.py"] });
	});

	test("falls back to a repository checkout when the CLI is not on PATH", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "test_client.py"), "print()\n");
		const python = join(tempDir(), "python3");
		writeFileSync(python, "#!/bin/sh\n");
		chmodSync(python, 0o755);

		const launcher = resolveBridgeLauncher({ PATH: join(python, ".."), CHROME_BRIDGE_HOME: dir, CHATGPT_CONTROL_PYTHON: python });
		expect(launcher).toMatchObject({ command: python, args: [join(dir, "test_client.py")], cwd: dir, origin: "CHROME_BRIDGE_HOME" });
	});

	test("reports nothing when no bridge exists", () => {
		expect(resolveBridgeLauncher({ PATH: tempDir(), HOME: tempDir(), CHATGPT_CONTROL_PYTHON: "/nonexistent" })).toBeUndefined();
	});

	test("never resolves oracle through npx", () => {
		expect(resolveOracleLauncher({ PATH: tempDir() })).toBeUndefined();
	});
});

describe("capability probing", () => {
	test("marks the bridge available when the extension is connected", async () => {
		const capabilities = await resolveCapabilities(async () => ok(READY), { CHATGPT_CONTROL_BRIDGE: "chrome-bridge" });
		expect(capabilities.bridge).toBeDefined();
		expect(capabilities.bridge?.probe.endpoint).toBe("127.0.0.1:9223");
	});

	test("separates installed-but-offline from absent", async () => {
		const capabilities = await resolveCapabilities(async () => ({ stdout: NOT_READY, stderr: "", code: 1, killed: false }), {
			CHATGPT_CONTROL_BRIDGE: "chrome-bridge",
		});
		expect(capabilities.bridge).toBeUndefined();
		expect(capabilities.bridgeOffline?.probe.reason).toBe("browser unavailable");
	});

	test("only accepts oracle when the binary actually runs", async () => {
		const capabilities = await resolveCapabilities(async () => fail("not found", 127), { CHATGPT_CONTROL_ORACLE: "oracle" });
		expect(capabilities.oracle).toBeUndefined();
	});
});

describe("route selection", () => {
	const bridge: Capabilities = { bridge: { launcher: { command: "chrome-bridge", args: [], origin: "test" }, probe: { ready: true } } };
	const oracleOnly: Capabilities = { oracle: { launcher: { command: "oracle", args: [], origin: "test" }, version: "0.17.1" } };

	test("prefers Chrome Bridge and stays silent about it", () => {
		const route = selectRoute(bridge);
		expect(route.kind).toBe("chrome-bridge");
		expect(route.notice).toBeUndefined();
	});

	test("falls back to Oracle and points at Chrome Bridge exactly once", () => {
		const first = selectRoute(oracleOnly);
		expect(first.kind).toBe("oracle-browser");
		expect(first.notice).toContain(BRIDGE_REPO);
		expect(selectRoute(oracleOnly).notice).toBeUndefined();
	});

	test("refuses paid API mode until it is confirmed", () => {
		expect(() => selectRoute(oracleOnly, { engine: "api" })).toThrow("api_confirmed=true");
		expect(selectRoute(oracleOnly, { engine: "api", apiConfirmed: true }).kind).toBe("oracle-api");
	});

	test("explains how to install when nothing is present", () => {
		expect(() => selectRoute({})).toThrow(NoTransportError);
		const guidance = setupGuidance({});
		expect(guidance).toContain(BRIDGE_REPO);
		expect(guidance).toContain("npm i -g @steipete/oracle");
	});

	test("an offline bridge is diagnosed instead of advertised as missing", () => {
		const guidance = setupGuidance({
			bridgeOffline: { launcher: { command: "chrome-bridge", args: [], origin: "chrome-bridge on PATH" }, probe: { ready: false, reason: "browser unavailable" } },
		});
		expect(guidance).toContain("browser unavailable");
		expect(guidance).toContain("chrome-bridge on PATH");
	});

	test("api mode without oracle steers back to the bridge rather than to an install", () => {
		expect(() => selectRoute(bridge, { engine: "api", apiConfirmed: true })).toThrow("omit engine=api");
	});
});

describe("capability reporting", () => {
	test("names the preferred transport and image support", () => {
		expect(describeCapabilities({})).toMatchObject({ preferred: "none", images: "requires Chrome Bridge" });
		const withBridge = describeCapabilities({
			bridge: { launcher: { command: "chrome-bridge", args: [], origin: "PATH" }, probe: { ready: true, endpoint: "127.0.0.1:9223" } },
		});
		expect(withBridge).toMatchObject({ preferred: "chrome-bridge", images: "supported" });
	});
});
