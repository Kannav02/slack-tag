#!/usr/bin/env bash
# Runs the v2 behaviour checks against a fake model in a throwaway home and project.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
export OC_PASSWORD="spike-$RANDOM$RANDOM"
export PROJECT_DIR="$work/proj"
pids=()
cleanup() {
  kill "${pids[@]}" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/home/.config/opencode" "$PROJECT_DIR"
cp "$here/opencode.global.jsonc" "$work/home/.config/opencode/opencode.jsonc"
git -C "$PROJECT_DIR" init -q
echo spike > "$PROJECT_DIR/README.md"
git -C "$PROJECT_DIR" add . && git -C "$PROJECT_DIR" -c user.email=spike@local -c user.name=spike commit -qm init

node "$here/mock-model.mjs" > "$work/mock.log" 2>&1 &
pids+=($!)

start_server() {
  (cd "$PROJECT_DIR" && env HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" \
    XDG_DATA_HOME="$work/home/.local/share" XDG_STATE_HOME="$work/home/.local/state" \
    XDG_CACHE_HOME="$work/home/.cache" OPENCODE_SERVER_PASSWORD="$OC_PASSWORD" \
    "$here/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port 4096 > "$work/server.log" 2>&1) &
  server_pid=$!
  pids+=($server_pid)
  for _ in $(seq 50); do
    curl -s -o /dev/null -u "opencode:$OC_PASSWORD" http://127.0.0.1:4096/api/model && return
    sleep 0.2
  done
  echo "server did not start" >&2
  cat "$work/server.log" >&2
  exit 1
}

start_server
node "$here/spike.mjs"

pkill -P "$server_pid" 2>/dev/null || true
kill "$server_pid" 2>/dev/null || true
sleep 1
start_server
node "$here/restart-check.mjs"
