import { describe, expect, test } from "bun:test";
import { selectRoute, type Capabilities } from "./src/capability";
import { buildOracleArgs } from "./src/oracle";
import { runCodexTurn, runResponsesTurn, type CodexFactory, type ResponsesClient } from "./src/providers";
import { REVIEW_OUTPUT_SCHEMA, type AttachmentManifest } from "./src/domain";

const emptyManifest: AttachmentManifest = { workspaceRoot: "/tmp", files: [], totalBytes: 0, sha256: "0".repeat(64) };
const bridge = { launcher: { command: "chrome-bridge", args: [], origin: "test" }, probe: { ready: true } };
const oracle = { launcher: { command: "oracle", args: [], origin: "test" }, version: "0.17.1" };

describe("focus-safe route selection", () => {
	test("prefers a live Chrome Bridge", () => {
		expect(selectRoute({ bridge, codex: { origin: "PATH" } }).kind).toBe("chrome_bridge");
	});

	test("does not launch Oracle when an installed bridge is temporarily leased", () => {
		const capabilities: Capabilities = {
			bridgeOffline: { launcher: bridge.launcher, probe: { ready: false, reason: "leased by another client" } },
			oracle,
			codex: { origin: "PATH" },
		};
		expect(() => selectRoute(capabilities)).toThrow("No foreground browser was launched");
	});

	test("requires an explicit acknowledgement before Oracle browser mode", () => {
		expect(() => selectRoute({ oracle }, { transport: "oracle_browser" })).toThrow("allow_focus_steal=true");
		expect(selectRoute({ oracle }, { transport: "oracle_browser", allowFocusSteal: true }).kind).toBe("oracle_browser");
	});

	test("uses official Codex only when no bridge is installed", () => {
		expect(selectRoute({ codex: { origin: "PATH", version: "codex 1" } }).kind).toBe("codex");
	});

	test("requires paid confirmation for Responses", () => {
		expect(() => selectRoute({ responses: { available: true } }, { transport: "responses" })).toThrow("api_confirmed=true");
		expect(selectRoute({ responses: { available: true } }, { transport: "responses", apiConfirmed: true }).kind).toBe("responses");
	});
});

describe("Codex SDK adapter", () => {
	test("starts a thread with a structured schema and returns its real thread id", async () => {
		let outputSchema: unknown;
		const factory: CodexFactory = {
			create: () => ({
				startThread: () => ({
					id: "thread_123",
					run: async (_input, options) => {
						outputSchema = options?.outputSchema;
						return { items: [{ id: "msg_1", type: "agent_message" }], finalResponse: '{"verdict":"approve","summary":"ok","findings":[],"openQuestions":[]}', usage: { input_tokens: 1 } };
					},
				}),
				resumeThread: () => { throw new Error("not expected"); },
			}),
		};
		const result = await runCodexTurn({ kind: "consult", prompt: "review", manifest: emptyManifest }, factory);
		expect(result.providerConversationId).toBe("thread_123");
		expect(result.providerRunId).toBe("msg_1");
		expect(outputSchema).toEqual(REVIEW_OUTPUT_SCHEMA);
	});

	test("resumes the exact Codex thread for a follow-up", async () => {
		let resumed = "";
		const factory: CodexFactory = {
			create: () => ({
				startThread: () => { throw new Error("not expected"); },
				resumeThread: (id) => {
					resumed = id;
					return { id, run: async () => ({ items: [], finalResponse: "continued", usage: null }) };
				},
			}),
		};
		await runCodexTurn({ kind: "chat", prompt: "next", manifest: emptyManifest, providerConversationId: "thread_abc" }, factory);
		expect(resumed).toBe("thread_abc");
	});
});

describe("Responses API adapter", () => {
	test("uses structured outputs and chains the previous response id", async () => {
		let body: Record<string, unknown> = {};
		const client: ResponsesClient = {
			responses: {
				create: async (request) => {
					body = request;
					return { id: "resp_2", model: "gpt-5.6", output_text: '{"verdict":"approve","summary":"ok","findings":[],"openQuestions":[]}' };
				},
			},
		};
		const result = await runResponsesTurn({ kind: "consult", prompt: "review", manifest: emptyManifest, providerConversationId: "resp_1" }, client);
		expect(body.previous_response_id).toBe("resp_1");
		expect(body.text).toMatchObject({ format: { type: "json_schema", strict: true } });
		expect(result.providerConversationId).toBe("resp_2");
	});
});

describe("Oracle legacy adapter", () => {
	test("uses only real root flags", () => {
		expect(buildOracleArgs({ prompt: "why", engine: "browser", followup: "sess_1" })).toEqual([
			"--engine", "browser", "--prompt", "why", "--followup", "sess_1",
		]);
		expect(buildOracleArgs({ prompt: "why", engine: "browser" })).not.toContain("--json");
	});
});
