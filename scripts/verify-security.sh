#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
EXPECTED_BASE=${GPT_CONTROL_EXPECTED_UPSTREAM_BASE:-37390634844c8b9fc0dc73894b6b72a04f05826c}
umask 077

LOG_PREFIX=${GPT_CONTROL_VERIFY_LOG_DIR:-${TMPDIR:-/tmp}/gpt-control-0.5.0-alpha.4-verification}
LOG_DIR=$(mktemp -d "${LOG_PREFIX%/}.XXXXXX")

if [[ -n "${GPT_CONTROL_BUN:-}" ]]; then
  BUN=${GPT_CONTROL_BUN}
elif [[ -x "$ROOT/node_modules/.bin/bun" ]]; then
  BUN="$ROOT/node_modules/.bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN=$(command -v bun)
elif [[ -x "${HOME:-}/.bun/bin/bun" ]]; then
  BUN="${HOME}/.bun/bin/bun"
else
  printf '%s\n' 'Trusted Bun runtime unavailable. Install dependencies or set GPT_CONTROL_BUN.' >&2
  exit 127
fi
NODE=$(command -v node)

chmod 700 "$LOG_DIR"
cd "$ROOT"

branch=$(git branch --show-current)
if [[ -n "$EXPECTED_BASE" ]]; then
  git merge-base --is-ancestor "$EXPECTED_BASE" HEAD || {
    printf 'Expected upstream base %s is not an ancestor of HEAD.\n' "$EXPECTED_BASE" >&2
    exit 1
  }
fi

run_gate() {
  local name=$1
  shift
  printf '\n===== %s =====\n' "$name"
  set +e
  "$@" 2>&1 | tee "$LOG_DIR/$name.log"
  local rc=${PIPESTATUS[0]}
  set -e
  printf 'EXIT=%s\n' "$rc" | tee -a "$LOG_DIR/$name.log"
  return "$rc"
}

run_gate bun-install "$BUN" install --frozen-lockfile
run_gate typecheck "$BUN" run check
run_gate bundle-build "$BUN" build src/mcp.ts --target=node --outfile="$LOG_DIR/gpt-control-mcp.js"
run_gate bundle-current cmp dist/gpt-control-mcp.js "$LOG_DIR/gpt-control-mcp.js"
run_gate bundle-node-syntax node --check dist/gpt-control-mcp.js
run_gate desktop-bundle-build "$BUN" build src/desktop-driver-cli.ts --target=node --minify-whitespace --outfile="$LOG_DIR/gpt-control-desktop-driver.js"
run_gate desktop-bundle-current cmp dist/gpt-control-desktop-driver.js "$LOG_DIR/gpt-control-desktop-driver.js"
run_gate desktop-bundle-node-syntax node --check dist/gpt-control-desktop-driver.js
run_gate desktop-pool-bundle-build "$BUN" build src/desktop-pool-driver-cli.ts --target=node --minify-whitespace --outfile="$LOG_DIR/gpt-control-desktop-pool-driver.js"
run_gate desktop-pool-bundle-current cmp dist/gpt-control-desktop-pool-driver.js "$LOG_DIR/gpt-control-desktop-pool-driver.js"
run_gate desktop-pool-bundle-node-syntax node --check dist/gpt-control-desktop-pool-driver.js
mkdir -p "$LOG_DIR/mcp-home" "$LOG_DIR/mcp-state"
run_gate bundle-mcp-smoke env   -u OPENAI_API_KEY -u OPENAI_BASE_URL   HOME="$LOG_DIR/mcp-home"   PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"   GPT_CONTROL_NODE="$NODE"   GPT_CONTROL_HOME="$LOG_DIR/mcp-state"   GPT_CONTROL_WORKSPACE_ROOT="$ROOT"   python3 scripts/mcp-stdio-smoke.py ./bin/gpt-control-mcp
run_gate browser-tests env -u OPENAI_API_KEY -u OPENAI_BASE_URL "$BUN" test chrome.test.ts
run_gate storage-tests env -u OPENAI_API_KEY -u OPENAI_BASE_URL "$BUN" test parsing.test.ts
run_gate transport-tests env -u OPENAI_API_KEY -u OPENAI_BASE_URL "$BUN" test transport.test.ts
run_gate subagent-tests env -u OPENAI_API_KEY -u OPENAI_BASE_URL "$BUN" test subagent.test.ts
run_gate contract-tests env -u OPENAI_API_KEY -u OPENAI_BASE_URL "$BUN" test index.test.ts
run_gate desktop-driver-tests env -u OPENAI_API_KEY -u OPENAI_BASE_URL "$BUN" test desktop-driver.test.ts
run_gate full-tests env -u OPENAI_API_KEY -u OPENAI_BASE_URL "$BUN" test
run_gate production-audit "$BUN" audit --production
run_gate shell-syntax bash -n bin/gpt-control-mcp bin/gpt-control-desktop-driver bin/gpt-control-desktop-pool-driver scripts/verify-security.sh
run_gate javascript-syntax sh -c 'node --check scripts/desktop-cdp-live-smoke.mjs && node --check scripts/chatgpt-desktop-doctor.mjs && node --check scripts/chatgpt-desktop-launch.mjs && node --check scripts/chatgpt-desktop-acceptance.mjs'
run_gate python-syntax python3 -c 'from pathlib import Path; [compile(path.read_text(), str(path), "exec") for path in (Path("scripts/mcp-stdio-smoke.py"), Path("scripts/package-smoke.py"))]'
run_gate package-smoke python3 scripts/package-smoke.py
run_gate json-parse python3 -m json.tool package.json
run_gate plugin-json python3 -m json.tool .codex-plugin/plugin.json
run_gate mcp-json python3 -m json.tool .mcp.json
# Bun preserves whitespace inside dependency template literals because removing
# it can change runtime strings. Check every authored file and verify the
# generated bundle separately through byte-for-byte reproducibility above.
run_gate diff-check git diff --check HEAD -- . ':(exclude)dist/gpt-control-desktop-driver.js' ':(exclude)dist/gpt-control-desktop-pool-driver.js'

secret_found=0
: > "$LOG_DIR/secret-scan.log"
while IFS= read -r -d '' verify_file; do
	[[ -f "$verify_file" ]] || continue
  if grep -InE \
    '(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' \
    "$verify_file" >> "$LOG_DIR/secret-scan.log"; then
    secret_found=1
  fi
done < <(git ls-files -co --exclude-standard -z -- ':!bun.lock' ':!scripts/verify-security.sh')
if (( secret_found )); then
  printf '%s\n' 'Potential secret material detected in the Git commit boundary:' >&2
  cat "$LOG_DIR/secret-scan.log" >&2
  exit 1
fi
printf 'EXIT=0\n' >> "$LOG_DIR/secret-scan.log"

{
  printf 'verified_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'branch=%s\n' "$branch"
  printf 'base=%s\n' "$EXPECTED_BASE"
  printf 'head=%s\n' "$(git rev-parse HEAD)"
  printf 'bun=%s\n' "$("$BUN" --version)"
  printf 'node=%s\n' "$(node --version)"
  printf 'codex=%s\n' "$(codex --version 2>/dev/null | tail -1 || true)"
  for gate in bun-install typecheck bundle-build bundle-current bundle-node-syntax desktop-bundle-build desktop-bundle-current desktop-bundle-node-syntax desktop-pool-bundle-build desktop-pool-bundle-current desktop-pool-bundle-node-syntax bundle-mcp-smoke browser-tests storage-tests transport-tests subagent-tests contract-tests desktop-driver-tests full-tests production-audit shell-syntax javascript-syntax python-syntax package-smoke json-parse plugin-json mcp-json diff-check secret-scan; do
    printf '%s_exit=%s\n' "$gate" "$(sed -n 's/^EXIT=//p' "$LOG_DIR/$gate.log" | tail -1)"
  done
} > "$LOG_DIR/summary.txt"
chmod 600 "$LOG_DIR"/*.log "$LOG_DIR/summary.txt"
printf '\nAll GPT-Control verification gates passed.\n'
printf 'logs=%s\n' "$LOG_DIR"
cat "$LOG_DIR/summary.txt"
