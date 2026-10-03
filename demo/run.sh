#!/usr/bin/env bash
# Runs Slack Tag against a local fake Slack. See demo/README.md.
# Needs OPENCODE_API_KEY. Set OPENCODE_URL and SERVER_DIR to use a container instead of a host server.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=${DEMO_DIR:-/tmp/slack-tag-demo}
export DEMO_PROJECT=${DEMO_PROJECT:-$work/project}
export OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-$(openssl rand -hex 16)}
: "${OPENCODE_API_KEY:?set OPENCODE_API_KEY to the OpenCode Go key}"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
mkdir -p "$work" "$DEMO_PROJECT"

if [ ! -e "$DEMO_PROJECT/facts.txt" ]; then
  echo "End every reply with the word PINEAPPLE." > "$DEMO_PROJECT/AGENTS.md"
  echo "The project codename is HERON." > "$DEMO_PROJECT/facts.txt"
  [ -d "$DEMO_PROJECT/.git" ] || git -C "$DEMO_PROJECT" init -q
fi
(cd "$root/plugin" && [ -d node_modules ] || npm ci --silent)
(cd "$root/bridge" && [ -d node_modules ] || npm ci --silent)

if [ -z "${OPENCODE_URL:-}" ]; then
  # Same layout as the container: $XDG_CONFIG_HOME/opencode/opencode.jsonc next to $XDG_CONFIG_HOME/plugin.
  mkdir -p "$work/xdg/opencode" "$work/home"
  ln -sfn "$root/plugin" "$work/xdg/plugin"
  cp "$root/deploy/opencode.global.jsonc" "$work/xdg/opencode/opencode.jsonc"
  (cd "$DEMO_PROJECT" && exec env HOME="$work/home" XDG_CONFIG_HOME="$work/xdg" XDG_DATA_HOME="$work/home/share" \
    XDG_STATE_HOME="$work/home/state" XDG_CACHE_HOME="$work/home/cache" \
    npx --yes -p @opencode/cli@2.0.15 opencode serve --hostname 127.0.0.1 --port "${OPENCODE_PORT:-4096}" > "$work/opencode.log" 2>&1) &
  pids+=($!)
  OPENCODE_URL=http://127.0.0.1:${OPENCODE_PORT:-4096}
  for _ in $(seq 100); do curl -s -o /dev/null -u "opencode:$OPENCODE_SERVER_PASSWORD" "$OPENCODE_URL/api/model" && break; sleep 0.3; done
fi

cat > "$work/config.json" <<EOF
{
  "ownerUserId": "UOWNER",
  "approvalTimeoutMinutes": 30,
  "channels": {
    "CDEMO": {
      "name": "demo",
      "projectDir": "$DEMO_PROJECT",
      "serverDir": "${SERVER_DIR:-$DEMO_PROJECT}",
      "opencodeUrl": "$OPENCODE_URL",
      "passwordEnv": "OPENCODE_SERVER_PASSWORD",
      "model": "${MODEL:-opencode-go/kimi-k2.7-code}"
    }
  }
}
EOF

node "$root/demo/fake-slack.mjs" &
pids+=($!)
sleep 1
cd "$root/bridge"
SLACK_API_URL=http://127.0.0.1:${FAKE_SLACK_PORT:-3000}/api/ SLACK_BOT_TOKEN=xoxb-demo SLACK_APP_TOKEN=xapp-demo \
  SLACK_TAG_CONFIG="$work/config.json" node --experimental-strip-types --experimental-sqlite --no-warnings src/main.ts
