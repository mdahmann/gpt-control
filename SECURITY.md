# GPT-Control Security Model

## Supported use

Version 0.2.1 is a hardened local beta for non-sensitive repositories. It is not a production-readiness claim or a general secret-handling system.

## Assets and trust boundaries

GPT-Control protects repository/attachment bytes, provider credentials and endpoints, paid authority, browser ownership, prompt uniqueness, durable state/output, and truthfulness of terminal state and provenance.

**Trusted operator policy** is established outside model input through environment or an embedding-supplied `OperatorPolicy`. It controls roots, transport/model allowlists, attachment exceptions, alternate endpoints, paid confirmations, diagnostics, and worker concurrency.

**Untrusted tool input** includes prompts, requested paths, public IDs, transport/model choices, output subdirectories, structured findings, and follow-ups. A request may narrow trusted authority but cannot set `workspace_root`, outside/sensitive overrides, paid confirmation, focus permission, endpoint permission, or equivalent widening controls. Follow-ups retain the original policy fingerprint.

**Provider boundary:** transmitted prompts/snapshots leave the local machine and become subject to provider retention/account policy. Local cleanup does not delete provider chats, history, memories, or uploads.

**Browser boundary:** Chrome actions require the exact task-session-owned tab and `https://chatgpt.com` origin. Background operation is default and the model-facing API has no focus-steal option. Ownership/origin are rechecked before prompt/upload, recovery, and screenshot fallback.

## Immutable snapshots and TOCTOU resistance

The broker rejects symlink components and non-regular files, opens a source with no-follow semantics, compares descriptor/path identity, reads approved bytes once, verifies identity/size/mtime stayed stable, writes a private read-only snapshot, then hashes and line-counts the snapshot bytes. Only snapshot paths are transmitted. Partial snapshots are deleted on failure.

Codex receives only the snapshot root as a read-only working directory; the original workspace and arbitrary parent directories are never attachment grants.

## Sensitive files

The conservative guard covers environment files, package-registry credentials, netrc, Git/cloud credentials, SSH keys, Docker auth, service accounts, tokens, keystores, certificates, and related patterns. False positives are expected. Only trusted operator policy can override the guard; overrides should be temporary and scoped.

## IDs, paths, and locks

Conversation, run, and task IDs use complete-match fixed-prefix grammars plus 32 lowercase hexadecimal characters. Record, lock, request, task, snapshot, artifact, and output paths stay beneath trusted roots. Symlink components/escapes and encoded or literal separators in public IDs are refused.

Locks contain a random token, PID, hostname, creation time, and heartbeat. A live owner retains exclusivity regardless of age. Recovery requires both a stale heartbeat and an explicitly dead local owner; token checks prevent one owner releasing another lease. This is local-host coordination, not distributed locking.

## Monotonic terminal state and cancellation

`completed`, `failed`, `cancelled`, and `needs_user` are immutable run terminals. Cancellation aborts the local watcher before awaiting durable I/O, then commits cancellation. Late completion is ignored. MCP task terminal results are immutable and written once.

A hard process/machine failure at the exact boundary between an external browser action and disk write remains a limitation: those operations cannot be one atomic transaction. Atomic rename, durable submission state, owner-aware locks, and restart reconciliation reduce risk; ambiguous submission is never repaired by prompt replay.

## Chrome model and completion verification

For requested `Pro`, GPT-Control locates the actual composer selector, selects Pro when needed, reads it back, fills the prompt, and reads it again immediately before send. It fails before send when the selector is absent, unavailable, ambiguous, mismatched, or changes.

Account plan/profile labels, wordmarks, prompt content, and requested values are not model evidence. Requested and observed model fields remain separate.

Completion requires a newer assistant turn with stable non-empty output and no active answering, thinking, stop, tool-running, Retry, Continue, interruption, or error indicator. Transient labels and partial tool summaries are never hashed as final output.

Recovery has a bounded budget/backoff. It may re-observe, reload the same tab, restore the exact proved conversation URL, re-read turns, or use an explicit live Retry/Continue control. It never blindly resends the prompt or creates a replacement conversation.

## Paid requests and endpoints

The official OpenAI endpoint is pinned by default. Inherited `OPENAI_BASE_URL` is ignored. An alternate endpoint needs an explicit trusted endpoint plus permission and is recorded in receipts without credentials.

Every Responses request, including every follow-up, needs a fresh trusted `confirmPaidRequest` callback. Prior approval is not reusable. The stock CLI/MCP server has no interactive confirmation broker and therefore fails closed for paid Responses calls unless embedded in an operator-controlled host.

## Child-process and diagnostics safety

Chrome prompt bodies and attachment paths use private temporary request files, not child-process argv, and those files are removed after use. Provider prompts use SDK request bodies. Non-zero or killed Bridge/Oracle processes fail even with success-looking stdout; success is parsed only after exit/schema validation.

Oracle is discoverable passively but disabled for execution because its current CLI contract would expose prompt/attachment data through argv.

`gpt_diagnose` is passive and executes no discovered Bridge, Oracle, Codex, or model program. `gpt_diagnose_active` is separate and requires trusted permission.

## Pro-worker task security

- Trusted policy caps fair durable concurrency at three across broker processes.
- Each worker has an independent session, tab, conversation, run, and cancellation path.
- Idempotency keys bind one logical request and reject conflicting reuse.
- Durable task state/result supports reconnect and restart recovery.
- Status/progress notifications are advisory, never proof of completion.
- A terminal result is trusted only after final-turn verification and truthful receipt creation.
- The original prompt is never resubmitted as a status check or recovery tactic.

A worker may use connected ChatGPT tools such as GitHub or Zenbox only when the target account and live conversation make them callable. GPT-Control does not grant, synthesize, or infer those permissions from prompt text.

## Known limitations

- ChatGPT DOM/selectors can change; failures must remain fail-closed.
- No end-to-end proof establishes that MCP status/progress notifications wake a dormant Codex chat or inject a model-visible message.
- Local filesystem durability and local-host leases are not distributed consensus.
- Provider retention/deletion behavior is outside the broker.
- Local beta scope excludes sensitive repositories until independent review and manual Chrome validation are complete.

## Reporting

Do not include credentials, private browser HTML, personal ChatGPT content, or sensitive repository data. Provide the smallest reproducible case and exact version/commit.
