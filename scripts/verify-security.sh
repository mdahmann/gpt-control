#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOG_DIR="${GPT_CONTROL_VERIFY_LOG_DIR:-/tmp/gpt-control-security-verification}"
EXPECTED_BRANCH="pro/security-hardening-0.2.0"
EXPECTED_BASE="1f7dff5c88538592546cafbaedd3cf0572b6679b"

if [[ -n "${GPT_CONTROL_BUN:-}" ]]; then
  BUN_CMD=("$GPT_CONTROL_BUN")
elif command -v bun >/dev/null 2>&1; then
  BUN_CMD=("$(command -v bun)")
elif command -v npx >/dev/null 2>&1; then
  BUN_CMD=(npx --yes bun@1.4.0)
else
  printf '%s\n' 'Bun is unavailable and npx cannot provide the pinned verification runtime.' >&2
  exit 127
fi

mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
cd "$ROOT"

branch="$(git branch --show-current)"
[[ "$branch" == "$EXPECTED_BRANCH" ]] || { printf 'Refusing verification on branch %s; expected %s.\n' "$branch" "$EXPECTED_BRANCH" >&2; exit 1; }
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD || { printf 'Expected base %s is not an ancestor of HEAD.\n' "$EXPECTED_BASE" >&2; exit 1; }

run_gate() {
  local name="$1"
  shift
  printf '\n===== %s =====\n' "$name"
  "$@" 2>&1 | tee "$LOG_DIR/${name}.log"
  local rc="${PIPESTATUS[0]}"
  printf 'EXIT=%s\n' "$rc" | tee -a "$LOG_DIR/${name}.log"
  return "$rc"
}

run_gate bun-install "${BUN_CMD[@]}" install --frozen-lockfile
run_gate bun-check "${BUN_CMD[@]}" run check
run_gate bun-test-security env -u OPENAI_API_KEY -u OPENAI_BASE_URL "${BUN_CMD[@]}" run test:security
run_gate bun-test-chrome env -u OPENAI_API_KEY -u OPENAI_BASE_URL "${BUN_CMD[@]}" run test:chrome
run_gate bun-test-subagents env -u OPENAI_API_KEY -u OPENAI_BASE_URL "${BUN_CMD[@]}" run test:subagents
run_gate bun-test env -u OPENAI_API_KEY -u OPENAI_BASE_URL "${BUN_CMD[@]}" test
run_gate git-diff-check git diff --check

{
  printf 'verified_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'branch=%s\n' "$branch"
  printf 'base=%s\n' "$EXPECTED_BASE"
  printf 'head=%s\n' "$(git rev-parse HEAD)"
  printf 'bun=%s\n' "$("${BUN_CMD[@]}" --version)"
  for gate in bun-install bun-check bun-test-security bun-test-chrome bun-test-subagents bun-test git-diff-check; do
    printf '%s_exit=%s\n' "$gate" "$(sed -n 's/^EXIT=//p' "$LOG_DIR/${gate}.log" | tail -1)"
  done
} > "$LOG_DIR/summary.txt"
chmod 600 "$LOG_DIR"/*.log "$LOG_DIR/summary.txt"
printf '\nAll GPT-Control verification gates passed.\n'
cat "$LOG_DIR/summary.txt"
