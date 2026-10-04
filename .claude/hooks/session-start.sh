#!/bin/bash
# Claude Code cloud sessions: install Node 24 and all three npm packages so
# `npm run check` works. Local sessions keep using scripts/setup-cloud.sh.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
node_version="$(cat .node-version)"

# The cloud image ships Node 22; AGENTS.md requires Node 24 (pinned in .node-version).
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
nvm install "$node_version" >/dev/null
nvm use "$node_version" >/dev/null
node_bin="$(dirname "$(nvm which "$node_version")")"
echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"

# npm install (not ci) reuses node_modules cached in the container snapshot.
npm install --ignore-scripts --no-audit --no-fund
npm install --prefix bridge --ignore-scripts --no-audit --no-fund
npm install --prefix plugin --ignore-scripts --no-audit --no-fund
npm run check:dependencies
