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
# Agent shells run as a separate user in group 1000; they need group write on the project and its Git data.
chgrp -R 1000 "$project" 2>/dev/null || true
chmod -R g+rwX "$project"
find "$project" -type d -exec chmod g+s {} +
