#!/bin/sh
# Starts OpenCode as node (uid 1000), keeping only the capabilities agent-shell needs to switch to the agent user.
set -eu
umask 002
exec setpriv --reuid=node --regid=node --init-groups \
  --inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid -- \
  sh -c 'chmod 700 /data && exec opencode serve --hostname 0.0.0.0 --port 4096'
