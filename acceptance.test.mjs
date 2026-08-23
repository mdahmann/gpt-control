import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAcceptance } from "./scripts/chatgpt-desktop-acceptance.mjs";

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

	test("refuses the source checkout as live acceptance evidence", async () => {
		await expect(runAcceptance([
			"--confirm", "--send", "--install-root", resolve("."),
		], {
			GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
		})).rejects.toThrow("installed package");
	});

	test("fails installed-product acceptance when archive and close cleanup fail", async () => {
		const installRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-install-"));
		const stateRoot = mkdtempSync(join(tmpdir(), "gpt-control-acceptance-state-"));
		const launcher = join(installRoot, "launcher");
		const poolDriver = join(installRoot, "pool-driver");
		writeFileSync(launcher, "launcher\n", { mode: 0o700 });
		writeFileSync(poolDriver, "pool\n", { mode: 0o700 });
		chmodSync(launcher, 0o700);
		const client = {
			request: async (_method, params) => {
				if (params.name === "gpt_chat") return {
					structuredContent: {
						conversationId: "conv_test",
						run: {
							runId: "run_test",
							status: "completed",
							receipt: { desktopPoolLane: 1 },
							manifest: { sha256: "a".repeat(64) },
						},
					},
				};
				throw new Error(`${params.name} refused`);
			},
			close: async () => undefined,
		};
		try {
			await expect(runAcceptance([
				"--confirm", "--send", "--install-root", installRoot,
			], {
				GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
				GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STATE: join(stateRoot, "acceptance.json"),
			}, {
				assertPoolOffline: async () => ({ lanes: [] }),
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
		writeFileSync(launcher, "launcher\n", { mode: 0o700 });
		writeFileSync(poolDriver, "pool\n", { mode: 0o700 });
		let releaseStart;
		const waitForRelease = new Promise((resolveRelease) => { releaseStart = resolveRelease; });
		let signalStarted;
		const started = new Promise((resolveStarted) => { signalStarted = resolveStarted; });
		const client = {
			request: async (_method, params) => {
				if (params.name === "gpt_chat") return {
					structuredContent: {
						conversationId: "conv_test",
						run: {
							runId: "run_test",
							status: "completed",
							receipt: { desktopPoolLane: 1 },
							manifest: { sha256: "a".repeat(64) },
						},
					},
				};
				return { isError: false };
			},
			close: async () => undefined,
		};
		const env = {
			GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE: "I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS",
			GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STATE: join(stateRoot, "acceptance.json"),
		};
		let starts = 0;
		const dependencies = {
			assertPoolOffline: async () => ({ lanes: [] }),
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
			const first = runAcceptance(["--confirm", "--send", "--install-root", installRoot], env, dependencies);
			await started;
			await expect(runAcceptance(["--confirm", "--send", "--install-root", installRoot], env, dependencies)).rejects.toThrow("Another live acceptance attempt is active");
			expect(starts).toBe(1);
			releaseStart();
			await first;
		} finally {
			releaseStart();
			rmSync(installRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});
