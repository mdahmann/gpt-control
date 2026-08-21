---
name: gpt-control
description: Use when the user asks to get an independent model review, cross-check code or a plan, continue a GPT-Control conversation, inspect a model run, or generate or iterate on an image through Chrome Bridge. Not for facts the working tree or a local test can answer directly.
version: 0.2.0
---

# GPT-Control

GPT-Control is a cross-model review broker, not a generic browser wrapper.

## Choose a transport

- `chrome_bridge`: signed-in ChatGPT in an inactive tab. If the bridge is leased or unavailable, retry; GPT-Control will not open another browser.
- `codex`: official Codex SDK in a read-only sandbox. Default when Chrome Bridge is not installed.
- `responses`: official Responses API. Paid; requires `api_confirmed=true`.
- `oracle_browser`: explicit legacy fallback. It can take focus and requires `allow_focus_steal=true`.
- `oracle_api`: explicit paid legacy fallback.

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
