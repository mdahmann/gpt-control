# Changelog

## 0.2.1 - 2026-08-21

### Security

- Move workspace, sensitive-file, paid-request, focus, endpoint, output, active-diagnostic, and concurrency authority into trusted operator policy.
- Snapshot approved regular-file bytes once into private broker-owned storage; reject symlinks, replacement races, secret stores, and unverifiable finding locations.
- Expose only immutable snapshots to Codex and Chrome providers; never grant original workspace or parent directories as attachment authority.
- Confine public IDs, records, locks, tasks, state home, artifacts, and outputs after resolution.
- Replace age-only lock deletion with owner-token/PID/heartbeat locking and explicit dead-owner recovery.
- Make run/task terminal states monotonic and cancellation race-safe.
- Pin Responses to the official endpoint by default and require fresh trusted confirmation for every paid request and follow-up.
- Keep prompt bodies and attachment paths out of child-process argv; disable Oracle execution whose CLI contract cannot meet that boundary.

### Chrome Bridge

- Wait for an owned first tab to reach ChatGPT and a usable composer before origin-gated actions.
- Add typed `chatgpt_model: "pro"` selection with actual composer selector selection/read-back and immediate pre-send re-verification.
- Record requested and observed model separately, with real ChatGPT conversation URL provenance distinct from local/synthetic Bridge identity.
- Require a newer stable final assistant turn with no active answering, thinking, stop, tool-running, Retry, Continue, interruption, or error state.
- Add bounded same-conversation recovery without duplicate prompt submission or duplicate conversations.

### Codex Pro workers

- Add task-based `gpt_subagent_run` plus durable get/cancel/list tools.
- Support three fair durable concurrent workers across broker processes with independent tabs, runs, locks, cancellation, idempotency, restart/reconnect recovery, and exactly-once terminal results.
- Persist MCP task state/results through a disk-backed task store and emit advisory task/progress notifications.
- Fall back to one long-running terminal tool response when MCP task support is unavailable.
- Package GPT-Control as a Codex plugin with manifest, MCP registration, agent metadata, launcher, and skill instructions.
- Document that task notifications are not claimed to wake a dormant Codex chat; pending task/long-running calls are the no-poll mechanism.

### Contract

- Restore MCP `gpt_image` parity.
- Split passive `gpt_diagnose` from trusted-policy-gated `gpt_diagnose_active`.
- Add storage schema 2, migration guidance, threat model, and manual Chrome validation.

## [0.2.0] - 2026-08-21

### Added

- Renamed the package and tools to GPT-Control.
- Official Codex SDK and Responses API transports.
- Separate wrapper-owned `conversation_id` and per-submission `run_id` records persisted under `~/.gpt-control`.
- Run status, wait, result, cancel, per-conversation locking, and exact provider result identifiers.
- Workspace-scoped attachment manifests with realpath containment, regular-file checks, count and byte caps, sensitive-path gates, and SHA-256 receipts.
- Structured review findings with evidence ranges, confidence, remediation, and open questions.
- Review receipts covering provider, model, timestamps, prompt hash, attachment hashes, result hash, and provider identifiers.
- MCP adapter exposing the same core service as OMP and Pi.

### Changed

- Chrome Bridge remains the preferred signed-in browser transport. A lease or outage now returns a retryable error and never falls back to a focus-stealing browser.
- Oracle browser mode is explicit and requires `allow_focus_steal=true`.
- Destructive run cancellation and conversation close operations are separate write-approved tools.
- Browser reuse, read, and close require a wrapper-owned session namespace and an exact `https://chatgpt.com` origin.

## [0.1.2] - 2026-08-21

### Fixed

- A turn could report the wrong answer. Completion was inferred from whole-page text holding steady, but the page also holds still while the model is thinking, is queued, or is rate limited. The wait then finished early and the last assistant turn was read, which on a continuation is the previous reply, so an earlier answer could be returned as the answer to a new question. Each turn now records how many replies were on the page before submitting, waits for that count to rise, and only then waits for the new reply to settle.
- Whole-page text is no longer used as a fallback answer. It carried the sidebar and chat history alongside the reply. When no new reply arrives, the tool now reports that and returns the job id.
- An image-only reply no longer waits out the full timeout. Settling keys on text or images, whichever the turn carries, and a reply that exposes nothing readable gives up after a bounded number of polls.
- Page snapshots use a unique scratch filename. Two reads of the same tab within one millisecond shared a path, letting one caller parse another's page.

## [0.1.1] - 2026-08-21

### Fixed

- Continuing a conversation no longer destroys it. `chatgpt_chat` with a `job_id` navigated the session to the ChatGPT root URL, and because Chrome Bridge reuses a task session's single tab, that replaced the conversation it was meant to continue. A continuation now resolves the session's live tab and submits into it without navigating. A session whose tab is gone reports that instead of silently answering in a new conversation.
- The Oracle fallback no longer passes `--json`, which the root command rejects with `unknown option '--json'`. Several Oracle subcommands accept the flag, which makes it look universal in the source. `--followup` is also documented as taking an Oracle session id rather than a conversation URL.

## [0.1.0] - 2026-08-21

### Added

- `chatgpt_consult`, `chatgpt_chat`, `chatgpt_image`, and `chatgpt_job` tools for Oh My Pi and Pi.
- Chrome Bridge transport that submits ChatGPT work in an inactive, task-owned background tab of the user's existing signed-in Chrome.
- Oracle CLI fallback for text review when Chrome Bridge is unavailable, covering both its browser mode and confirmation-gated paid API mode.
- Transport discovery across explicit command overrides, `PATH`, and conventional checkout locations, with `chatgpt_job action="diagnose"` reporting what was found.
- Setup guidance returned in place of opaque failures when no transport is configured.
- Image artifact retrieval that saves generated images from their pre-signed URL, returns them inline, and falls back to a tab screenshot when the fetch is refused.
- Bundled `chatgpt-control` skill.

### Security

- Chrome Bridge policy denials surface the exact grant command rather than widening policy automatically.
- Paid API mode requires explicit `api_confirmed`.
- Generated files stay under `~/.chatgpt-control/generated` unless `allow_external_output` is set.
- Generated-image URLs are taken from page content, so they are treated as untrusted: the host is parsed and matched against an allowlist rather than string-matched, plaintext and redirects are refused, a non-image response is rejected, and the body is capped at 25 MiB while streaming. A substring host check would let page markup point the fetch at a private address.
- The Oracle CLI is never resolved through `npx`, so no tool call can trigger an implicit install or a silent version change.
