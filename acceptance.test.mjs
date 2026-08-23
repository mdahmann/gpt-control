import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	compactRunReceipt,
	assertInstalledServerInfo,
	assertRuntimeBundleMatch,
	inspectInstalledRuntime,
	runAcceptance,
	validateConcurrentReceipts,
} from "./scripts/chatgpt-desktop-acceptance.mjs";

function validToolResult(index = 1) {
	return {
		isError: false,
		structuredContent: {
			conversationId: `conv_${index}`,
			run: {
				runId: `run_${index}`,
				status: "completed",
				receipt: {
					desktopPoolLane: index,
					browserDriverId: "chatgpt-desktop-pool/v1",
					localBrowserSessionId: `session_${index}`,
					providerConversationId: `provider_${index}`,
					providerConversationUrl: `https://chatgpt.com/c/provider_${index}`,
					requestedModel: "Pro",
					observedModel: "Pro",
					requestedEffort: "High",
					observedEffort: "High",
					modelVerified: true,
					modelEvidenceKind: "composer_selector",
				},
				manifest: { sha256: "a".repeat(64), files: [] },
			},
		},
	};
}

function activeProof(count = 1) {
	return {
		driver: "chatgpt-desktop-pool/v1",
		lanes: Array.from({ length: count }, (_, offset) => ({
			lane: offset + 1,
			state: "active",
			sessionIds: [`session_${offset + 1}`],
			listenerPid: 1000 + offset,
			port: 9237 + offset,
			profileSha256: String(offset + 1).repeat(64),
			browserInstanceId: `browser_${offset + 1}`,
		})),
	};
}

function privateRequest(root) {
	const path = join(root, "request.json");
	writeFileSync(path, JSON.stringify({ model: "Pro", effort: "High" }), { mode: 0o600 });
	return path;
}

describe("desktop live-acceptance safety gate", () => {
	test("defaults to one installed-product call and documents the cooldown", async () => {
		const result = await runAcceptance(["--help"], {});
		expect(result.warning).toContain("defaults to one chat");
		expect(result.warning).toContain("24-hour local cooldown");
	});

	test("requires an explicit stress gate for multiple sessions", async () => {
		await expect(runAcceptance(["--confirm", "--send", "--count", "2"], {})).rejects.toThrow("--stress");
	});

	test("refuses live activity before opening the installed MCP without the exact acknowledgement", async () => {
		await expect(runAcceptance([
			"--confirm", "--send", "--install-root", resolve("."),
		], {})).rejects.toThrow("GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE");
	});

	test("requires separate exact renderer-creation authority", async () => {
		await expect(runAcceptance([
			"--confirm", "--send", "--install-root", resolve("."),
		], {
			GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
		})).rejects.toThrow("GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1");
	});

	test("refuses the source checkout as live acceptance evidence", async () => {
		await expect(runAcceptance([
			"--confirm", "--send", "--install-root", resolve("."),
		], {
			GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
			GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET: "1",
		})).rejects.toThrow("installed package");
	});

	test("fails installed-product acceptance when archive and close cleanup fail", async () => {
		const installRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-install-"));
		const stateRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-state-"));
		const launcher = join(installRoot, "launcher");
		const poolDriver = join(installRoot, "pool-driver");
		const requestFile = privateRequest(stateRoot);
		writeFileSync(launcher, "launcher\n", { mode: 0o700 });
		writeFileSync(poolDriver, "pool\n", { mode: 0o700 });
		chmodSync(launcher, 0o700);
		const client = {
			request: async (_method, params) => {
				if (params.name === "gpt_chat") return validToolResult();
				throw new Error(`${params.name} refused`);
			},
			close: async () => undefined,
		};
		try {
			await expect(runAcceptance([
				"--confirm", "--send", "--install-root", installRoot, "--request-file", requestFile,
			], {
				GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
				GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET: "1",
				GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STATE: join(stateRoot, "acceptance.json"),
			}, {
				attestPool: async (_env, _root, action) => action === "attest_active" ? activeProof() : ({ lanes: [] }),
				startInstalledMcp: async () => ({
					client,
					initialized: { serverInfo: { name: "gpt-control", version: "test" } },
					launcher,
					poolDriver,
					stderr: () => "",
				}),
			})).rejects.toThrow("cleanup blocker");
		} finally {
			rmSync(installRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	test("fences concurrent live acceptance before a second MCP can start", async () => {
		const installRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-install-"));
		const stateRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-state-"));
		const launcher = join(installRoot, "launcher");
		const poolDriver = join(installRoot, "pool-driver");
		const requestFile = privateRequest(stateRoot);
		writeFileSync(launcher, "launcher\n", { mode: 0o700 });
		writeFileSync(poolDriver, "pool\n", { mode: 0o700 });
		let releaseStart;
		const waitForRelease = new Promise((resolveRelease) => { releaseStart = resolveRelease; });
		let signalStarted;
		const started = new Promise((resolveStarted) => { signalStarted = resolveStarted; });
		const client = {
			request: async (_method, params) => {
				if (params.name === "gpt_chat") return validToolResult();
				return { isError: false };
			},
			close: async () => undefined,
		};
		const env = {
			GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
			GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET: "1",
			GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STATE: join(stateRoot, "acceptance.json"),
		};
		let starts = 0;
		const dependencies = {
			attestPool: async (_env, _root, action) => action === "attest_active" ? activeProof() : ({ lanes: [] }),
			startInstalledMcp: async () => {
				starts += 1;
				signalStarted();
				await waitForRelease;
				return {
					client,
					initialized: { serverInfo: { name: "gpt-control", version: "test" } },
					launcher,
					poolDriver,
					stderr: () => "",
				};
			},
		};
		try {
			const first = runAcceptance(["--confirm", "--send", "--install-root", installRoot, "--request-file", requestFile], env, dependencies);
			await started;
			await expect(runAcceptance(["--confirm", "--send", "--install-root", installRoot, "--request-file", requestFile], env, dependencies)).rejects.toThrow("Another live acceptance attempt is active");
			expect(starts).toBe(1);
			releaseStart();
			await first;
		} finally {
			releaseStart();
			rmSync(installRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	test("rejects duplicate lanes and missing exact identities in concurrency evidence", () => {
		const first = compactRunReceipt(validToolResult(1), { model: "Pro", effort: "High", fileCount: 0 });
		const secondValue = validToolResult(2);
		secondValue.structuredContent.run.receipt.desktopPoolLane = 1;
		const second = compactRunReceipt(secondValue, { model: "Pro", effort: "High", fileCount: 0 });
		expect(() => validateConcurrentReceipts([first, second], activeProof(2), 2)).toThrow("distinct desktop-pool lanes");
	});

	test("rejects a successful-looking receipt from the wrong driver or without model proof", () => {
		const wrongDriver = validToolResult();
		wrongDriver.structuredContent.run.receipt.browserDriverId = "chatgpt-desktop-cdp/v1";
		expect(() => compactRunReceipt(wrongDriver, { model: "Pro", effort: "High", fileCount: 0 })).toThrow("desktop-pool driver");
		const noProof = validToolResult();
		delete noProof.structuredContent.run.receipt.modelVerified;
		expect(() => compactRunReceipt(noProof, { model: "Pro", effort: "High", fileCount: 0 })).toThrow("model proof");
	});

	test("rejects attachment proof that does not match the exact requested bytes", () => {
		const value = validToolResult();
		value.structuredContent.run.manifest.files = [{ sha256: "a".repeat(64) }];
		expect(() => compactRunReceipt(value, {
			model: "Pro",
			effort: "High",
			fileCount: 1,
			attachmentSha256s: ["b".repeat(64)],
		})).toThrow("exact requested file bytes");
	});

	test("rejects an installed launcher symlink that escapes its install root", async () => {
		const installRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-install-"));
		const outside = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-outside-"));
		try {
			writeFileSync(join(outside, "launcher"), "outside\n", { mode: 0o700 });
			await import("node:fs/promises").then(({ mkdir }) => mkdir(join(installRoot, "bin"), { recursive: true }));
			symlinkSync(join(outside, "launcher"), join(installRoot, "bin", "gpt-control-mcp"));
			await expect(inspectInstalledRuntime(installRoot, {})).rejects.toThrow("escapes the installed package root");
		} finally {
			rmSync(installRoot, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("rejects a wrong installed server version and a mismatched runtime bundle", () => {
		expect(() => assertInstalledServerInfo({ serverInfo: { name: "gpt-control", version: "test" } })).toThrow("0.5.0-alpha.5");
		expect(() => assertRuntimeBundleMatch("dist/gpt-control-mcp.js", "a".repeat(64), "b".repeat(64))).toThrow("trusted exact head");
		expect(assertRuntimeBundleMatch("dist/gpt-control-mcp.js", "a".repeat(64), "a".repeat(64))).toBeUndefined();
	});
});
