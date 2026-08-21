# Changelog

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
