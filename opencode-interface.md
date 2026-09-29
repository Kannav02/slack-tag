# OpenCode interface reference

Historical research: version/runtime details and proposed interfaces below are superseded by the deployed Node/OpenCode 2.0.15 implementation. Read `README.md`, `docs/project-mapping.md`, and `docs/findings.md` for current context.

Baseline: OpenCode server **2.0.3** and **`@opencode/client@2.0.3`**.
Bridge runtime: **TypeScript on Bun**, not Node.js.
Verified: 2026-09-20, through published package declarations and official documentation.
Status: contract research, not a runtime-tested integration.

## Package and ownership

Use `@opencode/client` to connect to the OpenCode server inside each isolated project environment. Do not embed the agent in the Slack bridge with `@opencode/sdk`, and do not use the legacy `@opencode-ai/sdk`.

The bridge owns Slack identity checks, routing, mappings, attachments, and approval presentation. The OpenCode adapter owns protocol translation, event normalization, and recovery from a disconnected event stream. The project runtime owns sandbox startup, readiness, shutdown, and persistent mounts.

Keep this adapter seam small as required by SPEC.md. Do not reproduce OpenCode's entire interface or build additional adapters in V1.

## Verified 2.0.3 operations

These names come from the published 2.0.3 declarations, not examples for the latest release.

| Need | Client operation | Contract / limitation |
| --- | --- | --- |
| Connect | `OpenCode.make({ baseUrl, headers })` | Use the private project endpoint and its configured authentication. |
| Create session | `session.create({ location: { directory }, title? })` | Directory is inside the sandbox, not an arbitrary Slack-supplied host path. Returns session information. |
| Resume identity | `session.get({ sessionID })` | Read the mapped session, then send subsequent prompts to that ID. No separate resume method is needed. |
| Read projected context | `session.context({ sessionID })` | Returns session message information. Verify compaction/history semantics before using it for reconciliation. |
| Read session log | `session.log(...)` | Returns an async iterable. Cursor/replay behavior needs further verification; do not assume it is equivalent to the live event stream. |
| Send input | `session.prompt({ sessionID, text, files?, id? })` | Returns `SessionInboxUser`, not the final assistant answer. Text and files are top-level fields. |
| Receive live events | `event.subscribe()` | Async iterable; filter and correlate events with the correct project/session. |
| Inspect active sessions | `session.active()` | Returns a map of active-session information; not sufficient by itself to declare an entire sandbox safe to stop. |
| Wait | `session.wait({ sessionID })` | Returns `Promise<void>`; verify completion semantics rather than treating resolution alone as successful work. |
| Inspect pending input | `session.inbox.list({ sessionID })` | Needed when checking whether a project can shut down. |
| Inspect permissions | `permission.list({ sessionID })` | Session-scoped pending requests. `permission.request.list(...)` also exists. |
| Reply to permission | `permission.reply({ sessionID, requestID, reply })` | `reply` is `once`, `always`, or `reject`. The bridge exposes only `once` and `reject`. |

The declaration also exposes prompt `delivery` values **`steer` / `queue`**, and optional `resume`. Do not substitute `immediate` / `deferred` from other examples. Their behavior, including input while busy, must be tested before choosing bridge policy.

## Input examples

Illustrative usage matching the inspected declarations; not yet an executed smoke test:

```ts
import { OpenCode } from "@opencode/client";

const client = OpenCode.make({
  baseUrl: projectEndpoint,
  headers: projectAuthHeaders,
});

const session = await client.session.create({
  location: { directory: "/workspace" },
  title: "Slack conversation",
});

const admission = await client.session.prompt({
  sessionID: session.id,
  text: "Review this file",
  files: [{ uri: "file:///workspace/attachments/input.txt", name: "input.txt" }],
});

await client.permission.reply({
  sessionID: session.id,
  requestID: pendingRequestID,
  reply: "once",
});
```

The approval call is a separate, owner-authorized interaction, not something automatically executed after sending a prompt. Never accept a session ID, project path, or approval scope directly from untrusted message content.

## Minimal bridge-facing interface

Proposed operations, not implemented code:

- **Open conversation:** create a session or validate an existing mapped session. Return its identity; missing saved sessions are errors, not permission to silently replace history.
- **Send input:** accept text and validated attachment references; return an admission receipt. Admission is not completion.
- **Observe:** provide normalized response updates, permission requests, completion, failure, and connection-loss events. Hide OpenCode-specific event structures here.
- **Reply to approval:** resolve one pending request with approve-once or reject, after the bridge validates owner and request identity.
- **Inspect conversation:** obtain durable state and pending work for reconnect recovery and idle checks.

Process start/stop belongs to the project runtime, not a second agent-session abstraction. Slack handlers should not manage SDK reconnections or interpret raw OpenCode events themselves.

## Streaming and recovery

- Consume the event subscription before admitting input so fast responses are not missed. Verify how actual stream readiness is signaled.
- Current official client documentation describes live-only events with no automatic reconnect or replay. Verify this behavior for the pinned package; never assume missed deltas will be resent.
- A disconnected stream means uncertain delivery, not successful completion or cancellation of the running task.
- Reconnect and reconcile from persisted session data before resuming Slack output. The exact 2.0.3 log/history recovery algorithm and native terminal events remain to be tested.
- Do not blindly retry an uncertain prompt: verify caller-supplied ID/idempotency behavior first. A duplicate Slack delivery must not become duplicate execution.
- Keep event consumption separate from slow Slack message updates so output publishing does not stall the incoming stream.

## Attachments

The pinned input type accepts `files: [{ uri, name?, description?, mention? }]`. Download Slack inputs using bridge credentials into controlled project-scoped storage, then provide a URI that is accessible inside the sandbox. Never give the agent the Slack token.

Current V2 attachment docs describe local `file:` and `data:` inputs, with format restrictions. Actual text/image handling, permitted MIME types, size limits, and model support must be tested against 2.0.3. Do not promise arbitrary PDF or binary support, forward private Slack URLs, or accept paths that escape the attachment directory.

## Permissions and lifecycle

- Match each pending request to its session, project, thread, and owner. Recheck it before forwarding a decision; stale or unauthorized interactions must not execute anything.
- OpenCode's execution layer must actually block until the decision arrives. A Slack button is only the interface to that decision.
- Keep permission enforcement separate from sandbox enforcement: approving an action cannot grant a new host mount or elevated privilege.
- Before idle shutdown, establish that all project sessions have no work, pending input, approvals, forms awaiting input, or running/background tools. If status is uncertain, keep the environment running.
- Stop the environment rather than freezing it. Retain its files and session storage independently of the process.
- On the next authorized message, start the environment, verify readiness and version, validate the saved session, and deliver the input. Reconnect event observation before execution.
- Saved session context does not imply interrupted shell commands can resume. Never replay those commands automatically.

## Required behavior verification

Use integration tests through the bridge's public entry point, with real OpenCode and sandbox behavior where enforcement matters. Mock only external Slack/inference boundaries; test outcomes, not internal method calls.

1. Bun loads the pinned network client, authenticates to the pinned server, creates a session, and receives a streamed reply.
2. Another prompt in the same thread preserves its conversation; a new thread gets a separate session.
3. Stop/start with persistent storage retains the mapped session and context.
4. Text and a supported image reach the agent; unsupported files are reported clearly.
5. A restricted fixture command has no side effect until approve-once; reject and unauthorized decisions leave it unexecuted.
6. Event disconnection and recovery do not fabricate completion, lose the final answer, or rerun the prompt.
7. Idle shutdown waits for pending work and approvals; an incoming message during a lifecycle transition is neither lost nor duplicated.
8. Bolt message/action handling and Socket Mode reconnect work under Bun. A local simulated-Slack integration check passed with Bun 1.4.0 and Bolt 5.1.0; real Slack and Linux VPS verification remain pending. Bolt declares Node engine requirements rather than official Bun support.

Dependency installation and a no-network client import check are part of project setup. No live Slack test or V2 server integration test has been completed for this reference. Exact native event names, admission retry semantics, and the supported attachment matrix remain open verification items.

## Sources and version discipline

- [Pinned client package](https://www.npmjs.com/package/@opencode/client/v/2.0.3): published `dist/promise/generated/client.d.ts` and `types.d.ts` inspected directly.
- [V2 network client](https://opencode.ai/v2/docs/build/client/): connection, streaming, authentication, and local service helpers.
- [Embedded SDK](https://opencode.ai/v2/docs/build/sdk/): explains why embedding is different from our network adapter.
- [V2 HTTP reference](https://opencode.ai/v2/docs/api): current documentation, not a guarantee of 2.0.3 compatibility.
- [Attachments](https://opencode.ai/v2/docs/attachments/).
- [Permissions](https://opencode.ai/v2/docs/permissions/).
- [Bolt package metadata](https://github.com/slackapi/bolt-js/blob/main/package.json).

Current docs and development-branch examples can differ from 2.0.3. In particular, do not use a nested `prompt: { text, files }`, `session.message.list`, or `permission.reply({ permissionID, response })` as the pinned contract. The inspected package uses top-level prompt fields, a callable `session.message`, and `{ sessionID, requestID, reply }` for approvals. Validate against the matching running server before calling any surface production-ready.
