#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("Select Node 24 before setup")'
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix bridge --ignore-scripts --no-audit --no-fund
npm ci --prefix plugin --ignore-scripts --no-audit --no-fund
npm run check:dependencies
