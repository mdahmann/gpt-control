# Experimental ChatGPT Desktop CDP driver

This alpha adds an opt-in external browser-driver protocol-v2 adapter for the
official signed macOS ChatGPT app. It does not replace Chrome Bridge and it is
not selected automatically.

## Security boundary

The driver accepts requests only on stdin and returns one strict JSON envelope.
It verifies all of these conditions before an action:

- the app signature has OpenAI Team ID `2DC432GLL2`;
- the bundle ID is `com.openai.codex` or `com.openai.chat`;
- the listening process executable is the verified app executable;
- the process has an explicit loopback debugging address and port;
- the HTTP and WebSocket endpoints stay on the same loopback port;
- the session still owns the exact renderer and ChatGPT URL.

The durable state root is private. Prompt text is not stored there. The driver
stores a SHA-256 prompt hash and marks Send as attempted before it clicks the
button. If that boundary is ambiguous, it observes the existing conversation
and refuses automatic replay.

## Read-only macOS diagnostic

Quit the app before relaunching it with CDP. If Codex is running inside this
same app, save your work first because quitting it ends the current UI process.

```sh
open -na /Applications/ChatGPT.app --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9236

export GPT_CONTROL_BROWSER_DRIVER="$PWD/bin/gpt-control-desktop-driver"
export GPT_CONTROL_DRIVER_DESKTOP_CDP_ENDPOINT="http://127.0.0.1:9236"

node scripts/desktop-cdp-live-smoke.mjs
```

The default diagnostic verifies the app, listener, endpoint, and target list.
It does not create a conversation or send a message.

Read-only sidebar discovery is also available through
`gpt_conversation_find`. It extracts each exact provider conversation ID from
the signed app's local rendered row identity. It does not select a row. After
an exact attachment, `gpt_conversation_read` can return the newest 1–20 visible
turns and `gpt_conversation_status` can report live state without sending.
Exact attachment always creates a separate owned renderer and therefore also
requires `GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1`; it never borrows
the user's current window.

## Explicit live acceptance

The live harness sends one ordinary web-development question from a small
rotating set, requires one stable reply, and then releases its local session
ownership. It does not add test tokens or machine-looking verification text to
the conversation. After read-back, it archives the disposable chat through the
same desktop session. It does not run unless this separate mutation gate is present:

```sh
GPT_CONTROL_DESKTOP_LIVE_MUTATION=1 \
node scripts/desktop-cdp-live-smoke.mjs --live
```

Additional renderers are disabled by default. To test more than one distinct
session, explicitly enable target creation. The driver uses the signed app's
loopback CDP endpoint to create one exact independently owned background
window and records the returned renderer ID:

```sh
export GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1

GPT_CONTROL_DESKTOP_LIVE_MUTATION=1 \
node scripts/desktop-cdp-live-smoke.mjs --live --concurrency 2
```

Repeat with concurrency `3` and `6`. A clean capacity blocker is acceptable.
Two workers silently sharing one renderer is a failure.

The unified ChatGPT/Codex macOS app permits only one normal-profile process.
Start that process with the loopback CDP flags before opening the Codex thread
that will use GPT-Control. A temporary `--user-data-dir` is suitable for
failure-path tests, but it is not proof that the normal signed-in ChatGPT
profile can create a ready composer. Do not restart the unified app during an
active Codex turn.

The current macOS acceptance has proved one hidden/background session and two
independent concurrent windows without changing the frontmost app during chat
work. For the least disruption, keep the dedicated GPT-Control app instance on
another Space and create the desired worker-window pool before starting long
work.

Native-shell clicks use trusted CDP mouse input. A capture-phase guard checks
the exact provider conversation and clicked element inside the page when the
trusted event arrives. A conversation change or layout miss blocks the event.
Direct `/c/<id>` attachment uses the exact native sidebar row and requires
stable identity read-back before any management action.

Native reload checks the provider conversation and schedules the reload inside
the same page evaluation. Keyboard cleanup uses a capture-phase guard for
`Escape`, `ArrowLeft`, and title-confirmation `Enter`. Upload marks one enabled
file input, checks the conversation before and after the CDP file assignment,
and refuses a missing or changed input.

The live harness can exercise these paths in one disposable conversation:

```sh
GPT_CONTROL_DESKTOP_LIVE_MUTATION=1 \
node scripts/desktop-cdp-live-smoke.mjs --live \
  --discover-models --discover-projects \
  --model "GPT-5.6 Sol" --effort High \
  --upload ./path/to/a/non-sensitive-file.md \
  --reload --pin --rename "Web Development Notes" \
  --project "Projects"
```

Run cancellation separately with `--cancel`. The harness attempts to archive
every conversation during cleanup, including a run that fails after submission.

## Alpha release gates

Do not make this the default driver until the signed-in app proves:

- one exact send and assistant-turn read-back;
- live model and effort discovery, selection, and immediate pre-send read-back;
- file upload and screenshot behavior;
- exact continuation and renderer-restart recovery;
- cancellation and ambiguous Send no-replay behavior;
- background operation without focus stealing;
- distinct renderer ownership at concurrency 1, 2, 3, and 6.

As of the current experiment, live model and project discovery, model switching,
upload, exact reload continuation, cancellation, pin, rename, project move,
archive, and three concurrent renderer identities have passed. Project move and
upload passed in separate disposable workflows; ChatGPT refused one combined
uploaded-chat project move, and the driver surfaced that refusal. Six concurrent
renderers remain a release gate because one renderer became ineligible and the
driver failed closed.
