#!/bin/sh
# Create the paths compose.yaml mounts read-only, and an inbox that the bridge
# writes and the container user (uid 1000) reads. Run before `docker compose up`.
set -eu
project=${1:?project directory}
mkdir -p "$project/.opencode" "$project/.slack-tag/inbox"
[ -e "$project/.git/config" ] || git -C "$project" init -q
mkdir -p "$project/.git/hooks"
for file in opencode.json opencode.jsonc; do
  [ -f "$project/$file" ] || echo '{}' > "$project/$file"
done
chgrp 1000 "$project" "$project/.slack-tag" "$project/.slack-tag/inbox" 2>/dev/null || true
chmod 2775 "$project/.slack-tag" "$project/.slack-tag/inbox"
