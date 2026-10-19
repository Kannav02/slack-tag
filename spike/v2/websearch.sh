#!/usr/bin/env bash
# Real check: an agent's web search on a server with the safety plugin and the deployed global
# config runs without a Slack approval or OpenCode's provider form.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
export OC_PASSWORD="spike-$RANDOM$RANDOM" PROJECT_DIR="$work/proj" MOCK_PORT="$(port)" PORT="$(port)"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; rm -rf "$work"' EXIT

git init -q "$PROJECT_DIR"
home="$work/home"
mkdir -p "$home/.config/opencode"
# The deployed config with the mock model in place of the key proxy.
node -e '
const [file, plugin, port] = process.argv.slice(1)
const config = JSON.parse(require("fs").readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""))
config.plugins = [plugin]
config.model = "mock/mock"
config.providers = { mock: { name: "Mock", package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "unused" }, models: { mock: { name: "Mock" } } } }
console.log(JSON.stringify(config))
' "$root/deploy/opencode.global.jsonc" "$root/plugin" "$MOCK_PORT" > "$home/.config/opencode/opencode.jsonc"

node "$here/mock-model.mjs" > "$work/mock.log" 2>&1 &
pids+=($!)
(cd "$PROJECT_DIR" && exec env HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" \
  XDG_STATE_HOME="$home/.local/state" XDG_CACHE_HOME="$home/.cache" OPENCODE_SERVER_PASSWORD="$OC_PASSWORD" \
  "$here/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port "$PORT" > "$work/server.log" 2>&1) &
pids+=($!)
for _ in $(seq 100); do
  curl -s -o /dev/null -u "opencode:$OC_PASSWORD" "http://127.0.0.1:$PORT/api/model" && break
  sleep 0.2
done
OC_URL="http://127.0.0.1:$PORT" node "$here/websearch-check.mjs"
