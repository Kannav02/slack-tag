#!/bin/sh
# Runs agent shell commands as the agent user (uid 1001, group node) with no capabilities,
# so they cannot read the server's environment, memory or /data.
exec setpriv --reuid=agent --regid=node --init-groups --inh-caps=-all --ambient-caps=-all -- \
  env HOME=/tmp/agent XDG_DATA_HOME=/tmp/agent/share XDG_STATE_HOME=/tmp/agent/state XDG_CACHE_HOME=/tmp/agent/cache \
  sh -c 'umask 002; mkdir -p "$HOME"; exec /bin/bash "$@"' bash "$@"
