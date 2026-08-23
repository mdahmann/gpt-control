import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const roots = [];

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("raw desktop smoke cleanup", () => {
	test("does not print archive success when exact close fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "gpt-control-raw-smoke-"));
		roots.push(root);
		const driver = join(root, "fake-driver.mjs");
		const request = join(root, "request.json");
		writeFileSync(driver, `#!/usr/bin/env node
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const message = JSON.parse(raw);
let result;
if (message.action === "probe") result = { pool: { size: 1 } };
else if (message.action === "create") result = { sessionId: "session-1", pageId: "page-1", name: message.params.name, url: message.params.url };
else if (message.action === "manage_conversation") result = { archived: true, verifiedAt: new Date().toISOString() };
else if (message.action === "close") {
  process.stdout.write(JSON.stringify({ version: 2, ok: false, error: "close failed" }) + "\\n");
  process.exit(0);
} else result = {};
process.stdout.write(JSON.stringify({ version: 2, ok: true, result }) + "\\n");
`, { mode: 0o700 });
		chmodSync(driver, 0o700);
		writeFileSync(request, JSON.stringify({ archiveUrl: "https://chatgpt.com/c/disposable-test" }), { mode: 0o600 });
		let error;
		try {
			await execFileAsync(process.execPath, [resolve("scripts/desktop-cdp-live-smoke.mjs"), "--request-file", request], {
				env: {
					...process.env,
					GPT_CONTROL_BROWSER_DRIVER: driver,
					GPT_CONTROL_DESKTOP_LIVE_MUTATION: "1",
				},
				encoding: "utf8",
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeDefined();
		expect(String(error.stderr)).toContain("close failed");
		expect(String(error.stdout)).not.toContain('"mode": "archive"');
	});
});
