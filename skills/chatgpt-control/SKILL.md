---
name: chatgpt-control
description: This skill should be used when the user asks to "ask ChatGPT", "get a second opinion", "have another model review this", "check this with GPT", "generate an image", "iterate on that image", "continue my ChatGPT conversation", or "which ChatGPT transport is active". Not for ordinary web browsing, and not as a substitute for verifying code by running it locally.
version: 0.1.1
---

# ChatGPT Control

Four tools reach a signed-in ChatGPT session: `chatgpt_consult` for review with
files, `chatgpt_chat` for conversation turns, `chatgpt_image` for generation and
iteration, `chatgpt_job` for inspection and diagnosis.

## When a second model earns its cost

Consult on judgment calls where being wrong is expensive and the repository
cannot settle it: architecture and migration plans, security-sensitive designs,
a bug that survived two real attempts, or a tradeoff between approaches.

Do not consult for anything the working tree already answers. Reading the source,
running the test, or checking the log is faster and more reliable than asking a
model that cannot see the machine.

## Writing the prompt

The model starts with zero project knowledge and remembers nothing between
calls, so each request carries its own briefing.

1. State the exact question and the output you want, such as a patch plan, a
   risk list, or a decision with reasons.
2. Give the constraints that rule answers out: API compatibility, performance
   budgets, files that must not change, and what was already tried.
3. Attach the smallest file set containing the relevant truth. Attachments beat
   pasted excerpts because line numbers and imports survive.
4. Never attach secrets, credentials, or private keys.

## Operating rules

1. Treat every response as advisory. Verify it against current source and
   runtime behavior before acting on it.
2. Keep the returned `job_id`. Inspect with `chatgpt_job` rather than resubmitting
   when a response is slow.
3. Close a job when the conversation is finished. Closing affects only the tabs
   that job created.
4. Iterate images inside one job by passing its `job_id`, which preserves the
   reference chain.
5. Paid API mode requires the user to intend it. Pass `api_confirmed` only on
   explicit instruction.

## When the tools report no transport

The failure text names what to install. Chrome Bridge is the recommended path
because it reuses the browser the user is already signed into and never takes
focus. Run `chatgpt_job action="diagnose"` to see what was detected before
suggesting an install.

Image work requires Chrome Bridge. Report that requirement rather than
substituting a text description of an image.
