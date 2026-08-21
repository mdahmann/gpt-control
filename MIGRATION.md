# Migration to storage schema v3

GPT-Control 0.3.1 stores state under `~/.gpt-control/v3` by default. Schema v3
is intentionally isolated because previous 0.2 and early 0.3 builds both used a
version-2 marker for incompatible record shapes.

## What migrates automatically

Nothing is replayed automatically. New runs start in v3. Older completed output
can remain as historical evidence in its original directory.

## What must not be replayed

Do not copy or rename queued, running, `submitting`, or `submitted` v2 records
into v3. Their exact browser ownership, model evidence, prompt-deletion state,
and cancellation semantics cannot be proven under the new contract.

## Safe procedure

1. Leave the old state directory unchanged as an archive.
2. Install 0.3.1 and confirm `gpt_diagnose` reports the expected trusted roots.
3. Start a new disposable run and verify its v3 receipt.
4. Recreate any desired follow-up as a new explicit prompt. Do not infer an
   exact-conversation continuation from a legacy local session identifier.

The preserved `pro/security-hardening-0.2.0` checkpoint is evidence only and is
not a merge or migration source.
