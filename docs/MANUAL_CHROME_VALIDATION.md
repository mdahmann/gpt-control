# Disposable Chrome validation

Use a disposable browser profile and disposable ChatGPT conversation. Do not
reuse a production task session or real source attachment.

## Preconditions

1. Install dependencies and run the automated suite.
2. Configure a protocol-v2 browser driver or the Chrome Bridge private-RPC
   adapter.
3. Point `GPT_CONTROL_HOME`, snapshot root, and output root at a temporary
   directory.
4. Enable active diagnostics only for this validation process.

## Validation sequence

1. Run passive diagnosis and confirm it executes no adapter.
2. Run active diagnosis and confirm the selected driver reports protocol 2 and
   secure input.
3. Create a disposable chat run without sending sensitive text.
4. Confirm the created session name starts with `gpt-control:` and the recorded
   page ID is unchanged after initial navigation settles.
5. Confirm the composer is switched to Pro and read back as Pro immediately
   before send.
6. Submit one unique harmless prompt and confirm exactly one browser send.
7. Confirm the provider URL becomes canonical `/c/<id>` and is persisted before
   final completion.
8. Navigate the same owned page away, then verify recovery restores the recorded
   URL without creating another page or submitting another prompt.
9. Start a bounded slow turn, cancel it, and confirm the durable run remains
   cancelled even if page text later changes.
10. Close the disposable session and remove the temporary state/profile.

Record exact commands, exit codes, run/conversation IDs, driver ID, page count,
send count, model evidence, and cleanup result. Do not record cookies, prompt
contents, provider responses, or uploaded data.
