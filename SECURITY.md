# Security model

GPT-Control 0.3.1 treats the model-facing tool call, browser page, connected
tools, provider output, attachment paths, child-process output, and recovered
local state as untrusted.

## Operator authority

Only trusted process environment or constructor policy can authorize:

- the workspace, state, snapshot, and output roots;
- outside-workspace or sensitive-file access;
- attachment, prompt, and worker limits;
- the selected transport; and
- active diagnostics.

Tool arguments may narrow this authority. They cannot expand it. Legacy Oracle
CLI execution is disabled because its request path exposes prompts or attachment
paths through process arguments.

## Installed MCP runtime

Codex plugin installation does not execute a dependency installer or build hook.
The repository commits a Node-compatible MCP bundle, and verification rebuilds
it from `src/mcp.ts` and requires a byte-for-byte match. The launcher fails
closed when the bundle or a trusted Node executable is unavailable. Bundled
third-party license texts are preserved in `THIRD_PARTY_NOTICES.md`.

## Browser-driver protocol v2

A usable driver must attest protocol version 2 and secure stdin/private-RPC
input. Driver responses are schema validated and size bounded. Environment
variables passed to external drivers are allowlisted. Prompt entry and send are
separate operations so GPT-Control can persist the crash boundary.

Chrome Bridge is accepted only through the private request-file RPC adapter.
The request file is mode 0600, removed after use, and carries prompt and snapshot
paths outside argv.

## Exact conversation ownership

GPT-Control records and rechecks the driver ID, session ID, session name, page
ID, ChatGPT origin, canonical conversation URL, and assistant-turn baseline.
Once a `/c/<id>` URL is known, another valid conversation is still drift. The
broker may restore the recorded URL in the same page; it does not silently adopt
another conversation or create a replacement page.

## Crash and cancellation semantics

The plaintext durable request exists only while a run is `not_submitted`. Before
the browser click, GPT-Control writes `submitting`, deletes replay-capable
plaintext, rechecks terminal state, and then sends once. After that boundary a
restart may observe only. It never replays an ambiguous submission.

Terminal run records are immutable across processes. MCP task runs are bound and
return `taskCreated` before a short activation grace; immediate cancellation can
seal the run before browser submission. Cancellation is persisted before
best-effort UI stop, so a late provider answer cannot overwrite `cancelled`. Process shutdown suspends watchers without falsely failing or
cancelling submitted work.

## Attachment and output boundaries

Attachments are opened without following symlinks, checked before and after
read, capped, hashed, copied into a private immutable snapshot, and uploaded
from that snapshot only. Sensitive filenames and paths fail closed unless
trusted policy explicitly enables them. Structured finding line ranges are
validated against the transmitted snapshot.

Generated artifacts are confined to the trusted output root. Redirects,
non-image responses, oversized bodies, unsafe hosts, and symlinked directories
are rejected.

## Connected tools

Connector names in a Pro-worker request express intent only. They do not grant
permissions or prove availability. Required connectors must be verified by the
worker; unavailable required connectors produce a blocker. Connector output is
untrusted evidence and must retain attribution.

## Reporting issues

Do not include real prompts, cookies, provider conversations, uploaded source,
access tokens, or private state files in a public report. Provide a minimal
reproduction using disposable data.
