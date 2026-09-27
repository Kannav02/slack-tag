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
- `POST /api/rpc/slack-tag/status` with `{"input":{}}` returns `{"output":{"pluginVersion":"1","policyVersion":1}}`. A body of `{}` returns `rpc.invalid_input` (`Expected object`), so the S1 checklist curl now sends `{"input":{}}`.
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

## Slice S2

Verified against OpenCode 2.0.15 with `opencode-go/kimi-k2.7-code` by driving the bridge's message handler and Slack poster. The dev Slack app tokens were not available, so nothing was posted to Slack.

- `client.rpc(definition).status({})` returns the plugin version and policy version. A server started without the plugin makes that call fail, and the bridge treats the channel as unavailable.
- A missing `OPENCODE_API_KEY` fails the run with `provider.no-route` and the message `Model unavailable: opencode-go/kimi-k2.7-code`. The bridge posts that text and does not present it as success.
- A message sent with `delivery: "queue"` stays in the same execution. `session.inbox.delivered` for that inbox item is the point where its text starts. The bridge closes the current Slack message there and streams the rest into a new message.
- This environment is Node.js 22.14. `node:sqlite` and TypeScript type stripping both work behind `--experimental-sqlite` and `--experimental-strip-types`. The bridge start script passes those flags.

## Slice S5

First verified with Docker and `runc`, then rerun under gVisor in the integration run below.

- The container user is uid 1000, the same as the bridge user on this machine. `deploy/prepare-project.sh` creates `.opencode/`, `opencode.json`, `opencode.jsonc`, `.git/hooks`, and `.slack-tag/inbox` before Compose starts, and makes the inbox group-writable for uid 1000. A root bridge on the VPS should write inbox files as uid 1000 or stay in group 1000.
- `.git/hooks` and `.git/config` are read-only bind mounts on top of the writable project. Writes fail with "Read-only file system", so a hook written by the agent cannot run later on the host. The plugin deny remains as well.
- The image root is read-only. The project and the OpenCode data volume are writable. The image copies the plugin to `/opt/slack-tag/plugin` and `deploy/opencode.global.jsonc` to `/opt/slack-tag/opencode/opencode.jsonc` with `XDG_CONFIG_HOME=/opt/slack-tag`, so the same file's `../plugin` resolves in the container and in the repo.
- `docker inspect` on `alpha`: runtime `runc`, user `1000:1000`, `CapDrop` `ALL`, `no-new-privileges`, memory 2g, pid limit 512, port `127.0.0.1:4101` only. Mounts are the project read-write, the data volume, a `/tmp` tmpfs, and read-only `.opencode/`, `opencode.json`, `opencode.jsonc`, `.git/hooks`, and `.git/config`.
- Writing `/project/hello.txt` from the container created `alpha/hello.txt` on the host with content `hi`. `../beta`, the absolute host path of `beta`, and the bridge env file were not visible. Writes to `.opencode/plugins` and `opencode.json` failed read-only, and the host file stayed `{}`. `mount -t tmpfs` failed. `docker exec env` and `/proc/1/environ` contain no `SLACK_` variable. The server process does have `OPENCODE_SERVER_PASSWORD` and `OPENCODE_API_KEY`; stripping those from agent shells is the plugin's job, already checked in S1.
- After `docker compose restart alpha`, the plugin RPC still returned policy version 1 and `hello.txt` was still on the host.

## Integration run (S1 to S6 in one bridge)

Checked on 2026-09-25 by driving the bridge's handlers against OpenCode 2.0.15, with a recorder in place of the Slack Web API. No Slack app tokens were available.

- `@slack/bolt` 4.4.0 is CommonJS. `import { App } from "@slack/bolt"` fails under Node ESM with `Named export 'App' not found`, so the bridge uses the default export.
- `delivery: "queue"` on an idle session starts the run at once, so the bridge always sends it. A queued message's `session.inbox.delivered` closes the current Slack message. S2 step 7 answered `QUEUED-OK` in its own message.
- Reject ends the run with `session.execution.interrupted`. The thread shows "The run was interrupted."
- `permission.list` needs a `sessionID`. On start the bridge lists pending requests for every stored thread, keeps prompts it already posted, posts prompts for requests asked while it was down, and marks stored prompts that are no longer pending. The approval timeout is computed from the stored ask time.
- After `docker compose restart`, the event stream throws `Transport`. The bridge resubscribes after 5 seconds and later events stream normally. A channel whose server was down at bridge start is checked again on the next mention.
- `model.list` returns `capabilities.input`. Kimi advertises `text`, `image`, and `video`, and `glm-5.2` only `text`. A PNG and a `.txt` in `<projectDir>/.slack-tag/inbox/<thread_ts>/`, passed as `file://` URIs built from `serverDir`, were read by Kimi on the host and in the container. A `.zip`, a file over 20 MB, and an image for `glm-5.2` are refused before any session is created. `../../escape.txt` is stored as `escape.txt` inside the inbox, and a repeated name gets a `-2` suffix. The inbox is added to `.git/info/exclude` when that file exists.
- gVisor `runsc` 20260921.0 installed and ran in this VM. Under `runsc`, S5 steps 1 to 10 passed: shell writes to `.opencode/` and `opencode.json` failed read-only, `mount` needed superuser, and the agent shell's `env` had no Go key, server password, or `SLACK_` variable. In this VM, containers on a user-defined Docker network had no outbound traffic under either runtime, so the checks used a local override with `network_mode: bridge`. S6 step 5 must confirm that the Compose network reaches OpenCode Go on the VPS.
- Open questions 9 and 10 are still unknown, because no agent had SSH access to the VPS.

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
