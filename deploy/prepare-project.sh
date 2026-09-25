#!/bin/sh
# Create the paths that Compose mounts read-only, and make the inbox readable
# by the container user (uid 1000). Run this on the host before `docker compose up`.
set -eu
project=${1:?project directory}
mkdir -p "$project/.opencode" "$project/.slack-tag/inbox" "$project/.git/hooks"
if [ ! -e "$project/.git/config" ]; then
  git -C "$project" init -q
fi
if [ ! -f "$project/opencode.json" ]; then
  printf '%s\n' '{}' > "$project/opencode.json"
fi
if [ ! -f "$project/opencode.jsonc" ]; then
  printf '%s\n' '{}' > "$project/opencode.jsonc"
fi
# Container user is uid 1000. The bridge, running as that user or as root,
# can write the inbox; the container can read it. Group-writable so a root
# bridge in the same group can share the directory without chown on every file.
chgrp 1000 "$project" "$project/.slack-tag" "$project/.slack-tag/inbox" 2>/dev/null || true
chmod 2775 "$project/.slack-tag" "$project/.slack-tag/inbox" 2>/dev/null || chmod 777 "$project/.slack-tag/inbox"
touch "$project/.git/hooks/.keep"
