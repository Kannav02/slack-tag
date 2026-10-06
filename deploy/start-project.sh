#!/bin/sh
# Starts one project registered from Slack: prepares its folder, then docker compose with deploy/project.yaml.
# On the VPS it runs as root under slack-tag-project@.service, which the bridge may start (polkit rule);
# in development the bridge runs it directly. The bridge only names the project, and its env file is
# bridge-written, so every value is checked here and nothing else from that file reaches Docker.
set -eu

fail() {
  echo "$*" >&2
  exit 1
}

name=${1:-}
state=${SLACK_TAG_STATE_DIR:-/var/lib/slack-tag}
root=${SLACK_TAG_PROJECTS_ROOT:?set SLACK_TAG_PROJECTS_ROOT}
deploy=$(cd "$(dirname "$0")" && pwd)

printf '%s' "$name" | grep -Eqx '[a-z0-9][a-z0-9_-]{0,39}' || fail "invalid project name"
env_file="$state/projects/$name.env"
[ -f "$env_file" ] && [ ! -L "$env_file" ] || fail "no env file for $name"
value() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }
project=$(value SLACK_TAG_PROJECT)
port=$(value SLACK_TAG_PORT)
password=$(value SLACK_TAG_PASSWORD)
net=$(value SLACK_TAG_NET)
repo=$(value SLACK_TAG_REPO)
real_root=$(realpath "$root")

# Run a command with the container user's rights, not root's: the agent may have planted symlinks in the project.
as_owner() {
  if [ "$(id -u)" = 0 ]; then
    env -i PATH="$PATH" HOME=/nonexistent setpriv --reuid=1000 --regid=1000 --clear-groups "$@"
  else
    env -i PATH="$PATH" HOME=/nonexistent "$@"
  fi
}

# A project registered from a GitHub URL is cloned on its first start with the operator's key, which the
# bridge never sees. The URL comes from the bridge-written env file, so it is checked again here; a clone
# goes to a hidden folder first, so an interrupted one is never mistaken for the project.
if [ -n "$repo" ] && [ -n "$project" ] && [ ! -e "$project" ] && [ ! -L "$project" ]; then
  printf '%s' "$repo" |
    grep -Eqx 'git@github\.com:[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.git' ||
    fail "invalid repository URL"
  [ "$(dirname "$project")" = "$real_root" ] &&
    printf '%s' "$(basename "$project")" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._-]*' ||
    fail "project folder is not directly inside $root"
  for file in "${SLACK_TAG_GIT_KEY:-}" "${SLACK_TAG_GIT_KNOWN_HOSTS:-}"; do
    printf '%s' "$file" | grep -Eqx '/[A-Za-z0-9._/-]+' && [ -f "$file" ] ||
      fail "cloning is not configured: set SLACK_TAG_GIT_KEY and SLACK_TAG_GIT_KNOWN_HOSTS"
  done
  clone="$real_root/.clone-$name"
  as_owner rm -rf "$clone"
  as_owner env GIT_TERMINAL_PROMPT=0 \
    GIT_SSH_COMMAND="ssh -F /dev/null -i $SLACK_TAG_GIT_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$SLACK_TAG_GIT_KNOWN_HOSTS" \
    git clone -q -- "$repo" "$clone" || fail "cloning $repo failed"
  as_owner mv "$clone" "$project"
fi

# The project must be a real folder directly inside the projects root: not a symlink, not deeper, not the root.
[ -n "$project" ] && [ -d "$project" ] && [ ! -L "$project" ] || fail "project folder is missing"
[ "$(realpath "$project")" = "$project" ] && [ "$(dirname "$project")" = "$real_root" ] ||
  fail "project folder is not directly inside $root"
printf '%s' "$port" | grep -Eqx '[0-9]{4,5}' && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || fail "invalid port"
printf '%s' "$net" | grep -Eqx '[0-9]{1,3}' && [ "$net" -ge 1 ] && [ "$net" -le 254 ] || fail "invalid network number"
printf '%s' "$password" | grep -Eqx '[0-9a-f]{48}' || fail "invalid server password"
inbox="$state/inbox/$name"
[ -d "$inbox" ] && [ ! -L "$inbox" ] || fail "upload inbox $inbox is missing"

as_owner sh "$deploy/prepare-project.sh" "$project"

# Docker sees only the checked values and the operator's own settings (unit EnvironmentFile or the developer's shell).
set -- PATH="$PATH" HOME="${HOME:-/root}" SLACK_TAG_PROJECT="$project" SLACK_TAG_PORT="$port" \
  SLACK_TAG_PASSWORD="$password" SLACK_TAG_NET="$net" SLACK_TAG_INBOX="$inbox"
for var in SLACK_TAG_RUNTIME SLACK_TAG_IMAGE PROXY_ENV_FILE DOCKER_HOST DOCKER_CONFIG DOCKER_CONTEXT; do
  eval "val=\${$var-}"
  [ -n "$val" ] && set -- "$@" "$var=$val"
done
exec env -i "$@" docker compose -p "slack-tag-$name" -f "$deploy/project.yaml" --env-file /dev/null up -d
