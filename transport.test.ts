import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalCommandBrowserDriver, type WebChatDriver } from "./src/browser-driver";
import { selectRoute, type Capabilities } from "./src/capability";
import { buildOracleArgs } from "./src/oracle";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "gpt-driver-test-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const driver: WebChatDriver = {
	id: "test-driver",
	probe: async () => ({ ready: true, driver: "test-driver" }),
	create: async (name, url) => ({ sessionId: "s", pageId: "p", name, url }),
	show: async () => ({ sessionId: "s", pageId: "p", name: "gpt-control:chat:x", url: "https://chatgpt.com/c/1" }),
	upload: async () => undefined,
	submit: async () => undefined,
	snapshot: async () => ({ count: 1, text: "ok", imageUrls: [] }),
	setState: async () => undefined,
	close: async () => undefined,
	screenshot: async () => undefined,
};
const oracle = { launcher: { command: "oracle", args: [], origin: "test" }, version: "0.17.1" };

describe("browser-agnostic routing", () => {
	test("uses any ready browser driver by default", () => {
		expect(selectRoute({ browser: { driver, probe: { ready: true, driver: driver.id }, source: "test" } }).kind).toBe("browser");
	});

	test("does not launch another browser when the configured driver is unavailable", () => {
		const capabilities: Capabilities = {
			browserOffline: { probe: { ready: false, driver: "custom", reason: "leased" }, source: "env" },
			oracle,
		};
		expect(() => selectRoute(capabilities)).toThrow("No fallback browser was launched");
	});

	test("requires explicit acknowledgement before Oracle browser mode", () => {
		expect(() => selectRoute({ oracle }, { transport: "oracle_browser" })).toThrow("allow_focus_steal=true");
		expect(selectRoute({ oracle }, { transport: "oracle_browser", allowFocusSteal: true }).kind).toBe("oracle_browser");
	});
});

describe("external browser driver protocol", () => {
	test("sends versioned requests on stdin and validates responses", async () => {
		const root = scratch();
		const script = join(root, "driver.js");
		writeFileSync(script, `#!/usr/bin/env bun
const input = await Bun.stdin.text();
const request = JSON.parse(input);
let result;
const session = { sessionId: "s1", pageId: "p1", name: "gpt-control:chat:x", url: "https://chatgpt.com/c/1" };
if (request.action === "probe") result = { ready: true, driver: "fixture" };
else if (request.action === "create") result = { ...session, name: request.params.name, url: request.params.url };
else if (request.action === "show") result = session;
else if (request.action === "snapshot") result = { count: 1, text: "answer", imageUrls: [] };
else if (request.action === "screenshot") result = request.params.outputPath;
else result = {};
console.log(JSON.stringify({ version: 1, ok: true, result }));
`);
		chmodSync(script, 0o755);
		const external = new ExternalCommandBrowserDriver(script);
		expect(await external.probe()).toEqual({ ready: true, driver: "fixture" });
		const session = await external.create("gpt-control:chat:x", "https://chatgpt.com");
		expect(session).toMatchObject({ sessionId: "s1", pageId: "p1" });
		expect(await external.show("s1")).toMatchObject({ url: "https://chatgpt.com/c/1" });
		await external.upload(session, ["/tmp/a.ts"]);
		await external.submit(session, "secret prompt carried on stdin");
		expect(await external.snapshot(session)).toEqual({ count: 1, text: "answer", imageUrls: [] });
		await external.setState("s1", "completed");
		expect(await external.screenshot(session, "/tmp/out.png")).toBe("/tmp/out.png");
		await external.close("s1");
	});

	test("rejects invalid or failed driver envelopes", async () => {
		const root = scratch();
		const script = join(root, "driver.js");
		writeFileSync(script, `#!/usr/bin/env bun
console.log(JSON.stringify({ version: 1, ok: false, error: "driver refused" }));
`);
		chmodSync(script, 0o755);
		await expect(new ExternalCommandBrowserDriver(script).probe()).rejects.toThrow("driver refused");
	});
});

describe("Oracle explicit fallback argv", () => {
	test("uses only real root flags", () => {
		expect(buildOracleArgs({ prompt: "why", engine: "browser", followup: "sess_1" })).toEqual(["--engine", "browser", "--prompt", "why", "--followup", "sess_1"]);
	});
});
