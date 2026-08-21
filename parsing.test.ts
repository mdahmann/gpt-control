import { describe, expect, test } from "bun:test";
import { approvedImageUrl, decodeEntities, extractAssistantTurn, extractTabId, translatePolicyDenial, PolicyDeniedError } from "./src/chatgpt";
import { BridgeCommandError, parseCommandJson } from "./src/json";
import { buildOracleArgs, extractOracleAnswer } from "./src/oracle";

describe("assistant turn extraction", () => {
	test("reads only the final assistant turn", () => {
		const html = `
			<div data-message-author-role="assistant"><p>stale answer</p></div>
			<div data-message-author-role="user"><p>follow up</p></div>
			<div data-message-author-role="assistant"><p>fresh answer</p></div>`;
		expect(extractAssistantTurn(html).text).toBe("fresh answer");
	});

	test("keeps generated images and drops avatars and duplicates", () => {
		const html = `<img src="https://cdn.example/avatar.png">
			<div data-message-author-role="assistant">
				<img src="https://files.oaiusercontent.com/a.png?sig=1&amp;v=2">
				<img src="https://files.oaiusercontent.com/a.png?sig=1&amp;v=2">
				<img src="https://cdn.example/icon.svg">
			</div>`;
		expect(extractAssistantTurn(html).imageUrls).toEqual(["https://files.oaiusercontent.com/a.png?sig=1&v=2"]);
	});

	test("turns block markup into readable lines and strips scripts", () => {
		const html = `<div data-message-author-role="assistant">
			<p>First</p><script>ignored()</script><ul><li>one</li><li>two</li></ul><p>a &lt; b</p>
		</div>`;
		expect(extractAssistantTurn(html).text).toBe("First\n- one\n- two\na < b");
	});

	test("reports empty rather than throwing when no assistant turn exists", () => {
		expect(extractAssistantTurn("<div>loading</div>")).toEqual({ text: "", imageUrls: [] });
	});

	test("drops a spoofed host whose path merely contains the approved name", () => {
		const html = `<div data-message-author-role="assistant">
			<img src="http://169.254.169.254/latest/meta-data/oaiusercontent.com">
			<img src="https://evil.example/x.png?ref=files.oaiusercontent.com">
		</div>`;
		expect(extractAssistantTurn(html).imageUrls).toEqual([]);
	});
});

describe("image host validation", () => {
	test("accepts the approved hosts and their subdomains over HTTPS", () => {
		expect(approvedImageUrl("https://files.oaiusercontent.com/a.png")?.hostname).toBe("files.oaiusercontent.com");
		expect(approvedImageUrl("https://oaiusercontent.com/a.png")?.hostname).toBe("oaiusercontent.com");
		expect(approvedImageUrl("https://files.openai.com/a.png")?.hostname).toBe("files.openai.com");
	});

	test("rejects lookalike hosts, plaintext, and non-URLs", () => {
		// A suffix check without the dot boundary would accept the first of these.
		expect(approvedImageUrl("https://evil-oaiusercontent.com/a.png")).toBeUndefined();
		expect(approvedImageUrl("https://oaiusercontent.com.evil.example/a.png")).toBeUndefined();
		expect(approvedImageUrl("http://files.oaiusercontent.com/a.png")).toBeUndefined();
		expect(approvedImageUrl("file:///etc/passwd")).toBeUndefined();
		expect(approvedImageUrl("not a url")).toBeUndefined();
	});
});

describe("entity decoding", () => {
	test("handles named, decimal, and hex references", () => {
		expect(decodeEntities("a &amp; b &#39;q&#39; &#x27;r&#x27; &nbsp;end")).toBe("a & b 'q' 'r'  end");
	});

	test("leaves unknown references untouched", () => {
		expect(decodeEntities("&notreal; stays")).toBe("&notreal; stays");
	});
});

describe("bridge payload parsing", () => {
	const ok = { stdout: '{"success":true,"result":{"sessionId":"s1"}}', stderr: "", code: 0, killed: false };

	test("returns the payload on success", () => {
		expect(parseCommandJson(ok, "test")).toMatchObject({ success: true });
	});

	test("turns a success:false envelope into an error carrying the payload", () => {
		const result = { stdout: '{"success":false,"error":"boom"}', stderr: "", code: 0, killed: false };
		expect(() => parseCommandJson(result, "test")).toThrow("boom");
	});

	test("prefers stderr when the process fails without stdout", () => {
		const result = { stdout: "", stderr: "browser unavailable", code: 111, killed: false };
		expect(() => parseCommandJson(result, "test")).toThrow("browser unavailable");
	});

	test("rejects non-JSON output", () => {
		const result = { stdout: "not json", stderr: "", code: 0, killed: false };
		expect(() => parseCommandJson(result, "test")).toThrow("invalid JSON");
	});

	test("treats a nested result.success:false as a failure", () => {
		// The bridge reports page-action failures inside a success envelope; the
		// live `fill` miss that motivated this looked like an outright success.
		const result = {
			stdout: JSON.stringify({ success: true, result: { err: "No element found for selector #prompt-textarea", success: false } }),
			stderr: "",
			code: 0,
			killed: false,
		};
		expect(() => parseCommandJson(result, "fill")).toThrow("No element found for selector #prompt-textarea");
	});
});

describe("policy denial translation", () => {
	test("converts an egress denial into the exact grant command", () => {
		const error = new BridgeCommandError("denied", { policyDenial: { kind: "egress", client: "default" } });
		const translated = translatePolicyDenial(error);
		expect(translated).toBeInstanceOf(PolicyDeniedError);
		expect((translated as PolicyDeniedError).remediation).toBe("chrome-bridge policy allow-egress https://chatgpt.com default");
	});

	test("keeps a target denial retryable and never suggests widening policy", () => {
		const error = new BridgeCommandError("policy denied: tab origin unresolved", {
			policyDenial: { kind: "target", client: "default", remediation: "supply a valid url/domain/tabId" },
		});
		const translated = translatePolicyDenial(error);
		expect(translated).not.toBeInstanceOf(PolicyDeniedError);
		expect((translated as Error).message).toContain("supply a valid url/domain/tabId");
		expect((translated as Error).message).not.toContain("allow-origin");
	});

	test("passes through unrelated errors", () => {
		const error = new Error("network down");
		expect(translatePolicyDenial(error)).toBe(error);
	});
});
describe("tab id extraction", () => {
	test("finds the id across the shapes the bridge returns", () => {
		expect(extractTabId({ tabId: 7 })).toBe(7);
		expect(extractTabId({ result: { tabId: 8 } })).toBe(8);
		expect(extractTabId({ result: { tabIds: [9] } })).toBe(9);
		expect(extractTabId({ result: { tabs: [{ id: 10 }] } })).toBe(10);
		expect(extractTabId({ result: {} })).toBeUndefined();
	});
});

describe("oracle fallback", () => {
	test("locates the answer under nested keys", () => {
		expect(extractOracleAnswer({ result: { text: "hello" } })).toBe("hello");
		expect(extractOracleAnswer({ response: { message: { content: "deep" } } })).toBe("deep");
	});

	test("ignores empty strings so raw stdout can win", () => {
		expect(extractOracleAnswer({ text: "   " })).toBeUndefined();
	});

	test("builds root argv without --json, which the root command rejects", () => {
		expect(
			buildOracleArgs({ prompt: "why", engine: "api", model: "gpt-5.5", files: ["/a.ts"], followup: "sess_123" }),
		).toEqual(["--engine", "api", "--prompt", "why", "--model", "gpt-5.5", "--file", "/a.ts", "--followup", "sess_123"]);
	});

	test("omits every optional flag when it was not asked for", () => {
		expect(buildOracleArgs({ prompt: "why", engine: "browser" })).toEqual(["--engine", "browser", "--prompt", "why"]);
	});
});
