#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMacDesktopCdpEnvironment } from "./desktop-cdp-macos";
import { handleDesktopDriverRequest, type DesktopDriverRequest } from "./desktop-driver";

const limit = 16 * 1024 * 1024;
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	raw += chunk;
	if (Buffer.byteLength(raw, "utf8") > limit) {
		process.stdout.write(`${JSON.stringify({ version: 2, ok: false, error: "Desktop driver request exceeded 16 MiB." })}\n`);
		process.exit(0);
	}
});
process.stdin.on("end", async () => {
	let request: DesktopDriverRequest;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid request shape");
		request = parsed as DesktopDriverRequest;
	} catch {
		process.stdout.write(`${JSON.stringify({ version: 2, ok: false, error: "Desktop driver received invalid JSON." })}\n`);
		return;
	}
	const stateRoot = resolve(process.env.GPT_CONTROL_DRIVER_DESKTOP_STATE_ROOT
		?? resolve(homedir(), ".gpt-control", "desktop-driver-v1"));
	let response = await handleDesktopDriverRequest(request, {
		environment: createMacDesktopCdpEnvironment(process.env),
		stateRoot,
		allowCreateTarget: process.env.GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET === "1",
	});
	if (request.action === "probe" && response.ok && response.result && typeof response.result === "object") {
		const bundlePath = fileURLToPath(import.meta.url);
		const bundleSha256 = createHash("sha256").update(await readFile(bundlePath)).digest("hex");
		response = {
			...response,
			result: {
				...response.result,
				runtimeExecutable: process.execPath,
				runtimeBundlePath: bundlePath,
				runtimeBundleSha256: bundleSha256,
			},
		};
	}
	process.stdout.write(`${JSON.stringify(response)}\n`);
});
