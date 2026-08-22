# GPT-Control

GPT-Control lets OMP, Pi, Codex, and other MCP-capable harnesses control the
signed-in ChatGPT website through one secure browser-driver protocol. Version
0.3.1 adds exact-conversation ownership, crash-safe durable runs, truthful live
Pro-model evidence, immutable attachment snapshots, and up to three independent
ChatGPT Pro workers with one completion or blocker result each.

The caller remains the orchestrator. GPT-Control does not merge code, widen
repository authority, infer connected-tool access, launch a paid fallback, or
open a replacement browser when the configured driver is unavailable.

## Core guarantees

- **Exact conversation:** driver, session, ownership name, page, origin,
  canonical `/c/<id>` URL, and assistant-turn baseline are recorded and
  rechecked.
- **No ambiguous replay:** plaintext recovery data is removed before the browser
  click. A restart can observe a submitted turn but cannot resubmit it.
- **Crash-safe cancellation:** cancellation is terminal and immutable before a
  provider stop. Restart retries any pending exact-turn stop before it resumes
  work. Late completion cannot overwrite cancellation.
- **Truthful model provenance:** ChatGPT Pro is selected and read back from the
  live composer, then verified again immediately before send.
- **Immutable attachments:** uploads use private broker-owned snapshots with
  hashes and line counts, not mutable workspace paths.
- **No hidden fallback:** the configured secure browser driver either works or
  the run returns a blocker. Oracle argv transport, paid API fallback, and
  focus-stealing fallback are disabled.

## Browser-driver protocol v2

A driver must communicate with JSON requests on stdin (or an equivalent private
RPC), return strict version-2 envelopes, attest secure input, and implement:

- probe, create, show, navigate;
- upload and fill as separate preparation steps;
- live model select and verify;
- send as a separate crash boundary;
- observe, recover, set state, close, and screenshot.

Set `GPT_CONTROL_BROWSER_DRIVER` to an external protocol-v2 command. When that
is absent, GPT-Control may use an installed Chrome Bridge adapter, but only when
its private request-file RPC is available. Prompt text and snapshot paths are
never passed through child-process argv.

## Tools

| Tool | Purpose |
|---|---|
| `gpt_consult` | Structured independent review with evidence, manifest, and receipt |
| `gpt_chat` | Start or continue one exact ChatGPT conversation |
| `gpt_conversation_attach` | Open an exact existing ChatGPT conversation in a new owned background tab |
| `gpt_image` | Generate or iterate on an image with confined local output |
| `gpt_run` | Read, wait for, or retrieve one durable run |
| `gpt_run_cancel` | Durably cancel any active run |
| `gpt_run_abandon_pending` | Operator-authenticated release of an unresolved provider slot after manual review |
| `gpt_run_claim` | Operator-authenticated claim or transfer of a run's authoritative conversation owner, including all bound tasks |
| `gpt_conversation_close` | Close an owned local browser session; provider history remains |
| `gpt_subagent_run` | Start one independent bounded ChatGPT Pro worker |
| `gpt_subagent_get` | One reconnect/recovery lookup for a worker |
| `gpt_subagent_cancel` | Durably cancel a worker |
| `gpt_subagent_list` | Bounded recovery overview, not a polling loop |
| `gpt_diagnose` | Passive configuration report; executes nothing discovered |
| `gpt_diagnose_active` | Explicit active driver smoke test when trusted policy permits |

## Codex Pro workers

`gpt_subagent_run` requires an idempotency key and creates a fresh owned
conversation. Trusted policy defaults to six simultaneous workers and permits
an operator-configured limit from one through ten, even across broker processes
sharing the same state root. Additional workers queue fairly.

## Existing ChatGPT conversations

`gpt_conversation_attach` accepts exactly one canonical
`https://chatgpt.com/c/<id>` URL or provider conversation ID. It opens that URL
in a new GPT-Control-owned background tab, proves the exact session, page, URL,
and ready composer, and returns a local `conversationId`. It does not send a
message and it does not adopt or mutate a foreground tab. Use the returned ID
with `gpt_chat`; each new send still selects and verifies Pro immediately before
submission. `gpt_conversation_close` closes only the owned local tab. The
provider conversation remains in ChatGPT history.

Chat Manager or another thread inventory can help a Codex orchestrator find an
exact URL, but GPT-Control does not load or depend on Chat Manager at runtime.
Titles, previews, and prior conversation text are untrusted discovery context,
not new instructions.

The MCP server advertises optional task execution through the installed MCP SDK.
Task-capable clients can use task status/result/cancel. The run is durably bound
before `taskCreated`, then a short cancellation grace elapses before browser
execution; normal completion requires no status polling. Clients without task
support receive one long-running terminal tool response. GPT-Control does not
assume a task notification can awaken a dormant chat thread; the durable run and
task IDs are the recovery mechanism.

Multiplexed MCP transports bind task listing, reads, results, and cancellation
to the creating transport session. Broker-internal restart recovery remains
able to reconcile all durable tasks. A submitted provider turn retains worker
capacity until it becomes final or the exact turn is proved inactive.

A worker can request connected tools:

```json
{
  "prompt": "Inspect the current pull request and report a blocker or result.",
  "idempotency_key": "review-pr-184-v1",
  "connectors": ["GitHub"],
  "connector_mode": "require"
}
```

Connector names express prompt intent only. They do not grant permission or
prove availability. GPT-Control cannot observe ChatGPT connector tool calls, so
every connector-enabled result reports `connectorVerification.status` as
`unverified`. The worker is instructed to return a blocker when a required
connector is unavailable, but the caller must independently verify the actual
connector call and evidence before accepting the result.

## Conversations, runs, and receipts

Each submission has a wrapper-owned `conversation_id` and a distinct `run_id`.
Provider IDs are recorded separately from local driver/session IDs. A follow-up
is refused unless the canonical provider conversation and exact local ownership
tuple can be proven.

Receipts distinguish requested model from observed model and include live model
evidence, prompt and result hashes, snapshot receipts, provider conversation and
turn identifiers, timestamps, driver ID, and bounded recovery attempts.

## Attachment boundary

The trusted workspace defaults to the process working directory. GPT-Control
realpath-resolves each request, rejects symlinks and non-regular files, opens
without following links, checks for mutation before and after read, caps count
and bytes, hashes content, and creates a private mode-0400 snapshot. Only that
snapshot is uploaded.

Tool input cannot authorize outside-workspace or sensitive-file access. Set
trusted environment policy deliberately when such access is required. Files
leave the local machine and enter the provider conversation; closing local state
does not delete provider-side history or uploads.

## Install

### Bun and dependencies

```bash
bun install --frozen-lockfile
bun run build:mcp
bun run check
bun test
```

The repository commits a reproducible Node-compatible MCP bundle at
`dist/gpt-control-mcp.js`. Codex plugin snapshots therefore start on macOS,
Linux, and Windows without `node_modules`, a shell launcher, or an install hook.
The plugin and package command use `node` on PATH. The optional Unix launcher
`bin/gpt-control-mcp` honors `GPT_CONTROL_NODE`. Bun is required only to develop,
test, and reproduce the committed bundle.

### OMP / Pi

Install or link the package according to the host's extension workflow. Both
read `src/index.ts` from the `omp`/`pi` package metadata.

### MCP

```bash
node ./dist/gpt-control-mcp.js
```

For Codex, the repository includes `.codex-plugin/plugin.json`, `.mcp.json`,
and the committed Node bundle. The MCP server is started from the plugin root
with a 3,700-second per-tool bound so a one-hour worker can return its terminal
result. Plugin installation does not run a package manager or trust an
unverified build step.

## Trusted configuration

| Variable | Meaning |
|---|---|
| `GPT_CONTROL_HOME` | Private schema-v3 state root; default `~/.gpt-control/v3` |
| `GPT_CONTROL_WORKSPACE_ROOT` | Attachment authority root |
| `GPT_CONTROL_SNAPSHOT_ROOT` | Immutable snapshot root |
| `GPT_CONTROL_OUTPUT_ROOT` | Generated artifact root |
| `GPT_CONTROL_BROWSER_DRIVER` | External protocol-v2 command |
| `GPT_CONTROL_BRIDGE` | Explicit Chrome Bridge launcher |
| `GPT_CONTROL_BRIDGE_PRIVATE_RPC` | Explicit private-RPC helper command |
| `GPT_CONTROL_MAX_PRO_WORKERS` | Operator-selected worker ceiling from 1–10; default 6 |
| `GPT_CONTROL_MAX_ATTACHMENT_FILES` | Trusted file-count cap |
| `GPT_CONTROL_MAX_ATTACHMENT_BYTES` | Trusted aggregate-byte cap |
| `GPT_CONTROL_MAX_PROMPT_BYTES` | Trusted prompt-byte cap |
| `GPT_CONTROL_ALLOW_OUTSIDE_WORKSPACE` | Trusted outside-root authorization (`1`) |
| `GPT_CONTROL_ALLOW_SENSITIVE_FILES` | Trusted sensitive-file authorization (`1`) |
| `GPT_CONTROL_ALLOW_ACTIVE_DIAGNOSTICS` | Permit active driver probing (`1`) |
| `GPT_CONTROL_PROVIDER_ABANDON_TOKEN` | Secret operator token, at least 32 characters, required for unresolved provider-turn abandonment |
| `GPT_CONTROL_POLL_MS` | Browser observation interval |

Schema v3 refuses to start when schema-v2 run or conversation records remain in
the legacy default state root. Resolve or stop any old provider turns first,
then follow [docs/UPGRADE_V2.md](docs/UPGRADE_V2.md).

See [SECURITY.md](SECURITY.md), [MIGRATION.md](MIGRATION.md), and
[docs/CODEX_SUBAGENTS.md](docs/CODEX_SUBAGENTS.md).

## Development

```bash
bun install --frozen-lockfile
bun run build:mcp
bun run check
bun test
bash scripts/verify-security.sh
npm pack --dry-run --json
```

Live browser validation must use disposable data and a disposable profile or
session. Follow [docs/MANUAL_CHROME_VALIDATION.md](docs/MANUAL_CHROME_VALIDATION.md).

## License

MIT
