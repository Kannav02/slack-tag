# Proposed V1 module interfaces

Status: proposal for agreement, not implemented interfaces.

One bridge process, not a set of microservices. No public HTTP interface is proposed. Bolt connects outbound to Slack through Socket Mode; each project exposes an authenticated OpenCode endpoint only to the bridge. SQLite has no network listener.

| Module | Small interface | Responsibilities hidden inside |
| --- | --- | --- |
| Slack transport | `start`, `stop`; deliver message/approval inputs; publish thread responses | Bolt envelopes and acknowledgements, Slack formatting and updates, attachment download using Slack credentials. |
| Bridge | `handleMessage`, `handleApproval` | Owner checks, channel routing, persistent thread/session associations, duplicate delivery handling, input validation, and coordination of runtime and agent. This is the primary behavior-test entry point. |
| Agent adapter | `openConversation`, `sendInput`, `observe`, `replyApproval`, `inspectConversation` | OpenCode contract translation, normalized events, reconnect reconciliation, and pending-work information. See opencode-interface.md. |
| Project runtime | `ensureReady`, `stopIfIdle` | Rootless Podman lifecycle, private authenticated endpoint, persistent mounts, readiness checks, and coordination with incoming work. Never stop when activity is uncertain. |

These are proposed operation names, not frozen TypeScript signatures. In particular, lifecycle coordination must prevent shutdown between readiness and prompt admission; do not implement ensureReady as an unprotected check followed by independent work.

SQLite persistence is an internal bridge implementation detail using `bun:sqlite`, not a separate exposed module interface for every database operation. Configuration and project-scoped attachment storage likewise do not need independent services.

Start with the message-to-reply flow and add the already agreed V1 behaviors incrementally. Do not create placeholder classes or implement an interface for every row merely to match this document.

## Dependency baseline

- Bun 1.4.0, TypeScript with strict checking.
- Slack Bolt 5.1.0.
- OpenCode network client 2.0.3, matching the current server verification baseline.
- SQLite and integration-test runner supplied by Bun; no ORM, Redis, HTTP framework, or Podman SDK dependency added.
- Podman remains a system prerequisite on the VPS, not an npm dependency.

The earlier local Socket Mode test passed on Bun 1.4.0 and Bolt 5.1.0 using a simulated Slack endpoint. Real Slack authentication/downloads, Linux behavior, and OpenCode execution/persistence/approval integration remain unverified.
