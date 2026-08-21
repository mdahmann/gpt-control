# Codex / ChatGPT Pro Subagent Architecture

## Roles

Codex is the orchestrator. It decomposes work, owns repository/tool authority, decides what to accept, and integrates results. GPT-Control is a bounded local provider broker. Each ChatGPT Pro worker receives one task and returns one verified completion or blocker result.

A worker is not a nested orchestrator and GPT-Control does not delegate Codex authority to it.

## Interface

### `gpt_subagent_run`

Inputs:

- `prompt` — self-contained worker assignment;
- `idempotency_key` — stable 1-128 character logical request identity;
- `files` — optional paths subject to trusted snapshot policy;
- `timeout_ms` — optional bounded deadline.

The tool creates a fresh owned tab/conversation. It does not accept `conversation_id`, transport choice, focus permission, workspace override, paid authority, or a free-form provenance string.

### Recovery tools

- `gpt_subagent_get`: one durable lookup by run/task identity after reconnect or uncertainty;
- `gpt_subagent_cancel`: independent monotonic cancellation;
- `gpt_subagent_list`: bounded active overview after process/client recovery.

These are recovery controls, not a polling protocol.

## Execution flow

1. Enforce a fair trusted concurrency limit of at most three across broker processes sharing durable state.
2. Create one independent durable run and one Chrome Bridge task session/tab.
3. Wait for the owned tab to reach `https://chatgpt.com` and expose a usable composer.
4. Read the actual composer selector. Select `Pro` if needed and read it back.
5. Snapshot and upload only approved broker-owned bytes.
6. Fill the prompt through private request-file RPC.
7. Re-read the selector immediately before send; fail closed if it is not `Pro`.
8. Mark submission as in progress, click send once, then persist `submitted`.
9. Observe the same chat in the background. Do not focus it and do not submit status messages.
10. Apply bounded same-chat recovery when live UI evidence supports it.
11. Return exactly one terminal result only after stable final-turn verification, or return a durable blocker/failure/cancellation.

## MCP task behavior

The installed MCP SDK 1.30.0 exposes experimental task tools and the states `working`, `input_required`, `completed`, `failed`, and `cancelled`, with task status/progress notifications and get/result/cancel requests. GPT-Control supplies a disk-backed task store instead of the SDK's in-memory default.

For a task-negotiating client, `gpt_subagent_run` creates a protocol task, sends advisory status/progress, and stores one immutable terminal result. For a client without task support, the same tool is a normal long-running call that returns once at terminal state.

The deterministic integration suite uses the installed MCP client and confirms task creation, status, input-required visibility, one result, durable retrieval, cancellation, reconnect, and non-task fallback.

## Codex wake/callback boundary

The installed Codex 0.147.0 native runtime and the project-bundled 0.149.0 runtime contain handlers for MCP task/progress methods. This proves protocol handling is present, not that a notification can inject a new model-visible message or wake a dormant Codex thread.

No such wake behavior was proved end to end. GPT-Control therefore makes no callback claim. The supported no-poll behavior is:

- keep the task-based or long-running tool call pending;
- return one result when terminal;
- use durable get/list only after disconnect/restart or lost response.

Codex should never send ChatGPT "are you done?" messages and should not burn orchestrator turns polling a pending worker.

## Restart and reconnect

Submission state is durable:

- `not_submitted`: safe to prepare/select/upload/fill;
- `submitting`: ambiguous boundary; prompt is never replayed automatically;
- `submitted`: recovery observes the existing conversation only;
- terminal: immutable.

A graceful MCP restart suspends local watchers while preserving submitted state. On restart the broker reacquires per-conversation ownership, re-establishes the exact owned tab/conversation, and resumes observation. A non-browser provider request that was in flight across restart becomes `needs_user` rather than being replayed, because replay could duplicate or charge twice.

## Tool-capable workers

A target ChatGPT conversation may use connected tools such as GitHub or Zenbox only when the account and live UI actually make those tools callable. GPT-Control neither grants nor infers those permissions. A prompt may request tool use, but the result remains untrusted until the final assistant turn and provenance are verified. Tool availability and tool outputs still require Codex-side judgment.

## Exactly-once boundaries

Exactly-once terminal delivery means one immutable task result per task. Idempotent start means one run/prompt submission per matching idempotency key and request hash. Conflicting reuse is rejected.

No broker can atomically combine a browser click with a local disk write. At that narrow crash boundary GPT-Control chooses non-duplication: an ambiguous submission is retained for operator/recovery observation rather than replayed.
