# Findings

Research and compatibility results that inform the V1 implementation. Decisions agreed with the owner are recorded in `SPEC.md`; this file holds the evidence and the questions still open. The design, the proposed defaults, and the build slices are in `docs/plan.md`.

## Agreed

- Backend: OpenCode v2, pinned to `@opencode/cli`, `@opencode/client`, and `@opencode/plugin` 2.0.15. The OpenCode v1 server API and v1 plugins are not used.
- Inference: the owner's OpenCode Go subscription, through OpenCode's built-in `opencode-go` provider. The key is read from `OPENCODE_API_KEY`. Anthropic subscriptions are not used.
- Slack: the bot is tagged as `@OpenCode`.
- Hosting: the owner's VPS.
- Bridge: Node.js and TypeScript on the VPS host, Slack Socket Mode, owner-only messages and clicks, a fixed channel-to-project config, SQLite for thread links, pending approvals, and Slack message ids.
- Isolation: one container per mapped channel, gVisor if available, running `opencode serve` with only that project mounted read-write and its own data volume. No Slack tokens in the container.
- Safety plugin: a small OpenCode v2 server plugin, loaded read-only from the global config. It applies the allow/ask/deny policy through the permission `evaluate` hook, removes secrets from agent shells through the shell `create.before` hook, and reports its policy version over an RPC the bridge checks at startup.
- Egress: no proxy in V1. The Go key is passed to the container as an environment variable, and the plugin removes it from agent shells. This stops casual leaks, not a determined agent. A proxy can be added later.
- Verification: manual checklists per slice, no automated tests.

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
| Go routing | With `OPENCODE_API_KEY` set, `opencode-go/kimi-k2.7-code` completed `MODEL=opencode-go/kimi-k2.7-code ./real.sh`: one shell approval for `touch real-model.txt`, the file created only after `once`, reply `DONE`, `session.execution.succeeded`. `glm-5.2` and `minimax-m3` were not retried. Earlier, a dummy key reached Go and failed with `provider.auth` 401, and a run with no key failed all three immediately with `provider.no-route`. |
| Go images | `opencode-go/kimi-k2.7-code` advertises `capabilities.input` of `text`, `image`, and `video`. A `session.prompt` with a solid blue PNG attached as `files: [{ uri: "file:///…/sample.png" }]` (neutral filename) finished `session.execution.succeeded` and replied `Blue`, with no tool call. `minimax-m3` also advertises image input; `glm-5.2` advertises `text` only. Other connected Go models that advertise `image` include `kimi-k3`, `glm-5.3-flash`, `qwen3.8-flash`, and `deepseek-v4.1-flash`. |
| Go headers | OpenCode sends its own `user-agent` and `x-opencode-session` on model requests, as Go requires. A proxy in front must forward them. |

## Plugin API at 2.0.15 (run during S1)

Checked against a 2.0.15 server with `deploy/opencode.global.jsonc` and the fake model, then once with `opencode-go/kimi-k2.7-code`.

- A `plugins` entry must be a directory. A file path logs `configured plugin path must be a directory` and does not load. The directory entry is `index.ts`. `index.mjs` is resolved and not executed. `Plugin.define({ id, setup })` from `@opencode/plugin` runs.
- A path in the config is resolved from the config file's directory. `../plugin` in `deploy/opencode.global.jsonc` is the repo `plugin/` directory when that file is the one OpenCode reads.
- `POST /api/rpc/slack-tag/status` with `{"input":{}}` returns `{"output":{"pluginVersion":"1","policyVersion":1}}`. A body of `{}` returns `rpc.invalid_input` (`Expected object`). The checklist curl uses `{}`. The working body on 2.0.15 is `{"input":{}}`.
- A shell permission uses action `shell` and the command as the resource, for example `["ls"]`. `RUN: ls` finishes `session.execution.succeeded` with no `permission.asked`. `RUN: touch asked.txt` emits `permission.asked`, and `reject` leaves the file absent. `RUN: git push origin main` fails with `permission.rejected` / `Blocked by configuration policy` and no prompt. `RUN: sudo ls` fails with `Blocked by the safety plugin` and no prompt.
- `create.before` runs before the shell. Deleting `OPENCODE_API_KEY` is not enough when another variable's value re-exports it. The hook also drops any value that contains `OPENCODE_API_KEY`, `OPENCODE_SERVER_PASSWORD`, or `SLACK_`. After `once` on `env > env.txt`, `grep -c` of those names is `0`. With the real Go model, `echo KEY=${OPENCODE_API_KEY:-unset}` replies `KEY=unset`.
- Project plugins load. A directory `.opencode/plugins/marker/index.ts` writes its marker on startup. A `plugins` directory in the project's `opencode.json` does the same. Both are loads, so S5 still needs those paths read-only.
- Read, edit, and web action names were not emitted by the fake model. The plugin treats `read`, `glob`, `grep`, `list`, and `search` as allow, `edit`, `write`, and `patch` as allow except protected paths, and `webfetch` and `websearch` as ask. Anything else is ask. The docs' permission example uses the action `read`.

## OpenCode Go constraints

- Limits are a dollar budget per model: 20% per rolling 5 hours, 50% per week, 100% per month. Expensive models (Kimi K3, Qwen3.8 Max, Grok) allow roughly 100–200 requests per 5 hours; budget models allow thousands. One agent task can use tens of requests.
- At the limit Go returns HTTP 429 with `Retry-After`. The bridge must report it in the thread.
- Only some Go models accept images; check the model's `capabilities.input` before sending attachments.

## Design notes

- The container is the security boundary. Approvals control intent; allowed commands such as tests still run arbitrary project code.
- The agent must not be able to change its own policy: keep the permission rules, the policies, and the plugin in the global config, and mount `opencode.json`, `opencode.jsonc`, and `.opencode/` read-only.
- Removing the key from agent shells does not hide it from a process that reads the server's environment, for example through `/proc`. An egress proxy that adds the key would close this; it is deferred.

## S3 buttons

The bridge posts `permission.asked` as Approve and Reject. Approve sends `once`. Reject sends `reject`. A different Slack user is refused and the command stays unexecuted. The bridge has no code path that sends `always`. A local thread page drives the same handlers when Slack tokens are unset. Checked against OpenCode 2.0.15 and the fake model: `touch approved.txt` created the file only after Approve; `touch rejected.txt` stayed absent after Reject.

## Open questions

Proposed defaults for questions 1, 3, 5, 6, 7, and 8 are in `docs/plan.md`. They await the owner's agreement.

1. Default Go model per channel, given the 5-hour limits.
2. Resolved for V1: the Go key sits in the container, and no proxy is used.
3. Whether the agent may push to git, and with what credential.
4. Resolved for V1: no outbound allowlist, because there is no egress proxy.
5. The concrete allow/ask/deny policy, and the approval timeout.
6. Whether owner replies in a bound thread continue the session without a mention.
7. `queue` or `steer` for messages sent while the agent is busy.
8. Fixed Compose containers or containers started on demand by the bridge.
9. VPS size, whether `/dev/kvm` exists, where project folders live, and whether Docker is installed.
10. Whether private channels are used.
