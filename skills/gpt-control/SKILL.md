---
name: gpt-control
description: Use when a bounded independent ChatGPT web review, exact conversation follow-up, image task, or up-to-three-worker ChatGPT Pro subagent run would materially help. Codex remains the orchestrator. Not for facts, tests, or repository evidence Codex can obtain directly.
version: 0.3.1
---

# GPT-Control

GPT-Control controls the signed-in ChatGPT website through one configured,
secure browser-driver protocol. It does not call a paid API fallback and it does
not open a replacement browser when the configured driver is unavailable.

## When to use it

Use GPT-Control for a bounded independent judgment task, not as a substitute for
local inspection. Give each worker a self-contained assignment and the smallest
necessary immutable attachment set. Verify returned claims against primary
source or current repository state before acting.

## Pro workers

- `gpt_subagent_run` starts one independent ChatGPT Pro worker and requires an
  idempotency key.
- At most three workers run concurrently. Each owns a separate browser
  conversation.
- Prefer one terminal completion or blocker result. Do not repeatedly ask for
  status.
- `gpt_subagent_get` is for one reconnect/recovery lookup when the original tool
  result was lost or uncertain.
- `gpt_subagent_cancel` durably seals cancellation. A late browser completion
  cannot overwrite it.
- `connectors` names requested connected tools; they do not grant access.
  `connector_mode=require` means an unavailable connector must produce a
  blocker rather than fabricated work.

MCP task execution is optional. A task-capable client can use task status,
result, and cancellation. A client without task support receives one
long-running terminal tool response. Notifications are not assumed to inject a
new chat message or wake a dormant thread.

## Exact conversations and runs

Every submission has two wrapper-owned IDs:

- `conversation_id` identifies the exact provider conversation lineage.
- `run_id` identifies one exact submission and durable result.

A follow-up is accepted only when the recorded driver, session, page, ownership
name, and canonical `https://chatgpt.com/c/<id>` URL can all be proven. Recovery
may navigate the same owned page back to the recorded URL. It must not create a
replacement page or resubmit an ambiguous prompt.

## Tools

- `gpt_consult`: structured review with bounded evidence and receipts.
- `gpt_chat`: exact conversation turn.
- `gpt_image`: image generation/iteration with confined local output.
- `gpt_run`: status, wait, or result for one durable run.
- `gpt_run_cancel`: durable cancellation.
- `gpt_conversation_close`: local session cleanup; provider history remains.
- `gpt_diagnose`: passive configuration report; executes nothing discovered.
- `gpt_diagnose_active`: opt-in driver probe when trusted policy enables it.

## Trust boundary

Tool input cannot enable outside-workspace reads, sensitive-file reads,
external output, paid fallback, or focus stealing. Those decisions belong to
trusted operator environment policy. Attachments are immutable broker-owned
snapshots, hashed before upload, and local state is private under schema-v3
storage.
