#!/bin/sh
# Trusted host entrypoint: read the existing gh login, then expose it only to Compose/the sidecar.
set +x
set -eu
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
credential_user=${GIT_CREDENTIAL_USER:-$(id -un)}
fail() { echo "GitHub credential unavailable for $credential_user (Kannav02)" >&2; exit 1; }
if [ "$(id -un)" = "$credential_user" ]; then
  GITHUB_TOKEN=$(gh auth token --hostname github.com --user Kannav02 2>/dev/null) || fail
elif [ "$(id -u)" = 0 ]; then
  GITHUB_TOKEN=$(runuser -u "$credential_user" -- gh auth token --hostname github.com --user Kannav02 2>/dev/null) || fail
else
  fail
fi
[ -n "$GITHUB_TOKEN" ] || fail
export GITHUB_TOKEN
exec "$@"
