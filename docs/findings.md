# Findings

Research and compatibility results that inform the V1 implementation. Decisions agreed with the owner are recorded in `SPEC.md`; this file holds the evidence and the questions still open.

## Agreed

- Backend: OpenCode v2, pinned to `@opencode/cli` and `@opencode/client` 2.0.15. The V1 server API and plugins are not used.
- Inference: the owner's OpenCode Go subscription, through OpenCode's built-in `opencode-go` provider. The key is read from `OPENCODE_API_KEY`. Anthropic subscriptions are not used.
- Slack: the bot is tagged as `@OpenCode`.
- Hosting: the owner's VPS.

## Verified against OpenCode v2 2.0.15

Reproduce with `spike/v2/run.sh` (fake model, no key) and `spike/v2/real.sh` (real model).

| Behaviour | Result |
| --- | --- |
| Server auth | `opencode serve` requires HTTP basic auth, username `opencode`. It generates a password unless `OPENCODE_SERVER_PASSWORD` is set. |
| Sessions | `session.create({ title, location: { directory }, model? })`; `session.prompt({ sessionID, text, files?, delivery? })`. |
| Streaming | `event.subscribe()` yields `{ type, data: { sessionID, ... } }`. Text arrives as `session.text.delta`; tools as `session.tool.called`, `.success`, `.failed`. |
| Completion | A run ends with `session.execution.succeeded`, `.failed` or `.interrupted`. There is no `session.idle` event. |
| Approvals | An `ask` rule emits `permission.asked` and blocks the action. `permission.reply` with `once` runs it; `reject` leaves it unexecuted and rejects every other pending request in the session. |
| `always` | Saves a durable project-scoped allow rule. The bridge must never send it. |
| Restart recovery | `permission.list({ sessionID })` returns pending requests. Sessions and history survive a server restart when the data directory is kept. |
| Hard denies | Global `experimental.policies` deny rules fail without prompting (`Blocked by configuration policy`). Project config cannot lift them. |
| Busy session | `delivery: "queue"` runs a message after the current run; the default, `"steer"`, redirects the running agent. |
| Real model | `opencode/big-pickle` (free, no key) completed a prompt with one shell approval and a streamed reply. |
| Go routing | `opencode-go/kimi-k2.7-code` with a dummy key reached Go and failed with a typed `provider.auth` 401 error. Not yet run with the real key. |
| Go headers | OpenCode sends its own `user-agent` and `x-opencode-session` on model requests, as Go requires. A proxy in front must forward them. |

## OpenCode Go constraints

- Limits are a dollar budget per model: 20% per rolling 5 hours, 50% per week, 100% per month. Expensive models (Kimi K3, Qwen3.8 Max, Grok) allow roughly 100–200 requests per 5 hours; budget models allow thousands. One agent task can use tens of requests.
- At the limit Go returns HTTP 429 with `Retry-After`. The bridge must report it in the thread.
- Only some Go models accept images; check the model's `capabilities.input` before sending attachments.

## Design direction (not yet agreed)

- A bridge process holds the Slack tokens and connects with Socket Mode.
- One gVisor container per mapped channel runs `opencode serve` with only that project mounted and its own data volume.
- An egress proxy is the only route out, with a per-project allowlist. It can add the Go key so containers never hold it.
- The container is the security boundary. Approvals control intent; allowed commands such as tests still run arbitrary project code.
- The agent must not be able to change its own policy: keep the permission rules and policies in the global config, and mount `opencode.json` and `.opencode/` read-only.

## Open questions

1. Default Go model per channel, given the 5-hour limits.
2. Whether the Go key sits in the container or is added by the proxy.
3. Whether the agent may push to git, and with what credential.
4. Outbound allowlist per project.
5. The concrete allow/ask/deny policy, and the approval timeout.
6. Whether owner replies in a bound thread continue the session without a mention.
7. `queue` or `steer` for messages sent while the agent is busy.
8. Fixed Compose containers or containers started on demand by the bridge.
9. VPS size, whether `/dev/kvm` exists, where project folders live, and whether Docker is installed.
10. Whether private channels are used.
