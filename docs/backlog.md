# Feature backlog and decisions

Planning snapshot: 2026-09-29. [Notion project](https://www.notion.so/3e91697f7f2281d988abf6e8d9ed6b78) holds the initial three items. Multiplayer decisions came later. This file is not an automatic Notion sync.

| Item | Priority | Category | State |
| --- | --- | --- | --- |
| Harden security and document architecture | High | security | Planned |
| Support OpenCode commands in Slack | Medium | feature | Planned |
| Add projects through Slack | Medium | feature | Planned |
| Multiplayer and concurrent-edit isolation | To decide | feature | Research/design |

## Current behavior

The bridge accepts only the configured owner. A mention creates a session; owner replies in a mapped thread continue it without a mention. Prompts already use OpenCode `delivery: "queue"`. Threads share the channel's checkout. Command dispatch, automated onboarding, worktrees and automatic idle server shutdown are not implemented.

Policy version 2 allows actions that formerly requested approval. Deployment configuration blocks `git push`; the plugin blocks `sudo` and protected edits. Legacy approval handlers remain. These controls are not a comprehensive security guarantee.

## Work-item scope

- **Security:** document actual trust boundaries and test permissions, credential handling, container restrictions and recovery. Distinguish architecture documentation from verified enforcement.
- **Commands:** determine the supported command API on the pinned OpenCode release, map it to Slack, and verify effects in the correct project/session. Command syntax is not selected.
- **Onboarding:** replace manual folder/container/channel mapping with a guided Slack flow. Preserve existing data, validate readiness and avoid duplicate setup on retry.

## Multiplayer: agreed direction

- Channel participants should be able to use the agent. Require `@OpenCode` on every agent-directed message, including thread replies; ignore ordinary human conversation.
- One shared session per thread, with sender attribution. Use queue delivery; defer steering and edited/deleted-message synchronization.
- Same-session queueing does not protect shared files across sessions. Concurrent edits from different threads are the main unresolved design issue.

## Worktrees: proposal, not a final design

Investigate an isolated worktree per active thread/task, a cap on executing tasks, shared Git/package caches, and serialized integration with tests. Retire checkouts only after changes and necessary artifacts are preserved; keep conversation/branch identity for follow-ups. Worktrees primarily cost disk; running tooling costs RAM. Measure costs before choosing limits.

The SDK accepts a session location directory, but multiple worktree-backed sessions on one server still need runtime verification. Protected Git mounts assume a normal checkout, so linked-worktree mounts must be redesigned and tested. Worktrees do not automatically isolate external databases, ports or outputs.

Before implementing multiplayer, verify two queued senders, concurrent first messages, Slack retry deduplication, sender/access policy, and two sessions editing the same file in isolated worktrees. Integration must surface merge conflicts and test the combined result.

Sources: [OpenCode 2.0.15 sessions](https://github.com/anomalyco/opencode/blob/v2.0.15/specs/v2/session.md), [Git worktrees](https://git-scm.com/docs/git-worktree), [Cursor worktrees](https://cursor.com/docs/configuration/worktrees), [Claude Code worktrees](https://code.claude.com/docs/en/worktrees), [uv cache](https://docs.astral.sh/uv/concepts/cache/).
