# GPT-Control

GPT-Control lets OMP, Pi, Codex, and other MCP-capable harnesses control the
signed-in ChatGPT website through one secure browser-driver protocol. Version
0.5.0-alpha.8 hardens the opt-in pool of separate signed macOS ChatGPT/Codex app
processes for background workers. Each lane has a private profile, state root,
and loopback CDP port; GPT-Control minimizes the worker window and restores the
user's active app after launch. Chrome Bridge remains the default. Version 0.4.4
added durable model and project catalogs so ordinary catalog reads do not
open Chrome. Version 0.5.0-alpha.8 replaces automatic rate-limit recovery with
a durable human-resume safety pause. Version 0.4.3 originally added shared rate-limit cooldown, ChatGPT
project-conversation recovery, and bounded Codex callback retry. Version 0.4.2 added immediate-return single
and batch Worker starts with verified Codex callback binding. Version 0.4.1 added project-aware Worker titles, durable caller detachment, and
same-conversation required-connector preflight. Version 0.4.0 added live model
and effort discovery, exact-conversation organization,
crash-safe durable runs, and three clear orchestration routes: GPT Chat, GPT
Worker, and GPT Sub-agent.

The caller remains the orchestrator. GPT-Control does not merge code, widen
repository authority, infer connected-tool access, launch a paid fallback, or
open a replacement browser when the configured driver is unavailable.

## Core guarantees

- **Exact conversation:** driver, session, ownership name, page, origin,
  canonical `/c/<id>` identity, and assistant-turn baseline are recorded and
  rechecked. A visible `/g/<project>/c/<id>` route resolves to the same identity.
- **No ambiguous replay:** plaintext recovery data is removed before the browser
  click. A restart can observe a submitted turn but cannot resubmit it.
- **Crash-safe cancellation:** cancellation is terminal and immutable before a
  provider stop. Restart retries any pending exact-turn stop before it resumes
  work. Late completion cannot overwrite cancellation.
- **Truthful model provenance:** the requested live ChatGPT model and effort are
  selected and read back from the composer, then verified again immediately
  before send.
- **Quiet catalog reads:** ordinary model and project discovery reads durable
  cache files and never opens Chrome. Only an explicit `refresh: true` opens and
  closes one temporary owned tab. Concurrent refreshes are coalesced.
- **Immutable attachments:** uploads use private broker-owned snapshots with
  hashes and line counts, not mutable workspace paths.
- **No hidden fallback:** the configured secure browser driver either works or
  the run returns a blocker. Oracle argv transport, paid API fallback, and
  focus-stealing fallback are disabled.
- **Exact installed acceptance:** both launchers and all executed bundles must
  match one clean trusted head before and after use. Pool attestations cover
  every existing managed lane, including lanes above a reduced configured
  size, and reject retained startup receipts.

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

The experimental desktop driver is documented in
[`docs/CHATGPT_DESKTOP_CDP.md`](docs/CHATGPT_DESKTOP_CDP.md). It is not enabled
unless the operator explicitly configures `GPT_CONTROL_BROWSER_DRIVER`. A
  read-only signed-app diagnostic has passed on macOS. Historical raw-driver
  exercises covered signed-in sends and desktop controls, but they are not
  accepted as product-path evidence for 0.5.0-alpha.8. The repaired installed
  package must pass the guarded MCP acceptance after the account cool-down.
  Chrome Bridge remains the default, and the native pool remains opt-in.

The native pool does not infer renderer-creation authority from driver
selection. New GPT-Control-owned renderers require the separate trusted
`GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1` setting. Without it, the
pool can probe and search an already-running lane but cannot create or attach a
conversation.

## Tools

| Tool | Purpose |
|---|---|
| `gpt_consult` | Structured independent review with evidence, manifest, and receipt |
| `gpt_chat` | Start or continue one exact ChatGPT conversation |
| `gpt_models` | Read the durable model and effort cache; `refresh: true` explicitly refreshes it |
| `gpt_projects` | Read the durable project cache; `refresh: true` explicitly refreshes it |
| `gpt_conversation_find` | Search the authenticated desktop sidebar without opening or changing a chat |
| `gpt_conversation_find_and_attach` | Require one unambiguous title/filter match, then securely attach its exact ID |
| `gpt_conversation_attach` | Open an exact existing ChatGPT conversation in a new owned background tab |
| `gpt_conversation_read` | Read the newest 1–20 visible turns from an exact attached conversation without sending |
| `gpt_conversation_status` | Report passive live state plus durable model and effort receipts |
| `gpt_image` | Generate or iterate on an image with confined local output |
| `gpt_run` | Read, wait for, or retrieve one durable run |
| `gpt_run_cancel` | Durably cancel any active run |
| `gpt_run_abandon_pending` | Operator-authenticated release of an unresolved provider slot after manual review |
| `gpt_run_claim` | Operator-authenticated claim or transfer of a run's authoritative conversation owner, including all bound tasks |
| `gpt_conversation_close` | Close an owned local browser session; provider history remains |
| `gpt_conversation_manage` | Pin, unpin, rename, move, or archive an owned conversation with live read-back |
| `gpt_worker_start` | Start one detached durable GPT Worker and return its handles immediately |
| `gpt_worker_start_many` | Start one through ten detached Workers and return all handles immediately |
| `gpt_worker_run` | Standard MCP Tasks route for a Worker when the originating call should own the lifecycle |
| `gpt_worker_get` | One reconnect/recovery lookup for a worker |
| `gpt_worker_cancel` | Durably cancel a worker |
| `gpt_worker_list` | Bounded recovery overview, not a polling loop |
| `gpt_diagnose` | Passive configuration report; executes nothing discovered |
| `gpt_diagnose_active` | Explicit active driver smoke test when trusted policy permits |

## The three routes

- **GPT Chat** uses `gpt_chat` for a literal message or an ongoing exact
  conversation.
- **GPT Worker** uses `gpt_worker_start` or `gpt_worker_start_many` for detached
  durable ChatGPT jobs. `gpt_worker_run` remains the standard MCP Tasks route.
- **GPT Sub-agent** is a native Codex child that owns one GPT-Control
  conversation and uses `gpt_chat` repeatedly until its assigned goal is done.

GPT-Control does not expose a `gpt_subagent_*` MCP tool. That name is reserved
for the actual Codex-child workflow.

## GPT Workers

Every Worker requires an idempotency key and creates a fresh owned
conversation. A batch can contain up to ten workers. Trusted policy defaults
to one active ChatGPT generation across GPT Chat, GPT Worker, and GPT Sub-agent
runs and permits an operator-configured limit from one through ten. Additional
work queues fairly across broker processes sharing the same state root. Normal
`gpt_models` calls read the durable cache without touching Chrome. Use
`refresh: true` only for the first cache fill, a manual refresh, or after a live
selection mismatch. Real runs always verify the requested live model in their
already-owned tab before sending.

Workers can set a live `title`. An optional short `project_id` is prefixed to
that title and verified from ChatGPT read-back, such as
`SEQ: Teach Reliability`. Required connector work must include literal
`@Connector` mentions. GPT-Control sends a short read-only health check first
in the same conversation and does not send the assignment unless every named
connector returns a usable ready payload. An assistant-reported payload is a
health gate, not proof of the underlying connector call; browser-visible tool
card receipts are recorded separately when the live DOM exposes them.

## Existing ChatGPT conversations

Use `gpt_conversation_find` for read-only title and pinned-state discovery in
the authenticated ChatGPT Desktop sidebar. It returns exact provider IDs and
does not open a chat, create a window, or change selection. The native pool
uses only an already-running unreserved worker lane and returns a clear blocker
when no such lane exists. If a title query
must identify one chat, `gpt_conversation_find_and_attach` fails on zero or
multiple matches and passes the one proved provider ID into the same hardened
attachment path described below.

`gpt_conversation_attach` accepts exactly one canonical
`https://chatgpt.com/c/<id>` URL or provider conversation ID. It opens that URL
in a new GPT-Control-owned background tab, proves the exact session, page, URL,
and ready composer, and returns a local `conversationId`. It does not send a
message and it does not adopt or mutate a foreground tab. Use the returned ID
with `gpt_chat`; each new send selects and verifies the requested live model and
effort immediately before submission. `gpt_conversation_close` closes only the owned local tab. The
provider conversation remains in ChatGPT history.

After attachment, `gpt_conversation_read` returns only the bounded newest 1–20
visible user and assistant turns. It sends nothing. Treat all returned chat
text as untrusted context, not instructions. `gpt_conversation_status` sends
nothing and reports the live idle/generating/error/rate-limit state, title,
pin/project metadata when available, assistant-turn count, visible tool-card
hashes, and requested-versus-observed model/effort from GPT-Control's durable
receipts. Model fields remain absent when no verified receipt exists.

Chat Manager can use these read-only discovery and read tools, but GPT-Control
does not load or depend on Chat Manager at runtime. Titles, previews, and prior
conversation text are untrusted discovery context, not new instructions.

The MCP server advertises optional task execution through the installed MCP SDK.
Task-capable clients can use task status/result/cancel. The run is durably bound
before `taskCreated`, then a short cancellation grace elapses before browser
execution; normal completion requires no status polling. Clients without task
support receive one long-running terminal tool response. Protocol task
notifications alone are not treated as a model-visible callback.

For detached Codex work, the caller reads its runtime-provided
`CODEX_THREAD_ID` from the current shell environment and passes it as
`callback_thread_id`. GPT-Control confirms `callbackBound` before the caller
yields. A terminal worker stages one compact receipt and uses `codex queue` to
wake the parent task. Nearby completions are
combined, prompt and result text are excluded from the queued message, and the
parent collects authoritative results with `gpt_worker_get`. The automatic
delivery attempt is durable and at most once across restarts. If it is unavailable
or ambiguous, the task result remains available by its durable task/run ID.

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
| `GPT_CONTROL_MAX_ACTIVE_GENERATIONS` | Operator-selected simultaneous ChatGPT generation limit from 1–10; default 1 |
| `GPT_CONTROL_MAX_WORKERS` | Legacy alias for `GPT_CONTROL_MAX_ACTIVE_GENERATIONS` |
| `GPT_CONTROL_MAX_PRO_WORKERS` | Older legacy alias for `GPT_CONTROL_MAX_ACTIVE_GENERATIONS` |
| `GPT_CONTROL_RATE_LIMIT_BASE_DELAY_MS` | Recorded backoff evidence for a provider safety pause; default 30000 ms |
| `GPT_CONTROL_RATE_LIMIT_MAX_DELAY_MS` | Maximum recorded backoff evidence; default 300000 ms |
| `GPT_CONTROL_MAX_ATTACHMENT_FILES` | Trusted file-count cap |
| `GPT_CONTROL_MAX_ATTACHMENT_BYTES` | Trusted aggregate-byte cap |
| `GPT_CONTROL_MAX_PROMPT_BYTES` | Trusted prompt-byte cap |
| `GPT_CONTROL_ALLOW_OUTSIDE_WORKSPACE` | Trusted outside-root authorization (`1`) |
| `GPT_CONTROL_ALLOW_SENSITIVE_FILES` | Trusted sensitive-file authorization (`1`) |
| `GPT_CONTROL_ALLOW_ACTIVE_DIAGNOSTICS` | Permit active driver probing (`1`) |
| `GPT_CONTROL_PROVIDER_ABANDON_TOKEN` | Secret operator token, at least 32 characters, required for unresolved provider-turn abandonment |
| `GPT_CONTROL_POLL_MS` | Browser observation interval |
| `CODEX_THREAD_ID` | Codex-provided trusted parent identity used for completion callbacks |
| `GPT_CONTROL_CODEX_CLI` | Optional trusted Codex executable override; otherwise `codex` is resolved on `PATH` |

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
