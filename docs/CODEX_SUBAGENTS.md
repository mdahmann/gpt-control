# GPT Chat, GPT Worker, and GPT Sub-agent architecture

GPT-Control keeps Codex as the orchestrator. The three public concepts are:

- **GPT Chat:** one direct `gpt_chat` turn or a follow-up in an exact owned
  conversation.
- **GPT Worker:** one durable background ChatGPT assignment started by
  `gpt_worker_start`, or a batch started by `gpt_worker_start_many`. The Worker
  can use any live model and effort listed by `gpt_models`.
- **GPT Sub-agent:** a native Codex child agent that owns one GPT-Control
  conversation and uses `gpt_chat` for as many turns as its goal requires.

GPT Sub-agent is a Codex orchestration workflow, not an MCP tool name. GPT-Control
does not register public `gpt_subagent_*` tools. This prevents a direct browser
worker from being mistaken for a Codex child agent.

## GPT Sub-agent path

The parent starts a native Codex child and gives it one bounded goal. The child
starts or attaches one GPT Chat, retains its returned `conversation_id`, and
uses that same ID for every follow-up. It can let ChatGPT perform work through
available connected tools, or it can use ChatGPT as a reviewer while the child
performs local work. The child returns one verified result or one blocker to
the parent. If native Codex subagents are unavailable, GPT-Control does not
replace this path with an unmanaged shell loop.

## Client paths

### Detached Codex parent

Use `gpt_worker_start` or `gpt_worker_start_many`. These are ordinary,
immediate-return tools rather than MCP task calls. Before launch, the parent
reads the current runtime-provided `CODEX_THREAD_ID` from its shell environment
and supplies that UUID as `callback_thread_id`. The response includes every
durable task/run handle and `callbackBound` state. The parent yields immediately
only after the required callback bindings are true.

Completion queues one fixed receipt to the parent through `codex queue`. If the
parent is busy, Codex keeps the message queued until a safe turn boundary. The
parent calls `gpt_worker_get` once after the callback; it does not poll while
the Worker is active.

### MCP task-capable client

`gpt_worker_run` advertises optional task execution. The server creates and
persists the run, binds exactly one MCP task to that run, returns `taskCreated`,
and observes a short cancellation grace before provider work becomes eligible.
It publishes task status/progress when supported and exposes
`tasks/get`, `tasks/result`, and `tasks/cancel` through the SDK task store. Each
task has one immutable terminal result.

### Client without task support

The same tool remains usable as one long-running call. It waits for one terminal
completion or blocker and returns once. This is the compatibility path for a
client that cannot negotiate MCP tasks.

A task notification is a protocol event and is not itself treated as a
model-visible callback. In Codex 0.149 or newer, a detached start can bind its
durable task to an explicit current-task UUID obtained from Codex's
runtime-provided shell environment. When that task becomes terminal,
GPT-Control stages a compact receipt and invokes `codex queue` for the bound
parent. The parent then reads the authoritative result with `gpt_worker_get`;
no repeated polling is required.

Nearby terminal receipts for one parent are coalesced into one queued message.
The receipt contains only task/run IDs and statuses, never the worker prompt or
result body. GPT-Control durably marks the callback attempted before invoking
the external command. This gives restart-safe at-most-once automatic delivery:
an ambiguous crash can lose a wake-up, but it cannot automatically send a
duplicate. Durable task/run lookup remains the recovery path.

The callback target routes only a fixed, bounded GPT-Control receipt. It cannot
supply arbitrary callback text or grant repository, connector, browser, or
provider authority. If the current task ID is missing or invalid, or the trusted
Codex executable cannot be found, a requested callback start fails before
claiming that automatic wake-up is available. This release uses the local
`codex queue` route and does not configure a remote app-server callback.

## GPT Worker concurrency

- The default GPT Worker ceiling is six. The operator can set
  `GPT_CONTROL_MAX_WORKERS` from 1 through 10. Ten is the hard ceiling. The old
  `GPT_CONTROL_MAX_PRO_WORKERS` name remains a compatibility alias.
- Each worker receives a new owned browser session and ChatGPT conversation.
- A durable global ordering prevents separate broker processes from exceeding
  the configured ceiling.
- A submitted turn keeps its slot until completion or a proved inactive Stop;
  timeout alone does not release live provider capacity.
- Work above the configured ceiling remains queued fairly until a slot opens or
  its bounded deadline expires.
- The limit controls browser workers, not repository write authority. Use one
  writer lease per repository or worktree. Research, review, and separate
  repositories can run concurrently.
- OpenAI does not document a fixed limit for simultaneous ordinary ChatGPT
  conversations. Increase capacity with a staircase test at 3, 5, 7, and 10,
  and reduce it when ChatGPT throttles, Chrome becomes unstable, or connectors
  fail. This release does not yet adjust the configured limit automatically.

## One-result discipline

Normal orchestration consumes the original terminal tool/task result. Use
`gpt_worker_get` once after reconnect or uncertainty. Do not send model-visible
“are you done?” prompts: they create extra ChatGPT turns and weaken result
identity.

## GPT Worker connector intent

The optional `connectors` list is included in the hashed provider prompt and
stored in the durable run. It names connected tools the worker should verify.
It does not grant permissions.

- `prefer`: continue without an unavailable connector only when the assignment
  remains supportable, and disclose the limitation.
- `require`: the assignment must contain every literal `@Connector` mention.
  GPT-Control first sends one short read-only health check in the same
  conversation. It sends the assignment only after the response contains one
  usable `ready` payload for every connector. Otherwise it returns a blocker.

The required preflight is a health gate, not automatic proof of a connector
call. When no connector-named browser tool card is visible, public run data uses
evidence kind `assistant_reported_preflight`. When the live DOM exposes bounded
connector-named tool cards, GPT-Control records their labels and hashes with
evidence kind `browser_tool_card`. Tool-card text and assistant payloads remain
untrusted evidence. Verify important Zenbox, GitHub, or other external facts
independently before accepting the Worker output.

## Cancellation and restart

`tasks/cancel` and `gpt_worker_cancel` first seal the durable run as cancelled,
then seal the task, then attempt to stop the exact browser turn. A crash between
these steps cannot leave a cancelled task bound to runnable work. A late
completion is ignored.

Interrupting or cancelling only the originating `gpt_worker_run` request
detaches that caller and does not cancel the durable worker. Use `tasks/cancel`
or `gpt_worker_cancel` for explicit cancellation. ChatGPT Stop controls only the
owned ChatGPT turn. A Zenbox, GitHub, or other connected-tool operation that
already started can continue after Stop, so its external state must be checked
independently.

On shutdown, the MCP process suspends its local watcher. On restart, submitted
work is observed in the same driver/session/page/conversation with the original
assistant-turn baseline. A run at an ambiguous send boundary is never
resubmitted. In a short bounded window immediately after the send click,
GPT-Control records the first new provider-issued `/c/<id>` URL and user-message
ID with the run. New 0.4 runs send the assignment as ordinary prompt text with
no visible automation marker. They bind identity only in that immediate guarded
send window on the exact owned page; identity is never adopted later from
transcript text alone. Legacy records that already contain a proof token still
require its exact prompt-hash match. If the provider-issued
identity was not durably recorded before a crash, the run fails closed and
keeps its global worker slot sealed. After manual inspection, an operator can use
`gpt_run_abandon_pending` with the exact confirmation `ABANDON <run_id>` to
release that slot. The call also requires the out-of-band secret configured as
`GPT_CONTROL_PROVIDER_ABANDON_TOKEN`; the run ID and confirmation are not
sufficient. This records the abandonment and does not claim that the provider
turn stopped.

Ordinary runs created before durable MCP session ownership was added are not
claimed automatically. A reconnect can also receive a new transport session
ID. In a stateful MCP transport, use `gpt_run_claim` with the same trusted
out-of-band operator token and exact confirmation `CLAIM <run_id>`. The
operation atomically transfers the conversation that authoritatively owns that
run to the current MCP session. Bound task APIs derive access from that same
conversation owner, so the old session is revoked without a second ownership
write. Other sessions remain denied.

Automatic Stop reconciliation uses a bounded exponential retry sequence. An
unproved turn remains durable and keeps its slot, but it does not create a
permanent browser-probe loop. Broker restart performs another bounded sweep.

For multiplexed MCP transports, task list/get/result/cancel operations require
the exact creating session identifier. Internal broker recovery is the only
sessionless path across the durable task store.
