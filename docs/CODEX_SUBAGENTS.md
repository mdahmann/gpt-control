# Codex Pro-worker architecture

GPT-Control keeps Codex as the orchestrator and ChatGPT Pro as a bounded,
independent web worker. It does not delegate orchestration, repository authority,
or merge decisions to the worker.

## Client paths

### MCP task-capable client

`gpt_subagent_run` advertises optional task execution. The server creates and
persists the run, binds exactly one MCP task to that run, returns `taskCreated`,
and observes a short cancellation grace before provider work becomes eligible.
It publishes task status/progress when supported and exposes
`tasks/get`, `tasks/result`, and `tasks/cancel` through the SDK task store. Each
task has one immutable terminal result.

### Client without task support

The same tool remains usable as one long-running call. It waits for one terminal
completion or blocker and returns once. This is the compatibility path for a
client that cannot negotiate MCP tasks.

A task notification is a protocol event. GPT-Control does not claim that it can
inject a new model-visible chat message or wake a dormant Codex thread. Recovery
uses the durable task/run IDs, not conversational polling.

## Concurrency

- The safe default is three workers. The operator can set
  `GPT_CONTROL_MAX_PRO_WORKERS` from 1 through 10. Five or six is the initial
  recommendation after local validation; ten is experimental.
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
`gpt_subagent_get` once after reconnect or uncertainty. Do not send model-visible
“are you done?” prompts: they create extra ChatGPT turns and weaken result
identity.

## Connector intent

The optional `connectors` list is included in the hashed provider prompt and
stored in the durable run. It names connected tools the worker should verify.
It does not grant permissions.

- `prefer`: continue without an unavailable connector only when the assignment
  remains supportable, and disclose the limitation.
- `require`: return a blocker if any named connector is unavailable. Never
  fabricate connector access, output, or a successful action.

This contract is advisory because the browser broker cannot observe ChatGPT's
connector tool-call stream. Public run data therefore reports connector
verification as `unverified` with evidence kind `provider_prompt_intent_only`.
For a required GitHub or Zenbox connector, Codex must independently check a
harmless connector result and its source before it accepts the worker output.

## Cancellation and restart

`tasks/cancel` and `gpt_subagent_cancel` first seal the durable run as cancelled,
then seal the task, then attempt to stop the exact browser turn. A crash between
these steps cannot leave a cancelled task bound to runnable work. A late
completion is ignored.

On shutdown, the MCP process suspends its local watcher. On restart, submitted
work is observed in the same driver/session/page/conversation with the original
assistant-turn baseline. A run at an ambiguous send boundary is never
resubmitted. In a short bounded window immediately after the send click,
GPT-Control records the first new provider-issued `/c/<id>` URL and user-message
ID with the run. The first new user turn must match the broker-owned proof. A
different first turn fails closed, and identity is never adopted after the
window. Prompt text, hashes, and the visible per-run
marker are additional checks; they are never enough to adopt a conversation by
themselves because transcript text can be copied. If the provider-issued
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
