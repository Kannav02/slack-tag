#!/usr/bin/env bash
# Records the real OpenCode event stream for a scripted multi-step run (text, reasoning, tools, an approval).
# Usage: ./record.sh <output.jsonl>
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$(realpath -m "${1:?usage: record.sh <output.jsonl>}")"
work="$(mktemp -d)"
export OC_PASSWORD="spike-$RANDOM$RANDOM"
export PROJECT_DIR="$work/proj"
export MOCK_LOG="$work/mock.jsonl"
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

node "$here/progress-model.mjs" > "$work/model.log" 2>&1 &
pids+=($!)

(cd "$PROJECT_DIR" && exec env HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" \
  XDG_DATA_HOME="$work/home/.local/share" XDG_STATE_HOME="$work/home/.local/state" \
  XDG_CACHE_HOME="$work/home/.cache" OPENCODE_SERVER_PASSWORD="$OC_PASSWORD" \
  "$here/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port 4096 > "$work/server.log" 2>&1) &
pids+=($!)
for _ in $(seq 50); do
  curl -s -o /dev/null -u "opencode:$OC_PASSWORD" http://127.0.0.1:4096/api/model && break
  sleep 0.2
done

node "$here/record-progress.mjs" "$out" || { cat "$work/server.log" "$MOCK_LOG" >&2; exit 1; }
echo "--- tools offered to the model"
head -1 "$MOCK_LOG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const t of JSON.parse(s).tools??[])console.log(t.name, t.params.join(","))})'
