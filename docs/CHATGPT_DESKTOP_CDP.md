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

## Explicit live acceptance

The live harness uses disposable exact-PONG prompts and closes its owned
sessions. It does not run unless this separate mutation gate is present:

```sh
GPT_CONTROL_DESKTOP_LIVE_MUTATION=1 \
node scripts/desktop-cdp-live-smoke.mjs --live
```

Additional renderers are disabled by default. To test more than one distinct
session, explicitly enable target creation:

```sh
export GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1

GPT_CONTROL_DESKTOP_LIVE_MUTATION=1 \
node scripts/desktop-cdp-live-smoke.mjs --live --concurrency 2
```

Repeat with concurrency `3` and `6`. A clean capacity blocker is acceptable.
Two workers silently sharing one renderer is a failure.

## Alpha release gates

Do not make this the default driver until the signed-in app proves:

- one exact send and assistant-turn read-back;
- live model and effort discovery, selection, and immediate pre-send read-back;
- file upload and screenshot behavior;
- exact continuation and renderer-restart recovery;
- cancellation and ambiguous Send no-replay behavior;
- background operation without focus stealing;
- distinct renderer ownership at concurrency 1, 2, 3, and 6.
