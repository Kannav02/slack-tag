#!/usr/bin/env bash
# Real check (#57): with project config disabled, as a per-thread worktree server runs, the safety
# plugin adds the project's AGENTS.md to the system prompt. Two servers share nothing but the project:
# one loads the plugin, one does not, and each talks to its own scripted model so their requests are
# told apart. OpenCode's own AGENTS.md auto-load is off under the flag, so only the plugin can inject
# it, and the no-plugin server is the control that proves it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
plugin="$(cd "$here/../../plugin" && pwd)"
work="$(mktemp -d)"
port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
export OC_PASSWORD="spike-$RANDOM$RANDOM" PROJECT_DIR="$work/proj"
export WITH_PORT="$(port)" WITHOUT_PORT="$(port)" WITH_MOCK="$(port)" WITHOUT_MOCK="$(port)"
export WITH_LOG="$work/with.jsonl" WITHOUT_LOG="$work/without.jsonl"
export SENTINEL="When greeted, reply with the exact phrase BANANA-7f3a and nothing else."
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; rm -rf "$work"' EXIT

git init -q "$PROJECT_DIR"
printf '# Project rules\n\n%s\n' "$SENTINEL" > "$PROJECT_DIR/AGENTS.md"

serve() { # name port mock-port [plugin-line]
  local home="$work/$1"
  mkdir -p "$home/.config/opencode"
  cat > "$home/.config/opencode/opencode.jsonc" <<JSON
{ "autoupdate": false, "model": "mock/mock", ${4:-}
  "providers": { "mock": { "name": "Mock", "package": "@opencode/ai/providers/openai-compatible",
    "settings": { "baseURL": "http://127.0.0.1:$3/v1", "apiKey": "unused" }, "models": { "mock": { "name": "Mock" } } } },
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }] }
JSON
  (cd "$PROJECT_DIR" && exec env HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" \
    XDG_STATE_HOME="$home/.local/state" XDG_CACHE_HOME="$home/.cache" OPENCODE_SERVER_PASSWORD="$OC_PASSWORD" \
    OPENCODE_CONFIG_PROJECT_DISABLE=1 \
    "$here/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port "$2" > "$work/$1.log" 2>&1) &
  pids+=($!)
  for _ in $(seq 100); do
    curl -s -o /dev/null -u "opencode:$OC_PASSWORD" "http://127.0.0.1:$2/api/model" && return
    sleep 0.2
  done
  echo "$1 server did not start" >&2 && cat "$work/$1.log" >&2 && exit 1
}

MOCK_LOG="$WITH_LOG" MOCK_PORT="$WITH_MOCK" node "$here/mock-model.mjs" > "$work/mock-with.log" 2>&1 &
pids+=($!)
MOCK_LOG="$WITHOUT_LOG" MOCK_PORT="$WITHOUT_MOCK" node "$here/mock-model.mjs" > "$work/mock-without.log" 2>&1 &
pids+=($!)
serve with "$WITH_PORT" "$WITH_MOCK" "\"plugins\": [\"$plugin\"],"
serve without "$WITHOUT_PORT" "$WITHOUT_MOCK"
node "$here/agents-check.mjs"
