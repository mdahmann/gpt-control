# GPT-Control

Let any CLI agent harness control the signed-in ChatGPT web UI.

GPT-Control gives OMP, Pi, MCP clients, and other compatible harnesses a small typed tool surface for ChatGPT conversations, structured reviews, and image iteration. The harness can run whatever model the user prefers; GPT-Control opens an inactive tab in the Chrome profile already signed into ChatGPT.

An unofficial, community-maintained project. It is not affiliated with OpenAI.

## Why this exists

A user may already have access to powerful web-only ChatGPT models through a subscription. Calling the API or wrapping `codex exec` is a different product and duplicates capabilities the agent harness already has.

GPT-Control focuses on one job:

```text
any CLI harness
      │ typed tool call
      ▼
GPT-Control
      │ Chrome Bridge
      ▼
signed-in ChatGPT web UI
```

This provides high included web usage without per-call API billing. ChatGPT still applies temporary and plan-level usage limits; GPT-Control does not describe the service as literally unlimited.

## Focus behavior

Chrome Bridge opens an inactive, task-owned tab in the existing browser window. It does not open a remote-debugging browser or focus a new window.

If Chrome Bridge is leased, asleep, or unavailable, GPT-Control returns a retryable error. It never treats a bridge outage as permission to launch another browser.

Oracle browser mode remains an explicit legacy fallback for users who choose it. It requires both:

```json
{
  "transport": "oracle_browser",
  "allow_focus_steal": true
}
```

## Tools

| Tool | Capability | Approval |
| --- | --- | --- |
| `gpt_consult` | Structured ChatGPT review with findings, manifest, and receipt | write |
| `gpt_chat` | Start or continue a ChatGPT web conversation | write |
| `gpt_run` | Status, wait, or result for one exact submission | read |
| `gpt_run_cancel` | Cancel an active in-process run | write |
| `gpt_conversation_close` | Close local state and wrapper-owned browser tabs | write |
| `gpt_image` | Generate or iterate on images | write |
| `gpt_diagnose` | Report browser transport readiness without starting work | read |

The core review, conversation, run, close, and diagnosis tools are also available through the bundled MCP server.

## Conversations and runs

GPT-Control keeps provider lineage separate from individual submissions:

```text
conversation_id → one ChatGPT conversation
run_id          → one exact submitted prompt
```

Pass `conversation_id` to `gpt_chat`, `gpt_consult`, or `gpt_image` for a follow-up. Pass `run_id` to `gpt_run` for status, wait, or result.

Per-conversation locking prevents two turns from interleaving. Records live under `~/.gpt-control/` by default.

## Attachment boundary

Attachments are explicit and auditable. GPT-Control:

- resolves paths through `realpath()`;
- defaults to regular files inside the workspace;
- rejects symlink escapes;
- caps file count and aggregate bytes;
- blocks obvious credential and private-key paths;
- hashes every file with SHA-256;
- returns the exact upload manifest.

Outside-workspace and sensitive-file uploads require separate explicit flags.

## Structured review output

`gpt_consult` asks ChatGPT for a validated review object:

```json
{
  "verdict": "request_changes",
  "summary": "The migration is not rollback-safe.",
  "findings": [
    {
      "severity": "high",
      "claim": "The old schema version is discarded before mutation.",
      "evidence": {
        "file": "src/migrate.ts",
        "lineStart": 81,
        "lineEnd": 104
      },
      "confidence": 0.92,
      "remediation": "Persist the old schema version before mutation."
    }
  ],
  "openQuestions": []
}
```

Each run also records provider identifiers, timestamps, prompt hash, attachment hashes, and result hash.

## Data boundary

Prompts and approved attachments leave the local machine and are uploaded to the signed-in ChatGPT session.

Closing a GPT-Control conversation closes local state and wrapper-owned browser tabs. It does not delete ChatGPT history, memories, conversations, or uploaded files.

## Install

### Oh My Pi

```sh
omp install github:wolfiesch/gpt-control
```

### Pi

```sh
git clone https://github.com/wolfiesch/gpt-control.git
cd gpt-control && bun install
ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/gpt-control.ts
```

### MCP

```json
{
  "mcpServers": {
    "gpt-control": {
      "command": "bun",
      "args": ["/path/to/gpt-control/src/mcp.ts"]
    }
  }
}
```

### Chrome Bridge

```sh
git clone https://github.com/wolfiesch/chrome-bridge.git
cd chrome-bridge && ./setup.sh
chrome-bridge ready
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `GPT_CONTROL_HOME` | Local conversations, runs, locks, and generated artifacts |
| `GPT_CONTROL_BRIDGE` | Full Chrome Bridge client command |
| `CHROME_BRIDGE_HOME` | Chrome Bridge checkout containing `test_client.py` |
| `GPT_CONTROL_PYTHON` | Python used to run the bridge client |
| `GPT_CONTROL_POLL_MS` | Browser answer poll interval, default 2000 |
| `GPT_CONTROL_PROBE_MS` | Bridge readiness budget, default 10000 |
| `GPT_CONTROL_ORACLE` | Optional explicit Oracle CLI command |

## Credits

- [Kyle McCleary](https://github.com/kmccleary3301) shared the Oracle fork and web/image workflow that prompted the first version.
- [Oracle](https://github.com/steipete/oracle) by Peter Steinberger remains an explicit legacy fallback.
- [Chrome Bridge](https://github.com/wolfiesch/chrome-bridge) provides the focus-safe signed-in browser transport.

## Development

```sh
bun install
bun run check
bun test
```

## License

MIT
