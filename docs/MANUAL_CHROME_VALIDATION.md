# Manual Chrome / Pro Validation

Use only a non-sensitive test repository and disposable prompts. Do not save browser HTML, account content, credentials, or private ChatGPT answers as evidence.

## Preconditions

1. Chrome Bridge endpoint and extension are connected.
2. The signed-in ChatGPT account exposes the composer intelligence/model selector.
3. Trusted policy allows only `chrome_bridge` for the test and sets an empty schema-2 `GPT_CONTROL_HOME`.
4. Bun dependencies and deterministic tests pass.
5. `gpt_diagnose` reports passive discovery. Run `gpt_diagnose_active` only after explicitly enabling trusted active diagnostics.

Record exact package SHA, Bridge version/SHA, Codex version, and UTC time.

## A. First-tab race

1. Start a fresh `gpt_subagent_run` with a unique idempotency key.
2. Observe that the owned tab may begin at `chrome://newtab/`.
3. Verify GPT-Control performs no fill/upload/click before the tab reaches `https://chatgpt.com` and the composer is usable.
4. Verify the prompt appears exactly once.
5. Expected: one completed/blocker result; no `Refused tab outside https://chatgpt.com` race error.

## B. Live Pro selection and provenance

1. Note the account-plan/profile label separately from the composer selector.
2. Start a worker requesting Pro.
3. Verify GPT-Control reads the composer selector, switches it to `Pro` when needed, and reads it back.
4. Change the selector before send in a controlled test if possible; GPT-Control must fail closed without submitting.
5. Inspect the receipt:
   - `requestedModel: "Pro"`
   - `observedModel` equals the live composer label
   - `modelVerified: true`
   - `modelEvidenceKind: "composer_selector"`
   - `modelVerifiedAt` is present
6. Account labels such as `Miles Pro` must not appear as selector evidence.

## C. No partial completion

1. Submit a long tool-using Pro task.
2. While ChatGPT shows Stop answering, thinking, tool activity, or a partial assistant block, verify the MCP task remains working.
3. Ensure no receipt/result hash is finalized from labels such as `Pro thinking` or tool summaries.
4. Wait until answering/tool indicators disappear and the assistant content remains stable across observations.
5. Expected: the terminal result contains the full final answer, not the transient label or partial text.

## D. Same-conversation recovery

1. Start a task and record the owned tab/session plus proved `/c/<id>` conversation URL.
2. Cause one bounded reload. If ChatGPT lands on Home, allow GPT-Control to restore only the exact recorded conversation URL.
3. If turns do not render, allow the bounded same-URL reload path.
4. Verify the existing turns/final answer are re-read.
5. Verify the original prompt was submitted once and no duplicate conversation was created.
6. Inspect `recoveryAttempts` for truthful action/reason/outcome entries.

## E. Explicit error controls

Exercise non-sensitive cases that visibly produce network error, Retry, interrupted generation, failed tool turn, or Continue generating.

- GPT-Control may re-observe/reload/restore the same URL.
- It may click Retry/Continue only when the live control proves it applies.
- It must never blindly fill/send the original prompt again.
- After the budget, expect `needs_user` with exact reason and retained tab/conversation identity.
- Confirm a later page update cannot change that terminal state to completed.

## F. Three workers

1. Start three independent workers with unique keys and different prompts.
2. Verify three owned tabs, conversations, runs, and task IDs.
3. Start a fourth and verify fair queueing until a slot opens.
4. Cancel one worker and verify the other workers continue.
5. Disconnect/reconnect the MCP client and verify durable task get/result works.
6. Gracefully restart the MCP server during a submitted task; verify observation resumes in the same tab and the prompt is not replayed.

## Acceptance evidence

Retain only privacy-safe evidence:

- exact base/head SHAs;
- command/test outputs and exit codes;
- package/SDK/Codex/Bridge versions;
- sanitized run/task IDs;
- receipt field names and booleans/hashes;
- recovery action names/outcomes;
- prompt submission count from a disposable test.

Do not retain prompt bodies, attachment paths containing personal data, browser HTML, screenshots with account content, cookies, tokens, or private answers.
