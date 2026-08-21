# GPT-Control

GPT-Control is a local broker that lets Codex use ChatGPT Pro as a bounded worker while Codex remains the orchestrator. It also supports independent review and chat through trusted transports.

Version 0.2.1 is intended for a **local beta on non-sensitive repositories**. It is not self-certified for production or high-sensitivity data.

## 0.2.1 hardening

The broker now:

- snapshots approved attachment bytes into private broker-owned files and exposes only those snapshots;
- keeps workspace, sensitive-file, paid-request, endpoint, and focus authority outside model-call arguments;
- verifies the live ChatGPT composer selection before each Chrome submission;
- requires a stable final assistant turn, not thinking labels, partial tool summaries, or answering states;
- recovers the same owned ChatGPT conversation without blindly resending a prompt;
- stores observed model and provider provenance separately from requested values;
- uses strict IDs, symlink-safe confinement, ownership-aware locks, and monotonic terminal states;
- exposes durable MCP tasks for up to three Pro workers, with a one-response fallback when tasks are unavailable.

See [SECURITY.md](SECURITY.md), [MIGRATION.md](MIGRATION.md), and [docs/CODEX_SUBAGENTS.md](docs/CODEX_SUBAGENTS.md).

## Architecture

Codex owns planning, repository authority, and final decisions. GPT-Control owns only bounded provider interaction:

1. Trusted operator policy fixes roots, allowed transports/models, endpoint, attachment exceptions, diagnostics, paid confirmation, and concurrency.
2. Attachments are snapshotted once. Original workspace or parent directories are not granted as attachment authority.
3. A Pro worker gets one owned disposable ChatGPT tab. GPT-Control waits through the first-tab navigation race, verifies the actual composer says `Pro`, fills the prompt, verifies `Pro` again, and sends once.
4. Durable state tracks submission state, tab/session identity, real ChatGPT conversation URL when proved, recovery attempts, and terminal state.
5. Completion requires a newer stable assistant turn with no answering, thinking, stop, tool-running, Retry, Continue, interruption, or error state.
6. Task state/results persist across reconnects. Restart recovery re-observes the existing conversation and never replays an ambiguous in-flight request.

## Install

Bun is required.

```bash
bun install --frozen-lockfile
bun run check
bun test
```

The Codex plugin package includes `.codex-plugin/plugin.json`, `.mcp.json`, `agents/openai.yaml`, `skills/gpt-control/SKILL.md`, and `bin/gpt-control-mcp`.

Manual stdio registration is also supported:

```bash
codex mcp add gpt-control -- /absolute/path/to/gpt-control/bin/gpt-control-mcp
```

The wrapper resolves its repository root and prefers `GPT_CONTROL_BUN`, system Bun, or a local Bun binary. On hosts without Bun it uses the pinned `npx --yes bun@1.4.0` compatibility fallback; operators who prohibit registry-backed launchers should install an approved Bun executable and set `GPT_CONTROL_BUN`.

## Trusted operator configuration

Tool input can narrow behavior but cannot widen these boundaries.

| Variable | Meaning | Default |
| --- | --- | --- |
| `GPT_CONTROL_HOME` | Records, locks, tasks, snapshots, output | `~/.gpt-control` |
| `GPT_CONTROL_WORKSPACE_ROOT` | Workspace attachment boundary | current directory |
| `GPT_CONTROL_SNAPSHOT_ROOT` | Private snapshot root | `$GPT_CONTROL_HOME/snapshots` |
| `GPT_CONTROL_OUTPUT_ROOT` | Confined generated-output root | `$GPT_CONTROL_HOME/generated` |
| `GPT_CONTROL_ALLOWED_TRANSPORTS` | Trusted transport allowlist | `chrome_bridge,codex` |
| `GPT_CONTROL_ALLOWED_MODELS` | Allowed non-Chrome models | unset |
| `GPT_CONTROL_PROVIDER_MODEL` | Trusted default non-Chrome provider model | provider-specific default |
| `GPT_CONTROL_BUN` | Trusted Bun executable for the plugin launcher | discovery/pinned npx fallback |
| `GPT_CONTROL_MAX_PRO_WORKERS` | Fair Pro-worker limit, integer 1-3 | `3` |
| `GPT_CONTROL_ALLOW_OUTSIDE_WORKSPACE` | Permit outside-workspace snapshots | disabled |
| `GPT_CONTROL_ALLOW_SENSITIVE_FILES` | Permit conservative secret matches | disabled |
| `GPT_CONTROL_OPENAI_BASE_URL` | Trusted alternate Responses endpoint | official endpoint |
| `GPT_CONTROL_ALLOW_ALTERNATE_OPENAI_ENDPOINT` | Permit alternate endpoint | disabled |
| `GPT_CONTROL_ALLOW_ACTIVE_DIAGNOSTICS` | Permit active probes | disabled |
| `GPT_CONTROL_BRIDGE` | Trusted Chrome Bridge command | discovery |
| `GPT_CONTROL_BRIDGE_CLIENT_SCRIPT` | Trusted Bridge `test_client.py` | discovery |
| `GPT_CONTROL_PYTHON` | Trusted Python for private Bridge RPC | discovery |

Inherited `OPENAI_BASE_URL` is ignored. An alternate endpoint requires both trusted endpoint variables and is recorded in receipts.

The stock CLI/MCP server has no interactive paid-confirmation broker. Responses calls fail closed unless an embedding supplies a fresh trusted `confirmPaidRequest` callback for every request, including follow-ups.

## Codex-facing tools

### Pro workers

- `gpt_subagent_run`: task-based start-and-complete. Requires `prompt` and a caller-stable `idempotency_key`; accepts `files` and `timeout_ms`.
- `gpt_subagent_get`: durable lookup by exactly one `run_id` or `task_id` after reconnect/recovery.
- `gpt_subagent_cancel`: independent cancellation by exactly one `run_id` or `task_id`.
- `gpt_subagent_list`: bounded active-run overview; not a polling requirement.

A task-aware client receives task status/progress and one terminal result. A client without MCP task support receives one long-running response at terminal state. Codex should not send "are you done?" prompts or repeatedly call status while a task result is pending.

### Review and utilities

- `gpt_consult`: structured independent review with validated file/line evidence.
- `gpt_chat`: one provider conversation turn.
- `gpt_image`: owned-tab image generation with policy-confined output.
- `gpt_run` / `gpt_run_cancel`: exact durable lookup/wait and monotonic cancellation.
- `gpt_conversation_close`: local owned-session cleanup; provider history is not deleted.
- `gpt_diagnose`: passive discovery only; executes no discovered Bridge, Oracle, Codex, or model program.
- `gpt_diagnose_active`: explicit active smoke test, only under trusted policy.

## Truthful provenance

Chrome receipts distinguish `requestedModel`, `observedModel`, `modelVerified`, `modelEvidenceKind`, and `modelVerifiedAt`. Account plan labels such as `Miles Pro`, wordmarks, profile text, prompt content, and requested values are never model evidence.

Local Bridge session IDs and DOM turn counts are explicitly local/synthetic. Only a proved ChatGPT conversation URL/ID is provider conversation provenance.

## Attachments and completion

Each attachment is opened with no-follow semantics, verified as a regular file, snapshotted once, hashed from transmitted bytes, and line-counted. Symlink/replacement races fail closed. Codex receives only the snapshot directory in a read-only sandbox.

Sensitive-file detection intentionally favors false positives and covers `.env*`, `.npmrc`, `.netrc`, Git/cloud credentials, SSH keys, Docker auth, service-account material, and similar stores. Only trusted policy can override it.

A Chrome run becomes `completed` only from a stable newer assistant turn. Timeout, interruption, network error, Retry, Continue generating, or exhausted recovery becomes `needs_user`/`failed` and cannot later be overwritten.

Recovery is bounded: re-observe, reload the same owned tab, restore the exact known conversation URL if ChatGPT lands on Home, re-read turns, and use explicit live Retry/Continue controls only when applicable. It never blindly resends the original prompt or creates a duplicate recovery conversation.

## Verification

```bash
bun install --frozen-lockfile
bun run check
bun run test:security
bun run test:chrome
bun run test:subagents
bun test
```

See [docs/MANUAL_CHROME_VALIDATION.md](docs/MANUAL_CHROME_VALIDATION.md).

## Codex callback boundary

The installed MCP SDK and Codex runtime expose task status/progress and task get/result/cancel protocol support. GPT-Control does **not** claim that a notification injects a new model-visible chat message or wakes a dormant Codex thread; that was not proved end to end. The strongest supported no-poll mechanism is a task-based or long-running tool call that returns once at terminal state, backed by durable recovery lookup.
