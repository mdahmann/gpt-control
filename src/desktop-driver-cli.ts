#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createMacDesktopCdpEnvironment } from "./desktop-cdp-macos";
import { handleDesktopDriverRequest, type DesktopDriverRequest } from "./desktop-driver";

const limit = 16 * 1024 * 1024;
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	raw += chunk;
	if (Buffer.byteLength(raw, "utf8") > limit) {
		process.stdout.write(`${JSON.stringify({ version: 2, ok: false, error: "Desktop driver request exceeded 16 MiB." })}\n`);
		process.exit(1);
	}
});
process.stdin.on("end", async () => {
	let request: DesktopDriverRequest;
	try {
		request = JSON.parse(raw) as DesktopDriverRequest;
	} catch {
		process.stdout.write(`${JSON.stringify({ version: 2, ok: false, error: "Desktop driver received invalid JSON." })}\n`);
		process.exitCode = 1;
		return;
	}
	const stateRoot = resolve(process.env.GPT_CONTROL_DRIVER_DESKTOP_STATE_ROOT
		?? resolve(homedir(), ".gpt-control", "desktop-driver-v1"));
	const response = await handleDesktopDriverRequest(request, {
		environment: createMacDesktopCdpEnvironment(process.env),
		stateRoot,
		allowCreateTarget: process.env.GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET === "1",
	});
	process.stdout.write(`${JSON.stringify(response)}\n`);
	if (!response.ok) process.exitCode = 1;
});
