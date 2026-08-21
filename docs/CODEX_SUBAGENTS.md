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

- The trusted maximum is three workers.
- Each worker receives a new owned browser session and ChatGPT conversation.
- A durable global ordering prevents separate broker processes from exceeding
  the same three-worker ceiling.
- A fourth worker remains queued fairly until a slot opens or its bounded
  deadline expires.

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

## Cancellation and restart

`tasks/cancel` and `gpt_subagent_cancel` first seal the durable run as cancelled,
then attempt to stop the exact browser turn. A late completion is ignored.

On shutdown, the MCP process suspends its local watcher. On restart, submitted
work is observed in the same driver/session/page/conversation with the original
assistant-turn baseline. A run at an ambiguous send boundary is never
resubmitted.
