# Changelog

## [0.5.0-alpha.3] - 2026-08-23

- Added an opt-in native ChatGPT/Codex worker pool with one separately signed
  macOS app process, persistent profile, private state root, and loopback CDP
  port per lane.
- Added exact session-to-lane routing, a fair allocation lock, configurable
  pool size from one through ten, and clean capacity blockers.
- Minimized worker windows after launch, restored the previously active app
  only when the worker still held focus, and stopped an empty lane after its
  exact GPT-Control session closes.
- Added an explicit one-time interactive bootstrap gate for fresh profiles,
  exact process-tree shutdown, and offline release for crashed durable lanes.
- Added package, bundle-reproducibility, protocol-envelope, and live concurrent
  acceptance coverage for the pool driver.

## [0.5.0-alpha.2] - 2026-08-23

- Reserved every mutating desktop run a dedicated native window and persisted
  its exact renderer receipt before waiting for readiness.
- Added restart-safe provisional creation and close states, bounded local lock
  recovery, exact target-absence proof, and multi-shell conversation search.
- Added strict code-signature verification, one desktop environment namespace,
  packaged runtime receipts, and valid protocol errors on exit status zero.
- Kept user-owned ChatGPT windows passive and outside GPT-Control ownership.

## [0.5.0-alpha.1] - 2026-08-22

- Added an opt-in protocol-v2 adapter for the signed macOS ChatGPT desktop app
  through an explicit loopback-only Electron CDP endpoint.
- Added official bundle and Team ID checks, exact listener-process checks,
  durable renderer ownership, exact-conversation restart rebinding, and
  fail-closed renderer capacity handling.
- Kept prompt text on private stdin and out of durable state. The adapter
  records only a prompt hash and persists `sendState=attempted` before Send so
  an ambiguous click cannot be replayed automatically.
- Added read-only diagnostics and separately authorized live smoke tests for
  one, two, three, and six distinct renderer identities.
- Kept Chrome Bridge as the default. This desktop route remains experimental
  until signed-in macOS acceptance is complete.

## [0.4.4] - 2026-08-22

- Changed ordinary `gpt_models` and `gpt_projects` calls to read durable cache
  files without opening Chrome or contacting ChatGPT.
- Added explicit `refresh: true` catalog refreshes. Each refresh uses one
  temporary owned tab and closes it after verified discovery.
- Coalesced simultaneous refreshes in one process and across broker processes
  sharing the same secure state root.
- Kept live per-run model selection and immediate pre-send verification inside
  each real Chat or Worker tab.

## [0.4.3] - 2026-08-22

- Detects and safely dismisses visible ChatGPT rate-limit notices, records a
  shared durable cooldown, and temporarily lowers new Worker concurrency. The
  limit recovers one slot at a time after successful work.
- Treats ChatGPT project routes such as `/g/<project>/c/<id>` as the same exact
  canonical conversation identity as `/c/<id>`.
- Reuses the live model read-back after required connector preflight instead of
  repeating full model-catalog selection before the main assignment.
- Retries failed Codex completion callbacks up to three times with the same
  durable task and run IDs. Duplicate wake receipts remain possible at an
  ambiguous delivery boundary, so consumers must collect idempotently by task
  ID.

## [0.4.2] - 2026-08-22

- Added immediate-return `gpt_worker_start` and `gpt_worker_start_many` tools so
  Codex can launch one through ten durable Workers without holding the parent
  turn open.
- Added explicit per-launch Codex callback routing and visible callback binding
  receipts. Shared MCP-server startup state is no longer assumed to contain the
  current Codex task identity.
- Kept `gpt_worker_run` as the backward-compatible MCP Tasks route.
- Added multi-parent callback recovery and coalesced per-parent `codex queue`
  delivery.

## [0.4.1] - 2026-08-22

### Added

- Verified native GPT Worker titles with an optional generic project identifier prefix, such as `SEQ: Teach Reliability`.
- Fail-closed, same-conversation read-only preflight for required `@Connector` assignments, with separate assistant-payload and browser-tool-card evidence levels.

### Fixed

- Live rename no longer sends the unsupported `expectedTarget` field with Chrome Bridge keyboard actions; the exact owned document is proved immediately before and after Enter.
- Interrupting the originating MCP request now detaches the caller instead of cancelling a durable Worker. Only explicit task or Worker cancellation requests Stop.
- Cancellation receipts now warn that connected-tool operations already started by ChatGPT can continue after Stop.

### Ownership

- Package and Codex plugin metadata now point to the independent `mdahmann/gpt-control` fork. The original repository remains a read-only upstream source only.

## [0.4.0] - 2026-08-22

### Added

- Live ChatGPT model and effort discovery with exact selection and immediate pre-send read-back.
- ChatGPT project discovery and verified pin, unpin, rename, move, and archive controls for owned conversations.
- Optional automatic pinning for GPT Chat and automatic pinning for GPT Worker conversations.

### Changed

- Public orchestration now uses three distinct names: GPT Chat, GPT Worker, and GPT Sub-agent.
- Durable direct browser-worker tools are now `gpt_worker_run`, `gpt_worker_get`, `gpt_worker_cancel`, and `gpt_worker_list`.
- GPT Sub-agent now refers only to a native Codex child that controls one exact GPT-Control conversation.
- GPT Workers can select any exact live model and effort; they are not restricted to the Pro effort level.

## [0.3.2] - 2026-08-22

### Added

- Event-driven Codex parent callbacks for durable Pro workers through `codex queue`, using only the runtime-provided trusted `CODEX_THREAD_ID`.
- Durable, coalesced completion receipts that carry task/run IDs and terminal status without prompt or result text.

### Security

- Parent callback targets cannot be supplied by model tool arguments. Callback attempts are marked before the external queue command, preventing automatic duplicate wakes across restart or an ambiguous command boundary.
- A missing thread identity, unavailable Codex executable, or failed callback does not alter the immutable worker result. Durable task/run lookup remains authoritative.

## [0.3.1] - 2026-08-21

### Added

- Optional MCP tool-task delivery for independent ChatGPT Pro workers, with durable task status, result, cancellation, reconnect, and one-terminal-call fallback.
- Connector-aware worker intent with explicit preferred/required semantics and blocker behavior for unavailable required connectors.
- Codex plugin metadata, portable MCP launcher, migration guidance, security model, and disposable-Chrome validation procedure.
- Browser-driver protocol v2 with separate fill and send operations, secure-input attestation, exact session/page ownership, live UI observations, and bounded same-conversation recovery.
- Exact existing-conversation attachment by canonical ChatGPT URL or provider ID in a separate GPT-Control-owned background tab.

### Security

- Trusted operator policy now owns workspace, sensitive-file, output, transport, diagnostic, prompt, attachment, and worker authority; tool arguments cannot expand it.
- Attachments are immutable private snapshots protected against symlink, non-regular-file, and time-of-check/time-of-use attacks.
- ChatGPT Pro provenance is derived from live composer selection and read-back immediately before send, never from a requested model string.
- Submitted work is never replayed after a crash. Cancellation is persisted as an immutable terminal state before best-effort browser stop, so late completion cannot overwrite it.
- Exact provider conversation URLs are persisted and restored only in the same owned page; conversation drift, page replacement, and first-tab races fail closed.
- Legacy Oracle argv execution code was removed; passive detection only explains why an installed legacy CLI is not executable. All unavailable-driver paid/focus-stealing fallbacks are disabled. Nonzero child exits cannot masquerade as successful JSON responses.

### Changed

- Local state moves to isolated schema v3 under `~/.gpt-control/v3` by default because previous version-2 records had incompatible shapes.
- The built-in Chrome Bridge adapter requires its private RPC and identifies as `chrome-bridge/private-rpc-v2`.
- Package version advances to 0.3.1 and includes a committed, reproducibility-checked Node MCP bundle so Codex plugin snapshots start without `node_modules` or install hooks.

## [0.3.0] - 2026-08-21

### Added

- Versioned `WebChatDriver` interface covering probe, create, show, upload, submit, snapshot, state, close, and screenshot operations.
- External command adapter configured with `GPT_CONTROL_BROWSER_DRIVER`. Requests use JSON on stdin and validated envelopes on stdout, so prompts and file paths do not appear in process arguments.
- Chrome Bridge adapter behind the same interface.

### Changed

- The public default transport is now `browser`, not `chrome_bridge`.
- Conversation records persist driver-neutral session and page identifiers plus the driver id.
- GPT-Control no longer assumes Chrome Bridge is installed. It is one optional autodetected adapter.
- Storage schema advanced to version 2 for the driver-neutral conversation contract.

## [0.2.1] - 2026-08-21

### Changed

- Returned GPT-Control to its actual product boundary: any compatible CLI harness can control the signed-in ChatGPT web UI through Chrome Bridge.
- Removed the Codex SDK and Responses API adapters and dependencies. They duplicated model access already present in the calling harness and did not control the ChatGPT website.
- Chrome Bridge is again the only default transport. An outage or lease returns a retryable error; Oracle browser mode remains explicit and focus-steal-gated.
- Retained the durable parts that serve web control: separate conversation and run IDs, locks, attachment manifests, structured reviews, receipts, image iteration, OMP/Pi extension loading, and MCP.

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
