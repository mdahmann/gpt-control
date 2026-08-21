# GPT-Control

A small cross-model review broker for coding agents.

GPT-Control lets one agent request, track, and verify an independent review from another model. Every submission receives a real `run_id`; every provider lineage receives a separate `conversation_id`. Reviews return structured findings, attachment hashes, and a provenance receipt.

An unofficial, community-maintained project. It is not affiliated with OpenAI.

## Current status

Experimental. The local contracts are tested, and Chrome Bridge plus Codex are exercised through private live checks. Browser markup can change, provider availability can change, and provider output remains advisory.

## Why this exists

The valuable part of a second opinion is the review protocol:

- Send only an explicit, bounded file set.
- Know which exact submission a result belongs to.
- Continue the right provider conversation without conflating it with a run.
- Receive findings with file and line evidence.
- Record prompt, attachment, and result hashes.
- Keep provider transport details behind one small tool surface.

## Tools

| Tool | Capability | Approval |
| --- | --- | --- |
| `gpt_consult` | Structured independent review with findings, manifest, and receipt | write |
| `gpt_chat` | Start or continue a provider conversation | write |
| `gpt_run` | Status, wait, or result for one exact run | read |
| `gpt_run_cancel` | Cancel an active in-process run | write |
| `gpt_conversation_close` | Close local conversation state and owned browser tabs | write |
| `gpt_image` | Chrome Bridge image generation and iteration | write |
| `gpt_diagnose` | Transport readiness and focus-safety state | read |

The same core tools are available through the bundled MCP server.

## Transports

| Transport | Use | Focus behavior | Confirmation |
| --- | --- | --- | --- |
| `chrome_bridge` | Signed-in ChatGPT, conversations, images | Inactive task-owned tab | None |
| `codex` | Official Codex SDK, structured review, conversations | No browser | None after Codex authentication |
| `responses` | Official Responses API, structured review, conversations | No browser | `api_confirmed=true` |
| `oracle_browser` | Explicit legacy browser fallback | May take focus | `allow_focus_steal=true` |
| `oracle_api` | Explicit legacy API fallback | No browser | `api_confirmed=true` |

Default routing is focus-safe:

1. Use Chrome Bridge when it is installed and ready.
2. If Chrome Bridge is installed but leased or unavailable, return a retryable error. GPT-Control does not launch Oracle.
3. If Chrome Bridge is not installed, use Codex when available.
4. Oracle browser mode is never selected automatically.

## Conversation and run model

```text
Conversation
  conversation_id
  provider
  provider conversation/thread/session id
  workspace root

Run
  run_id
  conversation_id
  prompt hash
  attachment manifest
  status
  exact provider result id
  result hash
  receipt
```

Pass `conversation_id` to `gpt_chat` or `gpt_consult` for a follow-up. Pass `run_id` to `gpt_run` for status, wait, or result. Per-conversation locking prevents two submissions from interleaving.

Records live under `~/.gpt-control/` by default. Override the root with `GPT_CONTROL_HOME`.

## Attachment boundary

By default, attachments must be regular files under the current workspace after symlink resolution. GPT-Control:

- resolves every path with `realpath()`;
- rejects directories and special files;
- caps file count and aggregate bytes;
- blocks obvious credential and private-key paths;
- hashes every file with SHA-256;
- returns the exact transmission manifest.

Outside-workspace and sensitive-file transmission require separate explicit flags.

## What leaves your machine

Prompts and approved attachments are sent to the selected provider. Chrome Bridge uploads files to the signed-in browser session. Codex reads the approved local paths in a read-only sandbox. Responses sends file content in the API request.

Closing a GPT-Control conversation closes local state and wrapper-owned browser tabs. It does not delete provider-side conversations, history, memories, or uploaded files.

## Structured review output

`gpt_consult` returns this contract:

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

Each result also includes a receipt with provider, model, timestamps, provider identifiers, prompt hash, attachment hashes, and result hash.

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

### Official transports

```sh
npm i -g @openai/codex
codex login
```

For Responses, provide `OPENAI_API_KEY` through your normal secret-injection path and pass `api_confirmed=true` on each paid request.

## Configuration

| Variable | Purpose |
| --- | --- |
| `GPT_CONTROL_HOME` | Local conversations, runs, locks, and generated artifacts |
| `GPT_CONTROL_BRIDGE` | Full Chrome Bridge client command |
| `CHROME_BRIDGE_HOME` | Chrome Bridge checkout containing `test_client.py` |
| `GPT_CONTROL_ORACLE` | Full Oracle CLI command |
| `GPT_CONTROL_PYTHON` | Python used to run the bridge client |
| `GPT_CONTROL_POLL_MS` | Browser answer poll interval, default 2000 |
| `GPT_CONTROL_PROBE_MS` | Bridge readiness budget, default 10000 |
| `GPT_CONTROL_RESPONSES_MODEL` | Responses model, default `gpt-5.6` |

## Credits

- [Oracle](https://github.com/steipete/oracle) by Peter Steinberger is the explicit legacy fallback.
- [Kyle McCleary](https://github.com/kmccleary3301) shared the Oracle fork and browser/image workflow that prompted the first version of this wrapper.
- [Chrome Bridge](https://github.com/wolfiesch/chrome-bridge) provides the focus-safe signed-in browser transport.
- The official Codex and Responses adapters use OpenAI's published SDKs.

## Development

```sh
bun install
bun run check
bun test
```

## License

MIT
