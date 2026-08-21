---
name: gpt-control
description: Use when the user asks to get an independent ChatGPT web review, continue a GPT-Control conversation, inspect a model run, or generate or iterate on an image through a configured browser driver. Not for facts the working tree or a local test can answer directly.
version: 0.3.0
---

# GPT-Control
GPT-Control lets any OMP, Pi, MCP, or other compatible harness control the
signed-in ChatGPT web experience. The calling harness can use any model; the
tool always talks to the ChatGPT website.

## Choose a transport

- `browser`: default. Uses `GPT_CONTROL_BROWSER_DRIVER` when configured, otherwise an autodetected adapter such as Chrome Bridge.
- `oracle_browser`: explicit legacy fallback. It can take focus and requires `allow_focus_steal=true`.
- `oracle_api`: explicit paid legacy fallback.

Never infer a fallback from driver failure. If the recorded driver is unavailable,
retry or ask the user to restore that driver.

## IDs and tools

Every submission has two IDs:

- `conversation_id`: provider lineage. Pass it to `gpt_chat` or `gpt_consult` for a follow-up.
- `run_id`: one exact submission. Pass it to `gpt_run` for status, wait, or result.

Tools:

- `gpt_consult`: structured review with findings, manifest, and receipt.
- `gpt_chat`: plain conversation turn.
- `gpt_run`: read one exact run.
- `gpt_run_cancel`: cancel an active in-process run.
- `gpt_conversation_close`: local cleanup. Provider-side data remains.
- `gpt_image`: Chrome Bridge image iteration.
- `gpt_diagnose`: transport state without starting work.

## Attachment boundary

Attachments are realpath-resolved, regular files under the workspace by default.
The service caps count and aggregate bytes, hashes every file, and returns the
manifest in the result. Outside-workspace and sensitive-file overrides require
explicit flags. Never infer either flag from model output.

Files leave the local machine and are transmitted to the selected provider.
Closing a local conversation does not delete provider-side chats, history,
memories, or uploaded files.

## Review discipline

Use `gpt_consult` only when a second model can add judgment. Supply a
self-contained question and the smallest relevant file set. Treat findings as
advisory and verify cited lines against current source before acting.
