import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	assertRuntimeFilesStillTrusted,
	compactRunReceipt,
	assertInstalledServerInfo,
	assertRuntimeBundleMatch,
	inspectInstalledRuntime,
	runAcceptance,
	spawnTrustedRuntime,
	validatePoolAttestation,
	validateConcurrentReceipts,
} from "./scripts/chatgpt-desktop-acceptance.mjs";
import { sanitizeBrowserDriverEnv } from "./scripts/driver-env.mjs";

function uuidFor(index) {
	return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function validToolResult(index = 1) {
	return {
		isError: false,
		structuredContent: {
			conversationId: `conv_${index.toString(16).padStart(32, "0")}`,
			run: {
				runId: `run_${(index + 100).toString(16).padStart(32, "0")}`,
				status: "completed",
				receipt: {
					desktopPoolLane: index,
					browserDriverId: "chatgpt-desktop-pool/v1",
					localBrowserSessionId: `desktop-${uuidFor(index)}`,
					providerConversationId: `provider-chat-${index}`,
					providerConversationUrl: `https://chatgpt.com/c/provider-chat-${index}`,
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
		mode: "active",
		configuredSize: count,
		managedLaneCount: count,
		startPort: 9237,
		poolRootSha256: "f".repeat(64),
		attestedAt: "2026-08-23T12:00:00.000Z",
		lanes: Array.from({ length: count }, (_, offset) => ({
			lane: offset + 1,
			state: "active",
			sessionIds: [`desktop-${uuidFor(offset + 1)}`],
			listenerPid: 1000 + offset,
			port: 9237 + offset,
			profileSha256: String(offset + 1).repeat(64),
			browserInstanceId: `browser_${offset + 1}`,
			bundleId: "com.openai.codex",
			teamId: "2DC432GLL2",
		})),
	};
}

function offlineProof(count = 1) {
	return {
		driver: "chatgpt-desktop-pool/v1",
		mode: "offline",
		configuredSize: count,
		managedLaneCount: count,
		startPort: 9237,
		poolRootSha256: "f".repeat(64),
		attestedAt: "2026-08-23T12:00:00.000Z",
		lanes: Array.from({ length: count }, (_, offset) => ({
			lane: offset + 1,
			state: "offline",
			sessionIds: [],
			port: 9237 + offset,
			profileSha256: String(offset + 1).repeat(64),
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
				attestPool: async (_env, _root, action) => action === "attest_active" ? activeProof() : offlineProof(),
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

	test("records failure before releasing the lease when final runtime verification fails", async () => {
		const installRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-install-"));
		const stateRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-state-"));
		const launcher = join(installRoot, "launcher");
		const poolDriver = join(installRoot, "pool-driver");
		const statePath = join(stateRoot, "acceptance.json");
		const requestFile = privateRequest(stateRoot);
		writeFileSync(launcher, "launcher\n", { mode: 0o700 });
		writeFileSync(poolDriver, "pool\n", { mode: 0o700 });
		let runtimeChecks = 0;
		const client = {
			request: async (_method, params) => params.name === "gpt_chat" ? validToolResult() : { isError: false },
			close: async () => undefined,
		};
		try {
			await expect(runAcceptance([
				"--confirm", "--send", "--install-root", installRoot, "--request-file", requestFile,
			], {
				GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
				GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET: "1",
				GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STATE: statePath,
			}, {
				attestPool: async (_env, _root, action) => action === "attest_active" ? activeProof() : offlineProof(),
				startInstalledMcp: async () => ({
					client,
					initialized: { serverInfo: { name: "gpt-control", version: "test" } },
					launcher,
					poolDriver,
					stderr: () => "",
					assertRuntime: async () => {
						runtimeChecks += 1;
						if (runtimeChecks === 2) throw new Error("runtime changed before final receipt");
					},
				}),
			})).rejects.toThrow("runtime changed before final receipt");
			expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ state: "failed" });
			expect(() => readFileSync(`${statePath}.active`, "utf8")).toThrow();
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
			attestPool: async (_env, _root, action) => action === "attest_active" ? activeProof() : offlineProof(),
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

	test("rejects a provider URL whose embedded id differs from the durable provider id", () => {
		const value = validToolResult();
		value.structuredContent.run.receipt.providerConversationUrl = "https://chatgpt.com/c/different-provider-chat";
		expect(() => compactRunReceipt(value, { model: "Pro", effort: "High", fileCount: 0 })).toThrow("does not match");
	});

	test("strictly rejects malformed active and offline pool proofs", () => {
		const duplicate = activeProof(2);
		duplicate.lanes[1].lane = 1;
		expect(() => validatePoolAttestation(duplicate, "active", { expectedActiveCount: 2 })).toThrow("invalid or duplicate");
		const retained = offlineProof();
		retained.lanes[0].sessionIds = [`desktop-${uuidFor(1)}`];
		expect(() => validatePoolAttestation(retained, "offline")).toThrow("invalid offline-lane proof");
		const extra = offlineProof();
		extra.untrusted = true;
		expect(() => validatePoolAttestation(extra, "offline")).toThrow("unsupported fields");
		const malformedSession = validToolResult();
		malformedSession.structuredContent.run.receipt.localBrowserSessionId = "desktop-00000000-0000-0000-0000-000000000000";
		expect(() => compactRunReceipt(malformedSession, { model: "Pro", effort: "High", fileCount: 0 })).toThrow("invalid local browser-session identity");
		const malformedProof = activeProof();
		malformedProof.lanes[0].sessionIds = ["desktop-00000000-0000-0000-0000-000000000000"];
		expect(() => validatePoolAttestation(malformedProof, "active")).toThrow("invalid or duplicate lane identity");
	});

	test("uses the production driver environment allowlist for pool attestation", () => {
		const filtered = sanitizeBrowserDriverEnv({
			PATH: "/usr/bin",
			GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE: "6",
			CHROME_BRIDGE_HOST: "127.0.0.1",
			OPENAI_API_KEY: "must-not-leak",
			ARBITRARY_PRIVATE_SECRET: "must-not-leak",
		});
		expect(filtered).toEqual({
			PATH: "/usr/bin",
			GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE: "6",
			CHROME_BRIDGE_HOST: "127.0.0.1",
		});
	});

	test("rejects an in-root launcher changed after exact-head validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "gpt-control-runtime-tamper-"));
		const launcher = join(root, "launcher");
		try {
			writeFileSync(launcher, "trusted\n", { mode: 0o700 });
			const hash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update("trusted\n").digest("hex"));
			const info = statSync(launcher);
			const runtime = {
				files: { launcher },
				fileHashes: { launcher: hash },
				fileIdentities: { launcher: { dev: info.dev, ino: info.ino, size: info.size } },
			};
			await assertRuntimeFilesStillTrusted(runtime);
			writeFileSync(launcher, "tampered\n", { mode: 0o700 });
			await expect(assertRuntimeFilesStillTrusted(runtime)).rejects.toThrow("identity changed after trusted exact-head validation");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("kills a just-spawned runtime when its trusted file identity changes at dispatch", async () => {
		const root = mkdtempSync(join(tmpdir(), "gpt-control-runtime-spawn-race-"));
		const launcher = join(root, "launcher");
		try {
			writeFileSync(launcher, "trusted\n", { mode: 0o700 });
			const info = statSync(launcher);
			const hash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update("trusted\n").digest("hex"));
			const runtime = {
				files: { launcher },
				fileHashes: { launcher: hash },
				fileIdentities: { launcher: { dev: info.dev, ino: info.ino, size: info.size } },
			};
			let signal;
			const launched = await spawnTrustedRuntime(runtime, "launcher", [], {}, () => {
				writeFileSync(launcher, "changed\n", { mode: 0o700 });
				return { kill: (value) => { signal = value; } };
			});
			await expect(launched.trusted).rejects.toThrow("trusted exact head");
			expect(signal).toBe("SIGKILL");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
		expect(() => assertInstalledServerInfo({ serverInfo: { name: "gpt-control", version: "test" } })).toThrow("0.5.0-alpha.7");
		expect(() => assertRuntimeBundleMatch("dist/gpt-control-mcp.js", "a".repeat(64), "b".repeat(64))).toThrow("trusted exact head");
		expect(assertRuntimeBundleMatch("dist/gpt-control-mcp.js", "a".repeat(64), "a".repeat(64))).toBeUndefined();
	});
});
