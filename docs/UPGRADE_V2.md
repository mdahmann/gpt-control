# Schema v2 to v3 upgrade guard

GPT-Control does not automatically import schema-v2 browser runs. Version 2
does not contain every exact-turn ownership field required by the hardened
schema-v3 recovery path. Treating those records as v3 could replay, stop, or
attribute the wrong ChatGPT turn.

The default schema-v3 broker therefore refuses to start when legacy `runs/` or
`conversations/` records remain directly under `~/.gpt-control`.

Before enabling v3:

1. Stop all GPT-Control v2 and v3 broker processes.
2. Inspect every non-terminal v2 run and its recorded browser session. Stop or
   otherwise resolve any provider turn that can still be active.
3. Preserve the complete v2 state directory as a read-only archive outside the
   active `~/.gpt-control` directory. Do not copy individual records into `v3`.
4. Start v3 with its clean default root at `~/.gpt-control/v3` and run passive
   diagnosis before an active smoke test.

Schema-v2 conversation and run IDs are not available in v3. Keep the archive
for audit evidence only. Setting an explicit clean `GPT_CONTROL_HOME` is an
operator override; it does not reconcile provider work left in another state
root.
