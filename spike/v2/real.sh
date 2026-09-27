#!/usr/bin/env bash
# One real-model round trip: prompt, shell approval, reply.
# Usage: MODEL=opencode-go/kimi-k2.7-code OPENCODE_API_KEY=... ./real.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
export OC_PASSWORD="spike-$RANDOM$RANDOM"
export PROJECT_DIR="$work/proj"
export MODEL="${MODEL:-opencode/big-pickle}"
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  pkill -P "$server_pid" 2>/dev/null || true
  [ -n "${KEEP_LOGS:-}" ] && cp "$work/server.log" /tmp/real-server.log
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/home/.config/opencode" "$PROJECT_DIR"
cp "$here/opencode.real.jsonc" "$work/home/.config/opencode/opencode.jsonc"
git -C "$PROJECT_DIR" init -q

(cd "$PROJECT_DIR" && exec env HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" \
  XDG_DATA_HOME="$work/home/.local/share" XDG_STATE_HOME="$work/home/.local/state" \
  XDG_CACHE_HOME="$work/home/.cache" OPENCODE_SERVER_PASSWORD="$OC_PASSWORD" \
  "$here/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port 4097 > "$work/server.log" 2>&1) &
server_pid=$!
export OC_URL=http://127.0.0.1:4097
for _ in $(seq 50); do
  curl -s -o /dev/null -u "opencode:$OC_PASSWORD" "$OC_URL/api/model" && break
  sleep 0.2
done

node "$here/real-check.mjs"
