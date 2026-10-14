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
3. Resolved 2026-09-27: keep the existing hard block on `git push`.
4. Resolved for V1: no outbound allowlist, because there is no egress proxy.
5. Resolved 2026-09-27: policy version 2 allows all previously approval-gated actions automatically; existing hard blocks remain.
6. Whether owner replies in a bound thread continue the session without a mention.
7. `queue` or `steer` for messages sent while the agent is busy.
8. Fixed Compose containers or containers started on demand by the bridge.
9. VPS size, whether `/dev/kvm` exists, where project folders live, and whether Docker is installed.
10. Whether private channels are used.

## Policy version 2 runtime verification (2026-09-27)

Ran the real OpenCode 2.0.15 server on macOS with the updated deployment permissions and safety plugin, a scripted model at the inference boundary, and a disposable project plus local bare Git remote. The plugin RPC reported policy version 2. A shell command wrote the expected file contents, and a subsequent command created a verified Git commit. Neither emitted `permission.asked` or left pending permission requests. `git push origin main` and `sudo touch forbidden.txt` produced tool permission-denial events without prompts; the bare remote remained empty and the forbidden file did not exist. No approval replies were sent. These checks verify server behavior, not live Slack delivery or container isolation; those remain deployment checks.

## First live VPS deployment (2026-09-27 Toronto / 2026-09-28 UTC)

Deployed release `7b67866` to `/opt/slack-tag` on Hetzner. Docker Compose runs the OpenCode 2.0.15 `alpha` service on loopback port 4101 with policy version 2 and `opencode-go/kimi-k2.7-code`. The host bridge runs as `devuser` through a systemd override; configuration and SQLite are under `/var/lib/slack-tag`, and installed credentials are root-controlled under `/etc/slack-tag`. The existing Go credential was reused without changing the existing Podman OpenCode instance. Temporary credential copies were removed after verification.

The private `gem-research-suite` channel in Kannav Work maps to `/home/devuser/projects/gem-research-suite` (mounted as `/project`). A real owner mention read project guidance and README, ran Git status and log, and returned the correct latest commit `bb84cff`. A follow-up without a mention recalled the thread's check phrase. After deliberately terminating the idle bridge process, systemd restarted it and a further Slack reply recalled the same phrase. SQLite recorded one thread/session, three completed replies, and zero approval requests. Live attachment handling, a full VPS reboot, and container isolation have not been reverified in this deployment. The project preparation script created untracked `opencode.json` and `opencode.jsonc` mount placeholders.

## Per-project server passwords and networks (2026-10-01)

Ran the branch's `deploy/compose.yaml` on Docker Desktop with `alpha`, `beta` and `key-proxy`, each project with its own env file. Each server accepted only its own password (200) and rejected the other's (401). From `alpha`, `beta` did not resolve by name and timed out by IP; both projects reached `key-proxy`. The `alpha` process environment did not contain `beta`'s password. The real bridge reported both channels ready with the right passwords and both unavailable when swapped. Not verified on the VPS, with gVisor, or through real Slack.

## Policy version 3 runtime verification (2026-10-02)

Ran the real OpenCode 2.0.15 server with `deploy/opencode.global.jsonc`, the safety plugin and a scripted model. OpenCode sends a chained or piped command as one resource per command (`ls; touch x` → `["ls", "touch x"]`), so the plugin checks every part; version 2 checked only the first and would have allowed `touch x`. `ls`, `git status` and `cat` ran without a prompt. `rm -rf src` asked and left `src` intact while waiting, after rejection and after 5 seconds of silence followed by the bridge's timeout rejection; it deleted `src` only after approve-once. `ls; touch`, `ls && touch` and `ls | sh` asked and did not run when rejected. `git -C . push`, `git push`, `sudo touch` and `curl … | sh` were refused without prompts; the bare remote stayed empty. With the same config and no plugin, `rm keep.txt` asked instead of running. Edit/read actions and subagent sessions were not exercised against real OpenCode (the scripted model only calls the shell tool); subagent routing is covered by the simulated-service bridge test.

## Separate upload inbox (2026-10-02)

On Docker Desktop, `alpha` from this branch's `compose.yaml` mounted the host inbox at `/inbox` read-only: the agent's user could list and read an upload, but creating a file or replacing the thread folder failed with "Read-only file system", and the project folder had no `.slack-tag/`. Integration tests show uploads land in `<state>/inbox/<channel>/<thread>/` and reach OpenCode as `file:///inbox/<thread>/<name>`; symlinks the agent plants at the old `.slack-tag/inbox` and `.git/info/exclude` receive no writes. Not verified on the VPS or with a real model reading the upload.

## Separate agent user, gVisor and firewall (2026-10-02)

Ran the branch's image and `deploy/compose.yaml` with real OpenCode 2.0.15 and a scripted model behind `key-proxy`, under runc on Docker Desktop and under gVisor (`runsc` release-20260928.0) in Docker-in-Docker. In both, agent shell commands ran as `agent` (uid 1001) with no capabilities; reading `/proc/<server>/environ` and `/data` was denied; calling the server API from the shell without the password returned 401; the agent could still write and commit in the project. Under gVisor, `uname -r` reported `4.19.0-gvisor`.

gVisor cannot reach Docker's built-in DNS (127.0.0.11) on user-defined networks, and `--reproduce-nat`/`--reproduce-nftables` did not help, so project containers find `key-proxy` by a fixed address and use public resolvers. With `deploy/firewall.sh` applied, connections from a project container to the host and to 169.254.169.254 were dropped (counted by the rules), internet and `key-proxy` stayed reachable, and the host could still reach the published server port. A first version without the conntrack rule also dropped the server's replies to the host. Files shared from macOS into Docker-in-Docker appear root-owned under gVisor, so the gVisor write check used a Linux-owned project folder. Not verified on the VPS or through real Slack.

## VPS security migration (2026-10-03)

Deployed main `920460a` at 16:02 Toronto (20:02 UTC), retaining Compose project `deploy`, volume `deploy_alpha-data`, SQLite thread mappings and the existing `gem-research-suite` channel/project. Root-only rollback copies of application, credentials, units, state and server data are under `/var/backups/slack-tag/20261003T195951Z-920460a`. A clean source archive passed `npm run check` on Node 24.21.0: eight integration tests passed. The working checkout's lint run scanned historical untracked `.claude/worktrees`, so it was not used as the release check.

Migrated the model key into `proxy.env`, replaced the shared server password with the alpha-specific password, created the dedicated bridge user and read-only upload inbox, prepared project group permissions, rebuilt OpenCode 2.0.15 and installed the firewall and registration helper. gVisor's apt repository failed signature verification (`NO_PUBKEY 6FC6D554E32BD943`); the [official release archive](https://gvisor.dev/docs/user_guide/install/) passed its SHA-512 check and installed `runsc release-20260928.0`, including its sidecar binaries. Docker needed a restart to recognize the runtime; reload alone did not. The failing apt source was disabled without bypassing signature checks.

Verified directly on the VPS, without posting to Slack:

- Bridge active as `slack-tag`, `NoNewPrivileges=yes`, `ProtectHome=yes`; logs report the channel ready and Socket Mode connected. Authenticated plugin RPC reports policy version 3; unauthenticated requests return 401.
- Project runtime `runsc`, read-only image root, only `SETUID`/`SETGID` capabilities, loopback port 4101, network bridge `st-alpha`, and `/inbox` mounted read-only.
- Agent wrapper runs uid 1001/group 1000 with zero effective capabilities. Reading uid 1000 server process environments and `/data`, and writing `/inbox`, fail. With a clean caller environment, no server password is present.
- The agent reaches the key proxy and receives 200 from the provider's models endpoint. Host SSH and metadata connections fail, with packets counted by the corresponding firewall DROP rules.
- Polkit allows the bridge user to start a validly named registration unit: the synthetic `nonexistent` project reaches the helper and fails with `no env file`. Stopping that unit and starting an invalidly named unit require authentication. The synthetic failure was reset afterwards.

Real Slack mention/reply, approval, upload and model inference still need an owner smoke test; these checks do not establish those flows. Onboarding remains unconfigured. Its current bridge-side folder discovery/preparation cannot work against `/home/devuser/projects` under the hardened unit (`ProtectHome=yes`, writes restricted to state); preparation must move into the trusted helper before enabling it. The service sandbox was not weakened.

## Manual Slack feature checks (2026-10-03)

Used the native Slack UI in Kannav Work, against deployed `920460a`:

- In `gem-research-suite`, a new owner mention read the project README and reported `/project` and GEM Research Suite. The `id` action asked in Slack, completed after approve-once, and returned `uid=1001(agent) gid=1000(node) groups=1000(node)`. A reply without a mention recalled `CEDAR-920460A` exactly.
- In that thread, `@OpenCode /model` listed the current Kimi model and available Go models. `@OpenCode /model minimax-m3` returned `Model set to opencode-go/minimax-m3 for this thread`. A subsequent prompt completed and recalled the same phrase. `/model` in another existing thread still reported `opencode-go/kimi-k2.7-code`; the change did not alter that thread. The smoke-test thread remains on MiniMax.
- In the previously empty, unmapped `social` channel, added OpenCode and sent `@OpenCode register`. Its reply was `This channel is not mapped to a project, and project registration is not configured.` Registration is blocked by the missing production onboarding configuration; folder selection/container creation were not reached, and no project was registered. The sandbox incompatibility documented above still needs a fix before enabling onboarding.

Screenshots of the smoke response, remembered phrase, model switch with continued inference, and registration blocker were saved as local verification artifacts. Upload handling, reject-button behavior and the other Slack commands were not exercised in this manual run.

## Registration and queue deployment (2026-10-03 Toronto / 2026-10-04 UTC)

Deployed `49c4a42` with owner authorization after all nine required checks passed against a clean source archive. Backups are under `/var/backups/slack-tag/20261004T014123Z-49c4a42`. Rebuilt the OpenCode 2.0.15 image and updated the bridge/helper while preserving the existing alpha project path, credentials and `deploy_alpha-data` volume. Enabled onboarding at `/srv/slack-tag/projects` with the systemd helper, without weakening the bridge sandbox.

Manual verification through the native Slack composer and authenticated Slack browser UI:

- `@OpenCode register` in `#social` offered `deploy-verification`. Selecting it prepared the folder, started the project on loopback port 4102, verified the safety plugin and saved the channel mapping. Its container reports runtime `runsc` and a read-only root.
- A prompt in the registered project read its README and reported `Deployment verification`, `/project` and the correct thread marker. Switching that thread to `opencode-go/minimax-m3` succeeded; subsequent inference retained the marker. The MiniMax reply also included extra reasoning text despite the request for only the marker, so exact response formatting failed.
- The existing alpha thread recalled `CEDAR-920460A` after the release, verifying its persisted session and continued inference.
- A harmless `printf queue-first | cat` request waited for owner approval. A second alpha thread received `Queued: 1 ahead of this message in this project.` After approve-once, the first returned `queue-first` and the second returned `QUEUE-SECOND-49C4A42`, verifying queue draining across threads from one user.

Registration, project response, model switching and queue screenshots were saved as local artifacts. Two distinct Slack users were not available for a live test; teammate acceptance is verified by the simulated-service tests only. Live uploads, rejection and registered cross-project connectivity were not tested in this run.

Both bridge/firewall services and all four containers remained active at the final check. Removed `/etc/sudoers.d/slack-tag-deploy` and verified that passwordless sudo was denied.

## Progress display deployment (2026-10-13 Toronto / 2026-10-14 UTC)

Deployed `b67a508` at 22:57 Toronto, including main through `e000f44` and a fix that preserves approval prompts when a progress-card update fails. A clean release archive passed `npm run check` on Node 24.21.0: all 12 integration tests passed. Backups of the application, credentials, service unit and stopped bridge state, plus the release archive, are under `/var/backups/slack-tag/20261014T025730Z-b67a508`.

Only bridge source changed on the VPS; dependencies, plugin, deployment files and all six running containers were unchanged. Both configured channels (`deploy-verification`, `temp-ideas`) passed the plugin readiness check and had no active sessions before or after deployment. Source hashes matched the tested release; configuration and bridge credentials were unchanged. SQLite integrity passed, and all 13 thread, 34 reply and 4 approval rows matched the backup. The bridge runs as `slack-tag` with its existing sandbox, the firewall is active, and the service restart count is zero.

Socket Mode initially logged pong timeouts, then connected at 22:58:42 Toronto. Slack authentication succeeds, but the installed bot token lacks `reactions:write`: progress cards can work, while prompt reactions require adding that bot scope and reinstalling the app. Live Slack progress, approval and upload checks remain an owner smoke test; no Slack messages were sent during deployment. Removed temporary deployment files and `/etc/sudoers.d/99-slack-tag-deploy`; a fresh SSH connection confirmed passwordless sudo was denied while both services remained active.

## Live progress and attachment checks (2026-10-13 Toronto)

With owner authorization, tested `b67a508` through native Slack in [the smoke-test thread](https://kannavsknowledgebase.slack.com/archives/C0C6NN5Q16G/p1791947449923669) in `dogfooding-channel` (the configured `temp-ideas` channel). A fresh `@jeff /model` listed the current Kimi model and available models. A subsequent mention ran `pwd` and a harmless `printf SLACK-APPROVED-B67A508 | cat` pipeline: the card showed a completed step and a step waiting for approval, approve-once resumed the run, the summary showed two completed steps, and the answer returned `/project` and the marker. Rejecting a second pipeline changed the approval to rejected and the card to stopped, with an interrupted response.

Uploaded a synthetic text file containing `Verification token: UPLOAD-B67A508-7C2F`. The first request to read it with a tool failed because the model searched the project folder; its answer used the inline attachment content. An explicit shell read of `/inbox/1791947449.923669/slack-smoke-b67a508.txt` then completed successfully and returned the exact uploaded contents, verifying transport and container inbox access. No project files were changed. Database approval rows were not inspected during this smoke test because temporary root access had already been revoked.

Reaction configuration remains blocked by browser account access: the developer page for production app `A0C4DEUGRAB` says the signed-in Chrome account is not a collaborator. No scopes or installation settings were changed; reactions remain unverified pending owner sign-in.

## Live reaction verification (2026-10-14 Toronto)

Signed into the app owner's Google account, added the bot scope `reactions:write`, and reinstalled `jeff` into Kannav Work with owner confirmation. In [a fresh smoke-test thread](https://kannavsknowledgebase.slack.com/archives/C0C6NN5Q16G/p1791986750272609), a request for a fixed response without tools received an eyes reaction, then a white tick and the exact reply `REACTION-SMOKE-OK`. This verifies reaction updates using the running production installation. SSH confirmed `slack-tag` active with `NRestarts=0`; no service restart or credential replacement was needed.

## Haiku default (2026-10-14 Toronto)

With owner authorization, changed both configured channel defaults and `onboarding.model` to `opencode-go/claude-haiku-5-5`. Existing thread model selections were preserved. Backed up the prior configuration to `/var/backups/slack-tag/haiku-default-2026-10-14T14-32-21-567Z.json` and atomically replaced it while the bridge was stopped, preserving ownership and permissions.

The idle `deploy-verification` OpenCode container needed a restart and catalog refresh before advertising Haiku. Both projects then returned the exact `HAIKU-DEFAULT-OK` response in disposable project-scoped Haiku sessions, which were removed afterwards. The location-free generate endpoint had reported model unavailable; project-scoped verification succeeded. After the config update, both channels logged ready and the bridge connected. Bridge and firewall remained active, with the existing sandbox and zero automatic restarts. Removed the temporary passwordless sudo rule and confirmed denial in a fresh SSH session. No application source changed; this check did not send a new Slack message.

## Channel and infrastructure cleanup (2026-10-14 Toronto)

Renamed the required workspace channel to `research`, added Jeff, and mapped it to the existing GEM alpha server and persistent volume. Preserved `dogfooding-channel` and its `temp-ideas` server/inbox identity. Archived `social` and `new-channel`; the Slack channel directory now lists only research and dogfooding as active. Removed the obsolete verification mapping, its two containers and its network. Moved its project folder outside onboarding discovery to `/srv/slack-tag/archived-projects/deploy-verification`; retained its volume, inbox and SQLite history. Stopped-state and credential backups, including the archived registration env, are in `/var/backups/slack-tag/channel-cleanup-2026-10-14T14-43-47-777Z`.

Both configured channels logged ready and Socket Mode connected. A real research mention read `README.md`, identified GEM Research Suite and completed successfully: [verification thread](https://kannavsknowledgebase.slack.com/archives/C0C2YBS6P7U/p1791989224079519). A fresh dogfooding `/model` returned `opencode-go/claude-haiku-5-5`. Four containers remain active, bridge/firewall are active, and bridge automatic restarts remain zero. Removed temporary passwordless sudo and verified denial from a fresh SSH connection.

## Private research channel (2026-10-14 Toronto)

With owner authorization, renamed required public channel `C0C2YBS6P7U` to `general` and created invite-only `research` (`C0C979QND8S`) with Kannav and Jeff. Moved only the GEM configuration entry to the new ID; preserved the alpha server, volume, inbox and Haiku default. Dogfooding remains private and unchanged. Prior public messages and thread records remain in general; no conversation history was moved. Slack refuses app/member removal from its required general channel, but general no longer has a project mapping.

Backed up stopped bridge state under `/var/backups/slack-tag/private-research-2026-10-14T14-54-56-784Z`. Both channels reported ready and Socket Mode connected after restart. A real mention in private research read `README.md`, returned GEM Research Suite, and showed a completed read step and success reaction. Bridge/firewall remain active. Removed temporary sudo and verified passwordless sudo denial in a fresh SSH session.

## Git proxy and approval deployment (2026-10-14 Toronto)

Merged PRs #34 and #35; deployed release `572f554bada882ae522cbb2c7c6df800181ae22b` (merged main `bccb5f8` plus the existing production approval-card fix `b67a508`). The combined release passed `npm run check` with 12 tests. Application/state/config backups are under `/var/backups/slack-tag/git-proxy-20261014-572f554`; the previous image is tagged `slack-tag-opencode:rollback-git-20261014`.

Research uses `deploy-git-proxy-1` at `172.30.1.254`, reusing devuser's existing Kannav02 gh credential. Only that sidecar receives the credential; the agent receives four Git URL rewrites. Enabled `GIT_ALLOW_PUSH=1` with the owner's explicit acceptance of command-policy-only force-push protection: GitHub rejects repository ruleset configuration on the current private-repository plan, and the credential has no repository administration permission. The proxy itself does not prevent protocol-level history rewrites. Dogfooding received the updated policy image but has no Git remote configured.

During preparation, the existing `.git/FETCH_HEAD` was owned by sandbox uid1001; restored only that regular file to devuser so the required preparation script could run. Rebuilt/recreated both project containers and proxies; both project runtimes remain `runsc` with read-only roots. Bridge and firewall are active and both channels logged ready.

In the [real Slack verification thread](https://kannavsknowledgebase.slack.com/archives/C0C979QND8S/p1791999358419039), `git fetch origin` and normal `git push origin HEAD:refs/heads/codex/slack-git-check-20261014` succeeded without approval. GitHub independently confirmed the new branch at `bb84cffa54a0b605e9e4d870ab81adce96de5ea1`, matching local HEAD. The four requested commands needed no approval. An additional, unrequested `git rev-parse HEAD` asked for approval and was rejected; that read-only command remains a policy gap. The agent then reported the completed outputs without running more commands. Deleted the disposable GitHub branch and pruned its local tracking ref; no project files or commits were changed. Fetch advanced origin/main while leaving local main unchanged.

Removed `/etc/sudoers.d/99-slack-tag-deploy`, validated sudoers, invalidated cached sudo authentication and verified `sudo -n true` is denied. Bridge/firewall remained active afterward.
