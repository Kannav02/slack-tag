#!/bin/sh
# Starts OpenCode as node (uid 1000), keeping only the capabilities agent-shell needs to switch to the agent user.
set -eu
umask 002
# Per-thread worktrees (worktree-enabled projects mount a writable volume here). Group 1000 write with setgid,
# so agent shells can edit worktree files node creates; skipped entirely when no volume is mounted.
if [ -d /worktrees ]; then
  chown node:node /worktrees
  chmod 2775 /worktrees
fi
# Harden every git the server runs (OpenCode's VCS and plugin tools, uid 1000). A thread's worktree has a
# writable .git file and commondir, so the agent could redirect them at a config that sets core.fsmonitor or
# core.hooksPath to a command and have the server execute it. GIT_CONFIG_* has command-level precedence, above
# any repo or redirected config, so force those off. Appended after any Git-proxy URL rewrites, never replacing
# them; inherited by agent shells too (harmless). OpenCode's own VCS also passes -c core.fsmonitor=false.
i=${GIT_CONFIG_COUNT:-0}
eval "export GIT_CONFIG_KEY_$i=core.fsmonitor GIT_CONFIG_VALUE_$i=false"
i=$((i + 1))
eval "export GIT_CONFIG_KEY_$i=core.hooksPath GIT_CONFIG_VALUE_$i=/dev/null"
export GIT_CONFIG_COUNT=$((i + 1))
exec setpriv --reuid=node --regid=node --init-groups \
  --inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid -- \
  sh -c 'chmod 700 /data && exec opencode serve --hostname 0.0.0.0 --port 4096'
