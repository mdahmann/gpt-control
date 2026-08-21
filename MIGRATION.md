# Migration to GPT-Control 0.2.1

Version 0.2.1 intentionally breaks interfaces that allowed model-controlled authority expansion or synthetic provenance.

## Storage schema

`STORAGE_VERSION` is now `2`. Version-1 records are not silently reinterpreted under the new security model. Before upgrading:

1. stop every GPT-Control process;
2. retain any receipts needed for audit;
3. move the old `GPT_CONTROL_HOME` to a private backup or choose a new empty home;
4. start 0.2.1 and run passive diagnosis.

Do not copy old lock, request, task, or run files into a schema-2 home.

## Removed model-facing authority fields

The following request/tool fields are removed and rejected rather than deprecated:

- `workspace_root`
- `allow_outside_workspace`
- `allow_sensitive_files`
- `api_confirmed` or reusable paid confirmation
- `allow_focus_steal`
- alternate endpoint/credential fields
- `allow_external_output`

Set the corresponding trusted `GPT_CONTROL_*` policy before starting the MCP server. Follow-ups cannot alter the original policy fingerprint.

## Model selection and provenance

Chrome callers use typed `chatgpt_model: "pro"`; Pro subagents select it automatically. Non-Chrome provider selection uses `provider_model`. It must equal trusted `GPT_CONTROL_PROVIDER_MODEL` or appear in `GPT_CONTROL_ALLOWED_MODELS`; inherited provider-model environment values are not authority.

`requestedModel` is no longer copied into observed provenance. Consumers should inspect:

- `requestedModel`
- `observedModel`
- `modelVerified`
- `modelEvidenceKind`
- `modelVerifiedAt`

Local Bridge session IDs/turn counts are not provider provenance. Use `providerConversationUrl`/`providerConversationId` only when present.

## Attachments

Providers receive immutable broker-owned snapshots rather than original paths. Receipts include stable `relativePath`, size, SHA-256, and physical line count. Code that expected original absolute paths in public output must migrate to `relativePath`.

Outside-workspace or sensitive files now require trusted operator policy; request-level overrides no longer exist. Codex runs use only the snapshot root as their read-only working directory.

## Runs and terminal states

Run terminals are monotonic: `completed`, `failed`, `cancelled`, and `needs_user`. A timeout/recovery blocker remains `needs_user`; it is never later promoted to completed. Consumers must handle `needs_user` as a terminal operator-intervention state.

Cancellation is durable. A late provider response cannot overwrite it.

## Chrome behavior

Chrome Bridge now requires a discoverable trusted `test_client.py` for private request-file RPC. Prompt bodies and attachment paths are not passed through argv. Model selection must be observed and verified before send. Completion/recovery is stricter and may return `needs_user` where 0.2.0 incorrectly returned partial output.

Oracle execution is disabled because its current process interface exposes prompt/attachment data through argv. Passive discovery may still report it.

## MCP and Codex plugin

New tools:

- `gpt_subagent_run`
- `gpt_subagent_get`
- `gpt_subagent_cancel`
- `gpt_subagent_list`
- `gpt_diagnose_active`

`gpt_image` is registered again for MCP parity.

`gpt_subagent_run` requires a caller-stable `idempotency_key`. Task-capable clients get a durable MCP task; other clients get one long-running terminal response. Status/get/list tools are recovery aids, not instructions to poll.

The 0.2.1 plugin package includes `.codex-plugin/plugin.json`, `.mcp.json`, `agents/openai.yaml`, a plugin skill, and a stdio launcher.

## Diagnostics

`gpt_diagnose` is passive and read-only. It no longer runs discovered Bridge, Oracle, Codex, or model programs. Use `gpt_diagnose_active` only after setting trusted `GPT_CONTROL_ALLOW_ACTIVE_DIAGNOSTICS=1`.

## Responses API

Inherited `OPENAI_BASE_URL` is ignored. Alternate endpoints require trusted GPT-Control policy and appear in receipts. Every paid Responses request/follow-up needs a fresh trusted confirmation callback. Stock CLI/MCP use fails closed because no interactive confirmation broker is bundled.
