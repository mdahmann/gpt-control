import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRegularUploadFiles,
  canonicalProviderUrl,
  classifyDesktopMode,
  collectConversationIdentity,
  loadDesktopSession,
  loadSelectorConfig,
  normalizeText,
  parseLoopbackEndpoint,
  saveDesktopSession,
  sha256,
} from "./src/desktop-cdp-core.mjs";
import {
  assertSessionEnvelope,
  handleDriverRequest,
  requestedSelection,
} from "./src/desktop-cdp-driver.mjs";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sessionId: "desktop_0123456789abcdef0123456789abcdef",
    targetId: "target-a",
    windowId: 10,
    name: "gpt-control:test",
    providerUrl: "https://chatgpt.com/c/conversation-a",
    rendererUrl: "app://chatgpt",
    state: "working",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "desktop_0123456789abcdef0123456789abcdef",
    pageId: "target-a",
    name: "gpt-control:test",
    url: "https://chatgpt.com/c/conversation-a",
    ...overrides,
  };
}

describe("desktop CDP endpoint boundary", () => {
  test("accepts an explicit IPv4 loopback endpoint", () => {
    expect(parseLoopbackEndpoint("http://127.0.0.1:9236")).toEqual({ origin: "http://127.0.0.1:9236", hostname: "127.0.0.1", port: 9236 });
  });

  test("accepts localhost", () => {
    expect(parseLoopbackEndpoint("http://localhost:9222").port).toBe(9222);
  });

  test("rejects a remote host", () => {
    expect(() => parseLoopbackEndpoint("http://192.168.1.10:9222")).toThrow(/loopback/i);
  });

  test("rejects TLS and hidden credentials", () => {
    expect(() => parseLoopbackEndpoint("https://127.0.0.1:9222")).toThrow(/loopback HTTP/i);
    expect(() => parseLoopbackEndpoint("http://user:pass@127.0.0.1:9222")).toThrow(/credentials/i);
  });

  test("requires an explicit port and clean origin", () => {
    expect(() => parseLoopbackEndpoint("http://127.0.0.1")).toThrow(/explicit port/i);
    expect(() => parseLoopbackEndpoint("http://127.0.0.1:9222/json/list")).toThrow(/scheme.*host.*port/i);
  });
});

describe("provider conversation identity", () => {
  test("canonicalizes a direct conversation", () => {
    expect(canonicalProviderUrl("https://chatgpt.com/c/abc-123")).toBe("https://chatgpt.com/c/abc-123");
  });

  test("canonicalizes a project conversation", () => {
    expect(canonicalProviderUrl("https://chatgpt.com/g/project-x/c/abc-123")).toBe("https://chatgpt.com/c/abc-123");
  });

  test("rejects foreign origins and non-conversation routes", () => {
    expect(canonicalProviderUrl("https://example.com/c/abc")).toBeUndefined();
    expect(canonicalProviderUrl("https://chatgpt.com/")).toBeUndefined();
  });

  test("accepts one active evidence source without scanning generic sidebar links", () => {
    expect(collectConversationIdentity({
      locationHref: "app://chatgpt/index.html",
      canonicalHref: "",
      activeHref: "/c/exact-active",
      mainHref: "",
    })).toBe("https://chatgpt.com/c/exact-active");
  });

  test("fails closed on conflicting active evidence", () => {
    expect(() => collectConversationIdentity({ activeHref: "/c/a", mainHref: "/c/b" })).toThrow(/conflicting/i);
  });
});

describe("desktop surface and selector configuration", () => {
  test("classifies ChatGPT mode", () => {
    expect(classifyDesktopMode({ title: "ChatGPT" })).toBe("chatgpt");
    expect(classifyDesktopMode({ modeButtonLabel: "Switch to Codex" })).toBe("chatgpt");
  });

  test("classifies Codex mode", () => {
    expect(classifyDesktopMode({ title: "Codex" })).toBe("codex");
    expect(classifyDesktopMode({ modeButtonLabel: "Switch to ChatGPT" })).toBe("codex");
  });

  test("keeps unknown mode unknown", () => {
    expect(classifyDesktopMode({ title: "OpenAI" })).toBe("unknown");
  });

  test("accepts bounded trusted selector overrides", () => {
    const selectors = loadSelectorConfig({ GPT_CONTROL_DRIVER_SELECTORS_JSON: JSON.stringify({ composer: ["#custom"] }) });
    expect(selectors.composer).toEqual(["#custom"]);
    expect(selectors.send.length).toBeGreaterThan(0);
  });

  test("rejects unknown or malformed selector groups", () => {
    expect(() => loadSelectorConfig({ GPT_CONTROL_DRIVER_SELECTORS_JSON: JSON.stringify({ nope: ["x"] }) })).toThrow(/Unknown/i);
    expect(() => loadSelectorConfig({ GPT_CONTROL_DRIVER_SELECTORS_JSON: JSON.stringify({ composer: [] }) })).toThrow(/1-20/i);
  });
});

describe("selection and exact action envelopes", () => {
  test("normalizes string selection", () => {
    expect(requestedSelection("Pro")).toEqual({ model: "Pro" });
  });

  test("preserves model and effort selection", () => {
    expect(requestedSelection({ model: "GPT-5.6", effort: "High" })).toEqual({ model: "GPT-5.6", effort: "High" });
  });

  test("rejects an empty selection", () => {
    expect(() => requestedSelection({})).toThrow(/requires model or effort/i);
  });

  test("accepts an exact session envelope", () => {
    expect(() => assertSessionEnvelope(record(), session())).not.toThrow();
  });

  test("rejects page, name, and provider URL drift", () => {
    expect(() => assertSessionEnvelope(record(), session({ pageId: "target-b" }))).toThrow(/target id changed/i);
    expect(() => assertSessionEnvelope(record(), session({ name: "foreign" }))).toThrow(/name changed/i);
    expect(() => assertSessionEnvelope(record(), session({ url: "https://chatgpt.com/c/other" }))).toThrow(/drifted/i);
  });

  test("allows a root provider URL during the first conversation transition", () => {
    expect(() => assertSessionEnvelope(record(), session({ url: "https://chatgpt.com" }))).not.toThrow();
  });
});

describe("protocol dispatch", () => {
  test("rejects the wrong protocol version", async () => {
    await expect(handleDriverRequest({ version: 1, action: "probe", params: {} }, {} as any)).rejects.toThrow(/version 2/i);
  });

  test("rejects unknown actions", async () => {
    await expect(handleDriverRequest({ version: 2, action: "erase_everything", params: {} }, {} as any)).rejects.toThrow(/Unknown/i);
  });

  test("dispatches probe without widening parameters", async () => {
    const fake = { probe: async () => ({ ready: true, driver: "fake", secureInput: true, protocolVersion: 2 }) };
    expect(await handleDriverRequest({ version: 2, action: "probe", params: { ignored: true } }, fake as any)).toMatchObject({ ready: true, driver: "fake" });
  });

  test("dispatches create parameters exactly", async () => {
    let received: unknown;
    const fake = { create: async (params: unknown) => { received = params; return { sessionId: "x", pageId: "y", name: "z", url: "https://chatgpt.com" }; } };
    const params = { name: "gpt-control:test", url: "https://chatgpt.com" };
    await handleDriverRequest({ version: 2, action: "create", params }, fake as any);
    expect(received).toEqual(params);
  });
});

describe("durable state and file boundaries", () => {
  test("uses SHA-256 evidence and canonical whitespace", () => {
    expect(sha256("x")).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizeText(" a\n\n b \t c ")).toBe("a b c");
  });

  test("persists metadata without plaintext prompt fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-cdp-state-"));
    scratch.push(root);
    await saveDesktopSession(root, { ...record(), pendingPromptSha256: sha256("secret"), pendingPromptBytes: 6 });
    const loaded = await loadDesktopSession(root, record().sessionId as string);
    expect(loaded.pendingPromptSha256).toBe(sha256("secret"));
    expect(JSON.stringify(loaded)).not.toContain("secret");
  });

  test("rejects legacy or accidental plaintext prompt state", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-cdp-state-"));
    scratch.push(root);
    await saveDesktopSession(root, { ...record(), prompt: "do not persist" });
    await expect(loadDesktopSession(root, record().sessionId as string)).rejects.toThrow(/forbidden plaintext/i);
  });

  test("accepts regular upload files and rejects symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-cdp-files-"));
    scratch.push(root);
    const file = join(root, "file.txt");
    const link = join(root, "link.txt");
    await writeFile(file, "ok");
    await symlink(file, link);
    expect(await assertRegularUploadFiles([file])).toEqual([file]);
    await expect(assertRegularUploadFiles([link])).rejects.toThrow(/regular file/i);
  });
});
