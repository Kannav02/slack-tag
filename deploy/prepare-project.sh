#!/bin/sh
# Create the paths compose.yaml mounts read-only. Run before `docker compose up`.
# deploy/start-project.sh runs it as uid 1000 (the container user) for projects registered from Slack.
set -eu
project=${1:?project directory}
# An agent can leave symlinks in the project; never write through one.
for path in .opencode .git .git/config .git/hooks opencode.json opencode.jsonc; do
  [ ! -L "$project/$path" ] || { echo "$path in $project is a symlink" >&2; exit 1; }
done
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
# Other users, the bridge's included, may see the folder's name but not open it.
chmod o-rwx "$project"
