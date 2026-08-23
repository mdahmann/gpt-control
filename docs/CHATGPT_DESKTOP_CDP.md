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

The private desktop ownership state stores no prompt or assistant text. It
stores a SHA-256 prompt hash and marks Send as attempted before it clicks the
button. GPT-Control's separate broker state still stores the durable request,
result, and recovery evidence required by GPT Chat and Worker workflows. If the
Send boundary is ambiguous, the driver observes the existing conversation and
refuses automatic replay.

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

The production doctor and launcher execute the bundled TypeScript protocol-v2
driver. Earlier JavaScript prototype fixtures remain only for historical unit
tests and are excluded from the published package.

## Separate native worker processes

Use the pool driver when GPT-Control should run in the native app without
sharing or covering the window that you use. The pool creates a separate,
officially signed ChatGPT/Codex process for each active lane. Each lane has its
own persistent profile, private driver state, and loopback CDP port.

```sh
export GPT_CONTROL_BROWSER_DRIVER="$PWD/bin/gpt-control-desktop-pool-driver"
export GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE=6
```

The default pool size is six. The operator can set a value from one through ten.
The first lane uses port `9237`; later lanes use consecutive ports. These can be
changed with `GPT_CONTROL_DRIVER_DESKTOP_POOL_START_PORT` and
`GPT_CONTROL_DRIVER_DESKTOP_POOL_ROOT`.

Each new lane first attempts a hidden bootstrap. On the tested Mac, the signed
app exposed an authenticated ChatGPT renderer without any native window. If a
profile instead requires sign-in or first-run interaction, authorize one visible
setup run with:

```sh
export GPT_CONTROL_DRIVER_DESKTOP_ALLOW_INTERACTIVE_BOOTSTRAP=1
```

With that gate, the uninitialized lane can briefly show its native window.
GPT-Control waits for one authenticated ChatGPT composer, writes a private
bootstrap receipt, minimizes the lane, and restores the previous app. Remove
the variable after the requested lanes are initialized. Later launches use the
hidden/background path. Without the gate, a failed hidden bootstrap returns a
precise blocker and does not fall back to a visible window.

On demand, the driver:

1. finds an existing exact lane or starts a new native process with its lane's
   `--user-data-dir` and loopback CDP port;
2. verifies the app signature, executable, listening PID, profile, and port;
3. minimizes only that worker process's windows;
4. restores the app that was active before launch, but only if the worker still
   has focus;
5. routes later actions by the exact durable session ID;
6. stops the exact worker process after its final owned session closes.

If a worker process crashes, GPT-Control does not launch a replacement against
its durable session. An exact close can release the offline session only after
the driver proves that the lane port has no listener and no process uses the
lane profile. Normal recovery never adopts a different process or renderer.

The worker windows stay minimized during normal use, so they do not overlap the
user's main ChatGPT/Codex window. macOS does not provide a supported public API
for assigning another app's window to a Space. A user can unminimize a worker
and move it to another Space manually, but GPT-Control does not depend on that.
The first process launch can briefly activate a window on some macOS versions;
the driver immediately minimizes it and restores focus. Reusing a live lane
does not launch another window.

The pool uses separate native processes, not extra windows in the user's app
process. A friendly label such as “GPT Workers” is documentation only. Runtime
identity comes from the exact signed PID, profile root, port, renderer, and
session receipt.

Read-only sidebar discovery is also available through
`gpt_conversation_find`. It extracts each exact provider conversation ID from
the signed app's local rendered row identity. It does not select a row, start a
process, or create a window. The pool uses an already-running unreserved lane
and returns a blocker when none is available. After
an exact attachment, `gpt_conversation_read` can return the newest 1–20 visible
turns and `gpt_conversation_status` can report live state without sending.
Exact attachment always creates a separate owned renderer and therefore also
requires `GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1`; it never borrows
the user's current window.

## Explicit live acceptance

Deterministic verification does not open ChatGPT or send a message. Live
acceptance is a separate operator action. It defaults to one ordinary
web-development question, uses the installed MCP product path, archives the
disposable chat, proves that the pool is empty, and records only bounded
identity receipts. It also writes an attempt receipt before startup and refuses
another live run for 24 hours by default.

Set an explicit installed package root and the exact mutation acknowledgement:

```sh
export GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT="$HOME/plugins/gpt-control"
export GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE=I_UNDERSTAND_THIS_CREATES_CHATGPT_CONVERSATIONS
export GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1
export GPT_CONTROL_ACCEPTANCE_TRUSTED_SOURCE_ROOT="$PWD"
export GPT_CONTROL_ACCEPTANCE_EXPECTED_HEAD="$(git rev-parse HEAD)"

node scripts/chatgpt-desktop-acceptance.mjs \
  --confirm --send --install-root "$GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT" \
  --request-file ./desktop-live-request.json
```

Do not use a stress run as an ordinary smoke test. Multiple sessions require a
second acknowledgement and `--stress`. The product-path runner starts all
requested MCP calls concurrently, requires a distinct pool-lane receipt for
each result, and treats any archive, close, listener, profile-process, or state
cleanup failure as a failed acceptance:

```sh
export GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_STRESS=I_UNDERSTAND_THIS_STARTS_MULTIPLE_CHATGPT_SESSIONS

node scripts/chatgpt-desktop-acceptance.mjs \
  --confirm --send --stress --count 2 \
  --install-root "$GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT" \
  --request-file ./desktop-live-request.json
```

The local cooldown can be configured from 1 through 168 hours with
`GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_COOLDOWN_HOURS`. Bypassing it requires the
separate operator-only `GPT_CONTROL_DESKTOP_LIVE_ACCEPTANCE_OVERRIDE=1` gate and
must not be part of an automated test suite. This safeguard applies only to the
explicit live-acceptance script. It does not rate-limit normal GPT-Control
Chats, Workers, or Sub-agents.

`desktop-cdp-live-smoke.mjs` remains a low-level exploratory driver harness. It
is not canonical acceptance evidence. It refuses raw attachment tests because
only `gpt_chat` exercises the production immutable-snapshot boundary, and it
now fails if any archive or close operation fails.

The single-process driver uses the user's normal app process and requires that
process to start with the loopback CDP flags. The pool driver does not restart
that process. It launches separate processes with persistent pool profiles and
uses only those processes for worker sessions.

Earlier experimental heads observed several independent native processes and
replies, but those raw-driver runs did not prove the normal GPT-Control client
or fail-closed cleanup. Version 0.5.0-alpha.5 therefore makes no current
installed-product live claim until the canonical runner passes at the exact
installed commit after the account cool-down.

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

The canonical runner accepts questions, production attachment paths, model,
effort, and workspace root through a private mode-0600 request file so these
values do not appear in process arguments:

```json
{
  "questions": ["What is one practical use for a container query?"],
  "files": ["docs/non-sensitive-web-note.md"],
  "model": "GPT-5.6 Sol",
  "effort": "High",
  "workspaceRoot": "/absolute/trusted/workspace"
}
```

```sh
chmod 600 ./desktop-live-request.json

node scripts/chatgpt-desktop-acceptance.mjs \
  --confirm --send --install-root "$GPT_CONTROL_ACCEPTANCE_INSTALL_ROOT" \
  --request-file ./desktop-live-request.json
```

The runner does not print prompt or assistant text. It records the exact local
run/session/lane identities, requested-versus-observed model receipts, provider
URL hash, attachment-manifest hash, installed runtime-bundle hashes, trusted
source head, and complete atomic offline cleanup proof. The installed launchers
and bundles must resolve inside the install root and match the clean trusted
exact-head build byte for byte.

## Alpha release gates

Do not make this the default driver until the signed-in app proves:

- one exact send and assistant-turn read-back;
- live model and effort discovery, selection, and immediate pre-send read-back;
- file upload and screenshot behavior;
- exact continuation and renderer-restart recovery;
- cancellation and ambiguous Send no-replay behavior;
- background operation without focus stealing;
- distinct renderer ownership at concurrency 1, 2, 3, and 6.

Historical raw-driver exercises covered model and project discovery, model
switching, upload, reload continuation, cancellation, organization controls,
and multiple renderers. Those observations are not acceptance evidence for
0.5.0-alpha.5. The exact installed package must pass the canonical 1, 2, 3, and
6 staircase after low-volume account access is restored; the PR remains draft
until then.
