import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resetCapabilityCache } from "./src/capability";
import { MAX_IMAGE_BYTES, fetchArtifact } from "./src/chatgpt";
import chatgptControl, { GENERATED_ROOT, mimeForPath, resolveOutputDir, sessionKind, sessionName } from "./src/index";
import type { ExecResult, ExtensionAPI, ToolDefinition, ToolResult } from "./src/types";

const READY = JSON.stringify({ endpointStatus: "reachable", extension: "connected", endpoint: "127.0.0.1:9223" });

interface Harness {
	tools: Map<string, ToolDefinition>;
	calls: string[][];
}

/** Minimal stand-in for a host that provides neither `zod` nor `exec`, like Pi. */
function harness(respond: (args: string[]) => ExecResult | undefined): Harness {
	const tools = new Map<string, ToolDefinition>();
	const calls: string[][] = [];
	const pi: ExtensionAPI = {
		registerTool: (definition) => tools.set(definition.name, definition),
		exec: async (_command, args) => {
			calls.push(args);
			return respond(args) ?? { stdout: '{"success":true,"result":{}}', stderr: "", code: 0, killed: false };
		},
	};
	chatgptControl(pi);
	return { tools, calls };
}

function ok(payload: unknown): ExecResult {
	return { stdout: JSON.stringify(payload), stderr: "", code: 0, killed: false };
}

function textOf(result: ToolResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => String(block.text))
		.join("\n");
}

/** Answers the full Chrome Bridge conversation for one submitted prompt. */
function bridgeResponder(answerHtml: string): (args: string[]) => ExecResult | undefined {
	return (args) => {
		const [action, second] = args;
		if (action === "ready") return { stdout: READY, stderr: "", code: 0, killed: false };
		if (action === "taskSession" && second === "create") return ok({ success: true, result: { sessionId: "sess-1" } });
		if (action === "taskSession" && second === "navigate") return ok({ success: true, result: { tabId: 42 } });
		if (action === "taskSession" && second === "show") {
			return ok({ success: true, result: { sessionId: "sess-1", state: "working", name: "chatgpt-control:consult:x", tabIds: [42] } });
		}
		if (action === "extractText") return ok({ success: true, result: { text: "settled page text" } });
		if (action === "getTabs") return ok({ success: true, result: { tabs: [{ id: 42, url: "https://chatgpt.com/c/abc" }] } });
		if (action === "getHTML") {
			writeFileSync(args[2], answerHtml);
			return ok({ success: true, result: {} });
		}
		return undefined;
	};
}

const savedEnv = { ...process.env };
let sandbox = "";

/**
 * Discovery reads PATH, HOME, and the filesystem, so every test starts from an
 * empty machine and opts into transports through the explicit env overrides.
 * Without this the suite passes or fails depending on what the developer has
 * installed.
 */
beforeEach(() => {
	resetCapabilityCache();
	sandbox = mkdtempSync(join(tmpdir(), "chatgpt-control-env-"));
	process.env.PATH = sandbox;
	process.env.HOME = sandbox;
	process.env.CHATGPT_CONTROL_PYTHON = join(sandbox, "absent-python");
	process.env.CHATGPT_CONTROL_POLL_MS = "1";
	delete process.env.CHATGPT_CONTROL_BRIDGE;
	delete process.env.CHATGPT_CONTROL_ORACLE;
	delete process.env.CHROME_BRIDGE_HOME;
	delete process.env.BRIDGE_REPO_ROOT;
	delete process.env.CHROME_BRIDGE_REPO;
});

afterEach(() => {
	process.env = { ...savedEnv };
	rmSync(sandbox, { recursive: true, force: true });
	resetCapabilityCache();
});

describe("registration", () => {
	test("registers the bounded four-tool surface on a host without zod or a label setter", () => {
		const { tools } = harness(() => undefined);
		expect([...tools.keys()]).toEqual(["chatgpt_consult", "chatgpt_chat", "chatgpt_image", "chatgpt_job"]);
	});

	test("marks inspection read-only and the acting tools as writes", () => {
		const { tools } = harness(() => undefined);
		expect(tools.get("chatgpt_job")?.approval).toBe("read");
		expect(tools.get("chatgpt_consult")?.approval).toBe("write");
		expect(tools.get("chatgpt_image")?.approval).toBe("write");
	});

	test("only sets an extension label on hosts that support the one-argument form", () => {
		const labels: string[] = [];
		const base = { registerTool: () => {}, setLabel: (label: string) => labels.push(label) };
		chatgptControl(base);
		expect(labels).toEqual([]);
		chatgptControl({ ...base, zod: {} });
		expect(labels).toEqual(["ChatGPT Control"]);
	});
});

describe("output location", () => {
	test("keeps generated files inside the extension directory unless waived", () => {
		expect(resolveOutputDir(undefined, undefined)).toBe(GENERATED_ROOT);
		expect(resolveOutputDir("campaign", undefined)).toBe(resolve(GENERATED_ROOT, "campaign"));
		expect(() => resolveOutputDir("/tmp/elsewhere", undefined)).toThrow("allow_external_output=true");
		expect(resolveOutputDir("/tmp/elsewhere", true)).toBe("/tmp/elsewhere");
	});

	test("expands a home-relative path before checking containment", () => {
		expect(() => resolveOutputDir("~/Desktop", undefined)).toThrow(resolve(homedir(), "Desktop"));
	});

	test("maps only real image extensions", () => {
		expect(mimeForPath("/a/b.png")).toBe("image/png");
		expect(mimeForPath("/a/b.WEBP")).toBe("image/webp");
		expect(mimeForPath("/a/b.txt")).toBeUndefined();
	});
});

describe("session naming", () => {
	test("round-trips the kind so a later process can classify a session", () => {
		expect(sessionKind(sessionName("image"))).toBe("image");
		expect(sessionKind(sessionName("consult"))).toBe("consult");
		expect(sessionKind("some-unrelated-tab")).toBeUndefined();
	});
});

describe("without any transport", () => {
	test("consult explains how to install rather than failing opaquely", async () => {
		const { tools } = harness(() => ({ stdout: "", stderr: "not found", code: 127, killed: false }));
		const result = await tools.get("chatgpt_consult")!.execute("c", { prompt: "hi" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("https://github.com/wolfiesch/chrome-bridge");
		expect(textOf(result)).toContain("npm i -g @steipete/oracle");
	});

	test("diagnose reports the gap without erroring", async () => {
		const { tools } = harness(() => ({ stdout: "", stderr: "not found", code: 127, killed: false }));
		const result = await tools.get("chatgpt_job")!.execute("c", { action: "diagnose" });
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({ preferred: "none", images: "requires Chrome Bridge" });
	});

	test("image generation names Chrome Bridge as the requirement", async () => {
		const { tools } = harness(() => ({ stdout: "", stderr: "not found", code: 127, killed: false }));
		const result = await tools.get("chatgpt_image")!.execute("c", { prompt: "a cat" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("needs Chrome Bridge");
	});
});

describe("oracle fallback", () => {
	test("answers through Oracle and points at Chrome Bridge exactly once", async () => {
		process.env.CHATGPT_CONTROL_ORACLE = "oracle";
		const { tools } = harness((args) => {
			if (args[0] === "ready") return { stdout: "", stderr: "refused", code: 111, killed: false };
			if (args[0] === "--version") return { stdout: "0.17.1", stderr: "", code: 0, killed: false };
			return ok({ text: "oracle says hello" });
		});
		const consult = tools.get("chatgpt_consult")!;

		const first = await consult.execute("c", { prompt: "hi" });
		expect(textOf(first)).toContain("oracle says hello");
		expect(textOf(first)).toContain("https://github.com/wolfiesch/chrome-bridge");

		const second = await consult.execute("c", { prompt: "hi again" });
		expect(textOf(second)).toContain("oracle says hello");
		expect(textOf(second)).not.toContain("https://github.com/wolfiesch/chrome-bridge");
	});

	test("refuses paid API mode until the caller confirms it", async () => {
		process.env.CHATGPT_CONTROL_ORACLE = "oracle";
		const { tools } = harness((args) => {
			if (args[0] === "ready") return { stdout: "", stderr: "refused", code: 111, killed: false };
			if (args[0] === "--version") return { stdout: "0.17.1", stderr: "", code: 0, killed: false };
			return ok({ text: "billed answer" });
		});
		const denied = await tools.get("chatgpt_consult")!.execute("c", { prompt: "hi", engine: "api" });
		expect(denied.isError).toBe(true);
		expect(textOf(denied)).toContain("api_confirmed=true");

		const allowed = await tools.get("chatgpt_consult")!.execute("c", { prompt: "hi", engine: "api", api_confirmed: true });
		expect(textOf(allowed)).toContain("billed answer");
	});
});

describe("chrome bridge path", () => {
	const html = '<div data-message-author-role="assistant"><p>bridge answer</p></div>';

	test("submits through a task session and returns the assistant turn", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools, calls } = harness(bridgeResponder(html));
		const result = await tools.get("chatgpt_consult")!.execute("c", { prompt: "review this" });

		expect(textOf(result)).toBe("bridge answer");
		expect(result.details).toMatchObject({ transport: "chrome-bridge", jobId: "sess-1", conversationUrl: "https://chatgpt.com/c/abc" });

		const flat = calls.map((args) => args.join(" "));
		expect(flat.some((line) => line.startsWith("taskSession create chatgpt-control:consult:"))).toBe(true);
		expect(flat).toContain("taskSession navigate sess-1 https://chatgpt.com");
		expect(flat).toContain("fill 42 #prompt-textarea review this");
		expect(flat).toContain('click 42 button[data-testid="send-button"]');
	});

	test("skips the upload step when no files are attached", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools, calls } = harness(bridgeResponder(html));
		await tools.get("chatgpt_consult")!.execute("c", { prompt: "review this" });
		expect(calls.some((args) => args[0] === "uploadFile")).toBe(false);
	});

	test("attaches files before submitting when they are supplied", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools, calls } = harness(bridgeResponder(html));
		await tools.get("chatgpt_consult")!.execute("c", { prompt: "review", files: ["/tmp/a.ts", "/tmp/b.ts"] });

		const upload = calls.findIndex((args) => args[0] === "uploadFile");
		const fill = calls.findIndex((args) => args[0] === "fill");
		expect(upload).toBeGreaterThanOrEqual(0);
		expect(upload).toBeLessThan(fill);
		expect(calls[upload]).toEqual(["uploadFile", "42", 'input[type="file"]', "/tmp/a.ts", "/tmp/b.ts"]);
	});

	test("returns a job id immediately when asked not to wait", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools, calls } = harness(bridgeResponder(html));
		const result = await tools.get("chatgpt_consult")!.execute("c", { prompt: "slow one", wait: false });

		expect(textOf(result)).toContain('chatgpt_job action="result" job_id="sess-1"');
		expect(calls.some((args) => args[0] === "extractText")).toBe(false);
	});

	test("continues an existing conversation instead of opening a new one", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools, calls } = harness(bridgeResponder(html));
		await tools.get("chatgpt_chat")!.execute("c", { prompt: "next turn", job_id: "sess-1" });
		expect(calls.some((args) => args[0] === "taskSession" && args[1] === "create")).toBe(false);
	});

	test("falls back through composer selectors when the first one is gone", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const base = bridgeResponder(html);
		const { tools, calls } = harness((args) => {
			if (args[0] === "fill" && args[2] === "#prompt-textarea") {
				// The shape the bridge actually returns for a missing element: a
				// success envelope wrapping a failed result.
				return ok({ success: true, result: { err: "No element found for selector #prompt-textarea", success: false } });
			}
			return base(args);
		});
		const result = await tools.get("chatgpt_consult")!.execute("c", { prompt: "hello" });

		expect(textOf(result)).toBe("bridge answer");
		expect(calls.some((args) => args[0] === "fill" && args[2] === 'div[contenteditable="true"]')).toBe(true);
	});

	test("retries a composer that is not ready yet instead of failing", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const base = bridgeResponder(html);
		let refusals = 0;
		const { tools } = harness((args) => {
			if (args[0] === "fill" && refusals < 4) {
				refusals += 1;
				return ok({
					success: false,
					error: "policy denied: tab origin unresolved",
					policyDenial: { kind: "target", client: "default", remediation: "supply a valid url/domain/tabId" },
				});
			}
			return base(args);
		});
		const result = await tools.get("chatgpt_consult")!.execute("c", { prompt: "hello" });

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe("bridge answer");
		expect(refusals).toBe(4);
	});

	test("surfaces the exact grant command when policy blocks the run", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools } = harness((args) => {
			if (args[0] === "ready") return { stdout: READY, stderr: "", code: 0, killed: false };
			if (args[0] === "taskSession" && args[1] === "navigate") {
				return ok({ success: false, error: "egress not allowed", policyDenial: { kind: "egress", client: "default" } });
			}
			return ok({ success: true, result: { sessionId: "sess-1" } });
		});
		const result = await tools.get("chatgpt_consult")!.execute("c", { prompt: "hi" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("chrome-bridge policy allow-egress https://chatgpt.com default");
	});

	test("closes only the session it was given", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools, calls } = harness(bridgeResponder(html));
		const result = await tools.get("chatgpt_job")!.execute("c", { action: "close", job_id: "sess-1" });
		expect(result.details).toMatchObject({ closed: true });
		expect(calls).toContainEqual(["taskSession", "close", "sess-1"]);
	});

	test("requires a job id for actions that address one", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const { tools } = harness(bridgeResponder(html));
		const result = await tools.get("chatgpt_job")!.execute("c", { action: "result" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("needs job_id");
	});
});

describe("image artifacts", () => {
	const imageHtml =
		'<div data-message-author-role="assistant"><p>here you go</p><img src="https://files.oaiusercontent.com/gen-1.png"></div>';
	const realFetch = globalThis.fetch;

	/** Bun types `fetch` with a `preconnect` member that a stub cannot supply. */
	const stubFetch = (handler: (input: RequestInfo | URL) => Promise<Response>): typeof fetch =>
		handler as unknown as typeof fetch;

	afterEach(async () => {
		globalThis.fetch = realFetch;
		await rm(resolve(GENERATED_ROOT, "sess-1-1.png"), { force: true });
		await rm(resolve(GENERATED_ROOT, "sess-1.png"), { force: true });
	});

	test("saves the pre-signed image to the output directory and returns it inline", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		const requested: string[] = [];
		globalThis.fetch = stubFetch(async (input) => {
			requested.push(String(input));
			return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
		});

		const { tools } = harness(bridgeResponder(imageHtml));
		const result = await tools.get("chatgpt_image")!.execute("c", { prompt: "a cat" });

		expect(requested).toEqual(["https://files.oaiusercontent.com/gen-1.png"]);
		expect(result.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
		expect(result.structuredContent).toMatchObject({ images: [resolve(GENERATED_ROOT, "sess-1-1.png")] });
	});

	test("falls back to a tab screenshot when the image cannot be fetched", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		globalThis.fetch = stubFetch(async () => new Response("nope", { status: 403 }));

		const base = bridgeResponder(imageHtml);
		const { tools } = harness((args) => {
			if (args[0] === "screenshot") {
				writeFileSync(args[2], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
				return ok({ success: true, result: {} });
			}
			return base(args);
		});
		const result = await tools.get("chatgpt_image")!.execute("c", { prompt: "a cat" });

		expect(result.isError).toBeUndefined();
		expect(result.content.some((block) => block.type === "image")).toBe(true);
		expect(result.structuredContent).toMatchObject({ images: [resolve(GENERATED_ROOT, "sess-1.png")] });
		expect(textOf(result)).toContain("HTTP 403");
	});

	test("never reaches the network when no image is present", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		let called = false;
		globalThis.fetch = stubFetch(async () => {
			called = true;
			return new Response("", { status: 200 });
		});

		const base = bridgeResponder('<div data-message-author-role="assistant"><p>no image here</p></div>');
		const { tools } = harness((args) => {
			if (args[0] === "screenshot") {
				writeFileSync(args[2], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
				return ok({ success: true, result: {} });
			}
			return base(args);
		});
		await tools.get("chatgpt_image")!.execute("c", { prompt: "a cat" });
		expect(called).toBe(false);
	});

	test("refuses a page-supplied host that only contains the approved name", async () => {
		process.env.CHATGPT_CONTROL_BRIDGE = "chrome-bridge";
		let reached = "";
		globalThis.fetch = stubFetch(async (input) => {
			reached = String(input);
			return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } });
		});

		// A response can render arbitrary markup, so the URL is attacker-controlled.
		const spoofed =
			'<div data-message-author-role="assistant"><img src="http://169.254.169.254/latest/meta-data/oaiusercontent.com"></div>';
		const base = bridgeResponder(spoofed);
		const { tools } = harness((args) => {
			if (args[0] === "screenshot") {
				writeFileSync(args[2], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
				return ok({ success: true, result: {} });
			}
			return base(args);
		});
		const result = await tools.get("chatgpt_image")!.execute("c", { prompt: "a cat" });

		expect(reached).toBe("");
		expect(result.details).toMatchObject({ imageUrls: [] });
	});

	test("refuses a redirect, a non-image body, and an oversized image", async () => {
		const destination = resolve(GENERATED_ROOT, "guard.png");
		const url = "https://files.oaiusercontent.com/gen-1.png";

		globalThis.fetch = stubFetch(async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/" } }));
		expect((await fetchArtifact(url, destination)).blocked).toContain("redirect");

		globalThis.fetch = stubFetch(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
		expect((await fetchArtifact(url, destination)).blocked).toContain("not an image");

		globalThis.fetch = stubFetch(
			async () =>
				new Response(new Uint8Array(8), {
					status: 200,
					headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) },
				}),
		);
		expect((await fetchArtifact(url, destination)).blocked).toContain("larger than");
	});

	test("caps a body that streams past the limit despite a small declared length", async () => {
		globalThis.fetch = stubFetch(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(new Uint8Array(1024 * 1024));
						},
					}),
					{ status: 200, headers: { "content-type": "image/png", "content-length": "8" } },
				),
		);
		const outcome = await fetchArtifact("https://files.oaiusercontent.com/gen-1.png", resolve(GENERATED_ROOT, "cap.png"));
		expect(outcome.blocked).toContain("larger than");
		expect(outcome.path).toBeUndefined();
	});
});
