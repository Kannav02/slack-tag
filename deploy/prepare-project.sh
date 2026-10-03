#!/bin/sh
# Create the paths compose.yaml mounts read-only. Run before `docker compose up`.
set -eu
project=${1:?project directory}
mkdir -p "$project/.opencode"
[ -e "$project/.git/config" ] || git -C "$project" init -q
mkdir -p "$project/.git/hooks"
for file in opencode.json opencode.jsonc; do
  [ -f "$project/$file" ] || echo '{}' > "$project/$file"
done
chgrp 1000 "$project" 2>/dev/null || true
