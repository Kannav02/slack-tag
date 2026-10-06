# Feature backlog and decisions

Planning snapshot: 2026-09-29. [Notion project](https://www.notion.so/3e91697f7f2281d988abf6e8d9ed6b78) holds the original items and a short audit summary. This file is the source of truth for Cloud tasks; it is not synced with Notion.

Start a task with the handoff prompt in `docs/cloud-development.md`, naming one item ID below. Each item should fit one focused PR (under ~300 changed lines); split further if it doesn't.

| ID | Item | Priority | State |
| --- | --- | --- | --- |
| SEC-1 | Attachment writes cannot escape the project | High | Done (inbox outside project) |
| SEC-2 | Destructive actions ask the owner and fail closed | High | Done (policy version 3) |
| SEC-3 | Slack input and output hardening | High | Done (simulated Slack) |
| SEC-4 | Bridge runs as a dedicated restricted user | High | Done in repo; VPS apply pending |
| SEC-5 | Keep secrets out of agent reach; isolate projects | High | Done in PRs, VPS pending |
| SEC-6 | Per-turn project snapshots | Medium | Research/design |
| SEC-7 | Document architecture and trust boundaries | Medium | Done; keep updated |
| CMD-1 | Support OpenCode commands in Slack | Medium | Implemented |
| ONB-1 | Add projects through Slack | Medium | Implemented; VPS verification pending |
| ONB-2 | Register a project by cloning a GitHub SSH URL | Medium | Implemented; VPS verification pending |
| DEMO-1 | Demo features with headless browser screenshots | Medium | Research/design |

## Current behavior

Any member of the bridge's workspace can talk to OpenCode in a mapped channel; several people can share one thread and its session. Each prompt reaches the agent as `<@user>: text`, and the plugin appends a note to the system prompt that the session may be multiplayer. Registering a channel and approving or rejecting actions stay owner-only. A mention creates a session; replies in a mapped thread continue it without a mention. Prompts already use OpenCode `delivery: "queue"`. Threads share the channel's checkout, and the bridge runs one prompt or server command at a time per project, replying "Queued: N ahead" to waiting messages. Worktrees and automatic idle server shutdown are not implemented.

Policy version 2 allows actions that formerly requested approval. Deployment configuration blocks `git push`; the plugin blocks `sudo` and protected edits. Legacy approval handlers remain. These controls are not a comprehensive security guarantee.

## Security items

Source: a read-only code audit on 2026-09-29. The VPS was not inspected. "Proven" means reproduced locally; everything else is a finding from code/config that the task must confirm.

Threat model: treat the agent as untrusted. It reads project files, web pages and attachments that may contain injected instructions, and it runs almost every command without approval. Each item asks what a misbehaving agent could reach.

### SEC-1: Attachment writes cannot escape the project

**Done:** uploads go to `<state dir>/inbox/<channel name>/<thread_ts>/`, owned by the bridge and mounted read-only at `/inbox` in the container. The bridge no longer writes into the project or `.git/info/exclude`, refuses a symlinked inbox folder, and refuses a `projectDir` that is `/`, holds, or sits inside the state folder. Verified by integration tests (a symlinked old inbox and `.git/info/exclude` stay untouched) and a Docker Desktop check that `/inbox` is read-only; not yet on the VPS.

**Background:** The bridge runs on the VPS host, not in a container. For owner uploads, `store()` in `bridge/src/attachments.ts` writes into `<projectDir>/.slack-tag/inbox/<thread_ts>/` and appends `.slack-tag/` to `<projectDir>/.git/info/exclude`. The agent's container mounts the same project folder read-write, and `deploy/prepare-project.sh` makes the inbox writable by the container user.

**Problem (proven):** the path check is textual (`resolve` + `startsWith`) and never inspects symlinks. The agent can replace the inbox or the thread folder with a symlink; the next upload is written wherever it points. It can also symlink `.git/info/exclude` to any file (for example `slack-tag.sqlite` or `config.json`), and the bridge appends to it. Writes happen as the bridge's host user (root with the committed unit; `devuser`, uid 1000, on the live VPS).

**Scope:** make attachment storage refuse symlinks at every component (or move the inbox to a bridge-owned location mounted read-only into the container). Stop writing `.git/info/exclude`; handle ignore rules during project preparation instead. Validate `projectDir` in `bridge/src/config.ts`: reject paths that are, contain or sit inside the state/config directory or `/`.

**Acceptance:** integration tests through the bridge entrypoint: a symlinked inbox, thread folder or `.git/info/exclude` causes no write outside the project and a visible failure in the thread; normal uploads still work. `npm run check` is sufficient verification.

### SEC-2: Destructive actions ask the owner and fail closed

**Done:** policy version 3, as listed in `SPEC.md`. Requests whose session has no mapped thread or ancestor are rejected at once. Still open: permission requests from subagent sessions are not re-posted after a bridge restart.

**Background:** `plugin/src/policy.ts` decides every OpenCode permission request. Since 2026-09-27 (`SPEC.md`) it returns `allow` for everything except shell commands starting with `sudo` and edits to protected config paths. `deploy/opencode.global.jsonc` allows shell/edit/webfetch and denies `git push *` by text match. The Slack approval flow (approve-once, owner-only, silence rejects) still exists in `bridge/src/turn.ts`.

**Problem:** destructive commands (`rm -rf`, `git reset --hard`, `git clean -fdx`, history rewrites, publishing, database drops) run automatically against the real project folder. Text matching is bypassable (`bash -c 'sudo …'`, `git -C . push`, scripts, `node -e`). The plugin overrides OpenCode's own default asks (for example `.env` reads and `external_directory`). If the plugin throws or fails to load, the base config is allow-all. Permission requests from subagent sessions are dropped by `turn.ts` because their session isn't mapped to a thread.

**Scope:** add an `ask` decision; auto-allow only a known-safe set (read-only commands, edits inside the project outside protected paths) and ask for everything else, including unknown actions. Deny obvious remote-code patterns (`curl … | sh`). Catch errors in the hook and return ask/deny. Change the base config to ask so a missing plugin is not allow-all. Map subagent sessions to their parent thread. Bump the policy version. This is a product decision reversing the 2026-09-27 policy: confirm the allow list with the owner before implementing.

**Acceptance:** integration tests for the approval round trip; the real OpenCode 2.0.15 spike (`spike/v2`) must show a destructive command has no side effect before approval and none after rejection or timeout. Report which checks ran against real OpenCode.

### SEC-3: Slack input and output hardening

**Done:** the bridge reads its workspace from `auth.test` and ignores events and clicks from other workspaces; sends the bot token only to `https://files.slack.com` and refuses redirects elsewhere; ignores malformed button values and refuses clicks outside the asking thread; posts a generic failure and logs the details; redacts Slack tokens and every channel server password in posts, updates, ephemerals and nested block text; and neutralises `@channel`, `@here` and `@everyone`. Verified with the simulated Slack server only; how a real Slack app renders the neutralised mentions is not verified. The configurable `teamId` from the scope below was replaced by `auth.test`.

**Background:** `bridge/src/main.ts` receives Socket Mode events; `turn.ts` checks only `userId === ownerUserId`. This holds for owner-only use.

**Problem:** no workspace check (`body.team_id ?? ""`); the bot token is sent to whatever `url_private` the event names, following redirects; approval clicks are not checked against the request's channel/thread and `JSON.parse(value)` is unguarded; error text with internal details is posted to Slack; redaction covers Slack tokens only (not the OpenCode key or server password) and skips ephemeral messages and nested block text; agent output can ping `@channel`/`@here`.

**Scope:** add `teamId` to config and reject other workspaces; only download from `https://files.slack.com` without cross-host redirects; validate click payloads and channel/thread; post generic errors and log details; redact configured secret values everywhere the bridge posts; neutralise broadcast mentions in agent output.

**Acceptance:** integration tests through the entrypoint with the simulated Slack server. Mention rendering needs a development Slack app check; say so if not done.

### SEC-4: Bridge runs as a dedicated restricted user

**Done (repo):** `deploy/slack-tag.service` runs as the `slack-tag` system user with systemd sandboxing; `docs/deploy.md` has install and migration steps. Verified in a disposable systemd container, not on the VPS. Applying it needs deployment authorization and must ship with SEC-1.

**Background:** `deploy/slack-tag.service` sets no `User=`, so it runs as root; the live VPS reportedly overrides it to `devuser`, the same uid (1000) as the container user. `docs/deploy.md` creates `/var/lib/slack-tag` world-readable.

**Problem:** any bridge bug (such as SEC-1) acts with root or with the same identity the agent has on disk. Database and config are readable by every host user.

**Scope:** dedicated system user (not uid 1000), systemd hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths` for the state and inbox directories, `PrivateTmp`, `UMask=0077`), state directory `0700` and files `0600`. Update `docs/deploy.md` with migration steps.

**Acceptance:** repo changes plus documented migration. Applying to the VPS requires explicit deployment authorization and is a separate step.

### SEC-5: Keep secrets out of agent reach; isolate projects

**Done (PR #6):** the Go key lives only in the `key-proxy` container; each project has its own server password and Compose network, and the bridge refuses a reused password. Verified with real containers on Docker Desktop, not on the VPS.

**Done (SEC-5 PR), decided 2026-10-02:** agent shells run as `agent` (uid 1001) through `agent-shell`, so they cannot read the server's environment, memory or `/data`, and cannot approve their own permission requests. Project containers run under gVisor by default. `deploy/firewall.sh` blocks the metadata address and the host for project networks; other internet access stays open by decision (no allowlist). Verified on Docker Desktop under runc and under gVisor in Docker-in-Docker, not on the VPS. CPU/disk limits remain open.

**Background:** project containers previously got `OPENCODE_API_KEY` and a shared `OPENCODE_SERVER_PASSWORD` from one env file. The plugin strips them only from agent shell environments. Containers share the default Compose network and have unrestricted egress. Runtime defaults to `runc` unless `SLACK_TAG_RUNTIME=runsc`.

**Problem:** the agent runs as the same uid as the server and can read both secrets from `/proc/1/environ`, then exfiltrate them. With the shared password, one project's agent can drive another project's server. Containers can likely reach the cloud metadata address and host services. `docs/findings.md` already records the `/proc` path as open.

**Scope (design first):** choose between a credential-injecting egress proxy, separate uids for server and agent shells, or a scoped rotating key. Per-project password and network, egress allowlist (model provider, package registries), metadata/host-gateway block, gVisor by default, CPU/disk limits. Produce a design note and split implementation items.

**Acceptance:** VPS/container checks that the agent cannot read the key, reach another project's server or the metadata endpoint. Requires deployment authorization.

### SEC-6: Per-turn project snapshots

**Background:** the project folder is a host bind mount with no backups. Only `.git/config`, `.git/hooks` and OpenCode config are read-only.

**Problem:** even with SEC-2, anything that slips through (or is approved by mistake) can destroy project files and Git history permanently.

**Scope (design first):** host-side snapshot owned by the bridge before each turn (for example a `git bundle` plus working-tree archive, or filesystem snapshots), retention limit, and a restore procedure. Measure disk cost.

### SEC-7: Document architecture and trust boundaries

Write a current architecture and trust-boundary document (bridge, containers, plugin, secrets, what each component can reach), distinguishing verified enforcement from intent. Update it as SEC items land. `architecture.md` is historical and should not be edited in place.

Written as [`docs/trust-boundaries.md`](trust-boundaries.md). Each SEC item that lands must update its rows there.

## Feature items

- **CMD-1 Commands:** a mention whose text starts with `/init`, `/review`, `/model`, `/stop` or `/compact` is a command; any other leading `/` stays a prompt. `/init` and `/review` run OpenCode server commands in the thread's session. `/model` lists enabled models from the channel model's provider and switches only the thread's session; attachments are checked against the session's current model. `/stop` interrupts and `/compact` requests compaction. Verified with integration tests and against real OpenCode 2.0.15 with a scripted model; not yet checked in a development Slack workspace (Slack may reject thread replies starting with `/`, so commands are written after the mention).
- **ONB-1 Onboarding:** `@OpenCode register` in an unmapped channel connects a folder from `onboarding.projectsRoot`, with its own container, key proxy, network, volume and server password. See `docs/project-mapping.md`. Not yet verified on the VPS. Unregistering is not covered.
- **ONB-2 Clone on register:** `@OpenCode register git@github.com:<owner>/<repo>.git` clones the repository into `projectsRoot/<repo>` with the operator's SSH key, then registers it like ONB-1. The clone runs in `deploy/start-project.sh` as uid 1000; the bridge and the agent never see the key, and `git push` stays blocked. Verified with integration tests (real `git`, stand-in SSH); not yet against real GitHub on the VPS. Pushing from Slack is a possible follow-up.
- **DEMO-1 Screenshot demos:** let the agent show that a feature works by driving a headless browser and posting screenshots or short recordings to the Slack thread, and later to the PR. See the proposal below.

## DEMO-1 Screenshot demos: proposal, not a final design

**Goal:** after a change, the agent opens the running app in a headless Chromium, walks through the feature, and the owner sees the screenshots in the thread without opening a terminal.

- **Browser:** a headless Chromium sidecar container per project on the project's own network, following the per-project key-proxy pattern, so the OpenCode image stays small and the browser is separate from the project files. The alternative is Playwright plus Chromium inside the OpenCode image: simpler, but it adds about 400 MB, and Chromium needs `--no-sandbox` and more shared memory in a read-only container.
- **Agent tools:** Playwright MCP (`@playwright/mcp`) configured in OpenCode and connected to the sidecar over CDP, giving the agent navigate, click, type and screenshot tools.
- **Output:** the agent writes images to `.slack-tag/outbox/<thread>/`. The bridge, which already holds the Slack token, uploads new files to the thread. The agent receives no Slack or GitHub token; `git push` stays blocked.
- **PRs (later):** a token-holding component outside the agent (the bridge or a proxy) attaches images to the PR, for example by committing them to a `pr-assets` branch and linking them in the description, using a token scoped to the repo.

Open questions:

- The app under test must be reachable from the sidecar: a dev server started inside the project container, or a public URL. SEC-5 egress limits would need an allowlist for it.
- Resource cost: Chromium memory per project, and whether the sidecar runs only on demand.
- The browser can reach whatever the project network can; it must not open pages that can reach the host or the bridge.
- Record GIFs or short videos as well as stills.

Acceptance: in a registered project, asking the agent to demo a page posts at least one screenshot of the running app in the thread, the agent's container never receives the Slack or GitHub token, and the sidecar cannot reach another project's containers.
