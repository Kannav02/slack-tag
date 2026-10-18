#!/usr/bin/env bash
# Real check of slack_attach: OpenCode 2.0.15 with the safety plugin loaded and the scripted model.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
# OUTSIDE lies outside the session folder, /project and /tmp.
export OC_PASSWORD="spike-$RANDOM$RANDOM" PROJECT_DIR="$work/proj" OUTSIDE="$(mktemp -p /var/tmp --suffix=.txt)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$work" "$OUTSIDE"' EXIT
mkdir -p "$work/home/.config/opencode" "$PROJECT_DIR"
sed "s|\"autoupdate\": false,|&\n  \"plugins\": [\"$here/../../plugin\"],|" "$here/opencode.global.jsonc" \
  >"$work/home/.config/opencode/opencode.jsonc"
node "$here/mock-model.mjs" >"$work/mock.log" 2>&1 &
(cd "$PROJECT_DIR" && exec env HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" \
  XDG_DATA_HOME="$work/home/.local/share" XDG_STATE_HOME="$work/home/.local/state" \
  XDG_CACHE_HOME="$work/home/.cache" OPENCODE_SERVER_PASSWORD="$OC_PASSWORD" \
  "$here/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port 4096 >"$work/server.log" 2>&1) &
for _ in $(seq 50); do curl -s -o /dev/null -u "opencode:$OC_PASSWORD" http://127.0.0.1:4096/api/model && break; sleep 0.2; done
node "$here/attach-check.mjs"
