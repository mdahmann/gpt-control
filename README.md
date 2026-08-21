# chatgpt-control

Typed ChatGPT tools for coding agents: second-model review with real files, durable conversations, and image iteration, driven through the Chrome you are already signed into.

An unofficial, community-maintained integration. It is not affiliated with OpenAI.

## Why this exists

Coding agents are good at the code in front of them and bad at knowing when they are wrong. A second model with a different training run catches design mistakes the first one cannot see. Getting a question to that second model usually means copying files into a browser by hand.

This extension closes that loop. It attaches the files you name, asks ChatGPT, waits for the answer, and hands it back as a tool result.

The interesting part is where the browser comes from.

### Background tabs, not a second browser

Most browser automation launches a fresh Chrome with a remote-debugging port. That browser is signed into nothing, so a ChatGPT subscription is unreachable, and the window steals focus while you work.

With [Chrome Bridge](https://github.com/wolfiesch/chrome-bridge), this extension opens an inactive background tab in the Chrome you already use. Your ChatGPT Pro session is already there. No debugging port is opened, no window appears, and focus stays where you put it. Each request owns its tabs, so cleanup can never close a tab you opened yourself.

### Tools

| Tool | Capability | Approval |
| --- | --- | --- |
| `chatgpt_consult` | Independent review of code, architecture, or a plan, with explicit files attached | write |
| `chatgpt_chat` | Start a conversation or send another turn into one already open | write |
| `chatgpt_image` | Generate or iterate on images, returned inline and saved to disk | write |
| `chatgpt_job` | Inspect, retrieve, close, and diagnose | read |

A bundled skill teaches the agent when to reach for a second opinion and when to answer from the repository instead.

### Transports

The extension picks the least disruptive path available and tells you what it chose.

| | Chrome Bridge | Oracle CLI only | Neither |
| --- | --- | --- | --- |
| Text review | Background tab in your Chrome | Oracle's own Chrome window, or a paid API key | Setup guidance |
| Conversations | Yes | One-shot and followups | Setup guidance |
| Image iteration | Yes | Not supported here | Setup guidance |
| Takes window focus | No | Possibly | n/a |
| Costs money | No, uses your subscription | Only in API mode | n/a |

Nothing is required at install time. With no transport configured, every tool returns the specific thing to install rather than an opaque failure, and `chatgpt_job action="diagnose"` reports exactly what was found.

### Compatibility

Runs on Oh My Pi and on Pi. The host differences it papers over:

- `pi.exec` exists on OMP. On Pi the extension falls back to `child_process`.
- `pi.typebox` exists on both and is used for schemas. A bundled TypeBox keeps direct imports working.
- `pi.setLabel` takes one argument on OMP and two on Pi, so the label is set only where the single-argument form applies.
- `loadMode`, `approval`, and `strict` are honored by OMP and ignored elsewhere.

## Install

### Oh My Pi (OMP)

```sh
omp install github:wolfiesch/chatgpt-control
```

### Pi (`@mariozechner/pi`)

```sh
git clone https://github.com/wolfiesch/chatgpt-control.git
cd chatgpt-control && bun install
ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/chatgpt-control.ts
```

### Browser access

Recommended, and required for images:

```sh
git clone https://github.com/wolfiesch/chrome-bridge.git
cd chrome-bridge && ./setup.sh
# load the unpacked extension in chrome://extensions, then:
chrome-bridge ready
```

Optional fallback for text-only use:

```sh
npm i -g @steipete/oracle
```

### Configuration

Discovery works without configuration when either client is on `PATH` or checked out under `~/Projects`. Override it when your layout differs:

| Variable | Purpose |
| --- | --- |
| `CHATGPT_CONTROL_BRIDGE` | Full command for the Chrome Bridge client |
| `CHROME_BRIDGE_HOME` | Chrome Bridge checkout containing `test_client.py` |
| `CHATGPT_CONTROL_ORACLE` | Full command for the Oracle CLI |
| `CHATGPT_CONTROL_PYTHON` | Python used to run the bridge client |
| `CHATGPT_CONTROL_POLL_MS` | Answer-stability poll interval, default 2000 |
| `CHATGPT_CONTROL_PROBE_MS` | Bridge readiness budget, default 10000 |

## Example requests

- "Ask ChatGPT whether this migration plan has a rollback hole, and attach the two migration files."
- "Get a second opinion on `src/scheduler.ts` before I merge."
- "Generate a hero image for the docs, then make the background darker."
- "Which ChatGPT transport are you using right now?"

## Design

- **Fails closed and says why.** Chrome Bridge enforces an egress allowlist. When it refuses, the tool returns the exact `chrome-bridge policy allow-egress` command instead of silently widening your policy.
- **Image fetches are constrained on purpose.** The bridge's `downloadUrl` takes a bare filename rather than a destination and is confirmation-gated, so generated images are fetched from their pre-signed URL straight into the output directory. That path leaves the bridge's policy behind, so it re-imposes the equivalent limits: the URL host is parsed and matched against an allowlist rather than string-matched, plaintext and redirects are refused, the response must be an image, and the body is capped while streaming. A refusal returns a screenshot of the tab instead of failing the request.
- **No completion selector.** ChatGPT ships no stable "finished" signal, so answers are detected by the page text holding steady across several reads. Composer selectors are tried in order and fall back when the markup changes.
- **Unversioned upstreams are parsed defensively.** Both the bridge and Oracle emit unversioned JSON. Every field is narrowed at the boundary, and Oracle's answer is located by search with raw stdout as the floor.
- **Writes stay contained.** Generated files land under `~/.chatgpt-control/generated` unless `allow_external_output` is set.
- **Paid calls are explicit.** API mode requires `api_confirmed`, and it is never chosen automatically.
- **No implicit `npx`.** The Oracle CLI is used only when it is actually installed, so a tool call never triggers a surprise network install or a silent version change.

## Credits

- [Oracle](https://github.com/steipete/oracle) by Peter Steinberger ([@steipete](https://github.com/steipete)) is the CLI this extension drives in fallback mode, and the original implementation of driving ChatGPT from a terminal.
- [Kyle McCleary](https://github.com/kmccleary3301) built on Oracle in [his fork](https://github.com/kmccleary3301/oracle) and shared the ChatGPT web control and image iteration workflow that this package generalizes into a host-neutral extension.
- [Chrome Bridge](https://github.com/wolfiesch/chrome-bridge) provides the background-tab transport.

## Development

```sh
bun install
bun run check
bun test
```

## License

MIT
