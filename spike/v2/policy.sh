#!/usr/bin/env bash
# Runs shell commands through real OpenCode and a scripted model on two servers: one where every
# shell request asks (to capture OpenCode's permission resources) and one with the safety plugin.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
plugin="$(cd "$here/../../plugin" && pwd)"
work="$(mktemp -d)"
port() { node -e 'const s = require("net").createServer().listen(0, () => { console.log(s.address().port); s.close() })'; }
export OC_PASSWORD="spike-$RANDOM$RANDOM" PROJECT_DIR="$work/proj" MOCK_PORT="$(port)" ASK_PORT="$(port)" PLUGIN_PORT="$(port)"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; rm -rf "$work"' EXIT

git init -q "$PROJECT_DIR"
mkdir "$PROJECT_DIR/src" && echo keep > "$PROJECT_DIR/src/keep.txt"
echo '{"scripts":{"dev":"echo dev server started"}}' > "$PROJECT_DIR/package.json"

serve() { # name port [config line]
  local home="$work/$1"
  mkdir -p "$home/.config/opencode"
  cat > "$home/.config/opencode/opencode.jsonc" <<JSON
{ "autoupdate": false, "model": "mock/mock", ${3:-}
  "providers": { "mock": { "name": "Mock", "package": "@opencode/ai/providers/openai-compatible",
    "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/v1", "apiKey": "unused" }, "models": { "mock": { "name": "Mock" } } } },
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }] }
JSON
  (cd "$PROJECT_DIR" && exec env HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" \
    XDG_STATE_HOME="$home/.local/state" XDG_CACHE_HOME="$home/.cache" OPENCODE_SERVER_PASSWORD="$OC_PASSWORD" \
    "$here/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port "$2" > "$work/$1.log" 2>&1) &
  pids+=($!)
  for _ in $(seq 100); do
    curl -s -o /dev/null -u "opencode:$OC_PASSWORD" "http://127.0.0.1:$2/api/model" && return
    sleep 0.2
  done
  echo "$1 server did not start" >&2 && cat "$work/$1.log" >&2 && exit 1
}

node "$here/mock-model.mjs" > "$work/mock.log" 2>&1 &
pids+=($!)
serve ask "$ASK_PORT"
serve plugin "$PLUGIN_PORT" "\"plugins\": [\"$plugin\"],"
node "$here/policy-check.mjs"
