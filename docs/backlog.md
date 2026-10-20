# Feature backlog and decisions

Planning snapshot: 2026-09-29. [Notion project](https://www.notion.so/3e91697f7f2281d988abf6e8d9ed6b78) holds the original items and a short audit summary. This file is the source of truth for Cloud tasks; it is not synced with Notion.

Start a task with the handoff prompt in `docs/cloud-development.md`, naming one item ID below. Each item should fit one focused PR (under ~300 changed lines); split further if it doesn't.

| ID | Item | Priority | State |
| --- | --- | --- | --- |
| SEC-1 | Attachment writes cannot escape the project | High | Done (inbox outside project) |
| SEC-2 | Destructive actions ask the owner and fail closed | High | Done (policy version 3) |
| SEC-3 | Slack input and output hardening | High | Done (simulated Slack) |
| SEC-4 | Bridge runs as a dedicated restricted user | High | Done; on the VPS since 2026-10-03 (see findings) |
| SEC-5 | Keep secrets out of agent reach; isolate projects | High | Done; on the VPS since 2026-10-03; CPU/disk limits moved to SEC-8 |
| SEC-6 | Per-turn project snapshots | Medium | Research/design |
| SEC-7 | Document architecture and trust boundaries | Medium | Done; keep updated |
| CMD-1 | Support OpenCode commands in Slack | Medium | Implemented |
| CMD-2 | Reduce unnecessary approvals for routine Git command batches and safe local work | High | Merged ([#38](https://github.com/Kannav02/slack-tag/pull/38), [#54](https://github.com/Kannav02/slack-tag/pull/54)); [#37](https://github.com/Kannav02/slack-tag/issues/37) open until its hidden batch is confirmed |
| ONB-1 | Add projects through Slack | Medium | Done; live in Slack since 2026-10-04 |
| DEMO-1 | Demo features with headless browser screenshots | Medium | Screenshots merged ([#49](https://github.com/Kannav02/slack-tag/pull/49)); recordings and PR images paused |
| UX-1 | Show run progress in Slack threads | Medium | Done; live 2026-10-14; animation merged ([#61](https://github.com/Kannav02/slack-tag/pull/61)) |
| PAR-1 | Each Slack thread works in its own Git worktree and branch | High | Merged, opt-in per channel ([#53](https://github.com/Kannav02/slack-tag/pull/53)) |
| TEAM-1 | Per-channel approvers | High | Merged ([#47](https://github.com/Kannav02/slack-tag/pull/47)) |
| OUT-1 | The agent sends files to its Slack thread | High | Merged ([#50](https://github.com/Kannav02/slack-tag/pull/50)) |
| GIT-1 | Open a pull request at the end of every task | High | Merged ([#48](https://github.com/Kannav02/slack-tag/pull/48)) |
| CMD-3 | `/fix`: reproduce, fix and prove with evidence | Medium | Merged ([#55](https://github.com/Kannav02/slack-tag/pull/55)) |
| GUEST-1 | Plain, concise replies | High | Approved; wave 1 |
| GUEST-3 | Only messages that start with the bot mention reach the agent | High | Approved; wave 1; [#27](https://github.com/Kannav02/slack-tag/issues/27) |
| DOC-1 | Word and PDF files in | High | Implemented; not deployed |
| DOC-2 | Word and PDF files out | High | Approved; wave 1 |
| GUEST-4 | Stop button on the progress card | Medium | Approved; wave 2 |
| GUEST-5 | Welcome message and `help`: models, commands and proof | Medium | Approved; wave 2 |
| ONB-2 | Create a new project from Slack | High | Proposed; wave 2; [#26](https://github.com/Kannav02/slack-tag/issues/26) |
| GUEST-2 | Approvals guests understand, and that reach the host | Medium | Later (owner, 2026-10-20) |
| HOST-1 | Slack app manifest | High | Owner reviewing [hosting](hosting.md) |
| HOST-2 | One-command install | High | Owner reviewing [hosting](hosting.md) |
| HOST-3 | `doctor` check for a running install | Medium | Owner reviewing [hosting](hosting.md) |
| LIFE-1 | Stop idle projects and start them on the next message | Medium | Owner reviewing [hosting](hosting.md) |
| SEC-8 | CPU limits and disk warnings per project | Medium | Owner reviewing [hosting](hosting.md) |
| MODEL-1 | Model providers besides OpenCode Go | Low | Owner reviewing [hosting](hosting.md) |
| CHAT-1 | Discord, if guests will not use Slack | Low | Later; owner decision |

## Hosts and guests direction (2026-10-20)

Slack Tag is for a technical host who runs it for people who are not technical: family, a professor, friends. Guests just chat; the host approves risky steps and pays one bill. [Positioning](positioning.md) explains the audience and the pitch. New work follows this order; the details are under [Host and guest items](#host-and-guest-items).

- Wave 1, in parallel, before the first guests: GUEST-1, GUEST-3, DOC-1, DOC-2.
- Wave 2: GUEST-4, GUEST-5 and ONB-2. GUEST-5's help text describes the features that exist by then.
- Host side: HOST-1 to HOST-3, LIFE-1, SEC-8 and MODEL-1 are written up in [hosting](hosting.md) for the owner's review. Do not start them until approved.
- Later: GUEST-2, and CHAT-1 only if the first guests will not use Slack.

Per-turn snapshots and `undo` are not planned (owner, 2026-10-20); SEC-6 stays a research item. Developer-team features (worktrees, a pull request per task, `/fix`, screenshots, Git approval tuning, [#29](https://github.com/Kannav02/slack-tag/issues/29)) keep working for code projects, but get no new work unless the owner's own use needs it.

Owner decisions needed before the affected item starts: whether GUEST-3's leading-mention rule also applies to a thread with only one person in it, and the product name, which sits close to Anthropic's Claude Tag.

## Daily-driver direction (2026-10-17)

The owner wants Slack Tag to replace terminal agents for daily work shared with teammates. Decisions: every task that changes files ends in a pull request; each Slack thread works in its own Git worktree and branch; named teammates may approve actions per channel; routine local commands for reproducing and checking problems run without approval; and the agent proves its work with files, command logs and screenshots posted to the thread. Each item above has a GitHub issue with scope and acceptance criteria and lands as its own PR. The rows for PAR-1, TEAM-1, OUT-1, GIT-1, CMD-2 and DEMO-1 change state as their PRs merge.

## Current behavior

Any member of the bridge's workspace can talk to OpenCode in a mapped channel; several people can share one thread and its session. Each prompt reaches the agent as `<@user>: text`, and the plugin appends a note to the system prompt that the session may be multiplayer. Only the owner registers channels; the owner and a channel's `approvers` approve or reject its actions. A mention creates a session; replies in a mapped thread continue it without a mention. Prompts already use OpenCode `delivery: "queue"`. Without per-thread worktrees (opt-in per channel), threads share the channel's checkout, and the bridge runs one prompt or server command at a time per project, replying "Queued: N ahead" to waiting messages. Automatic idle server shutdown is not implemented.

Policy version 3 allows safe command batches and routine Git operations, including normal push; force pushes are blocked. Destructive operations ask the owner. The plugin blocks `sudo` and protected edits. These controls are not a comprehensive security guarantee.

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

- **CMD-2 Git approvals:** [Issue #37](https://github.com/Kannav02/slack-tag/issues/37). Plain `git pull` (made fast-forward-only in agent shells), output-merging and `/dev/null` redirections, `$?`, read-only Git inspection commands (`rev-parse`, `ls-files`, `blame` and similar), `git log -- path`, and `cut`/`tr`/`sort`/`uniq` pipeline filters now run without approval; force-push denial and destructive-operation approvals are unchanged. Verified with integration tests and real OpenCode 2.0.15 with a scripted model (see findings); not yet deployed or checked in Slack. The second reported log/diff batch's hidden "Show more" resources were never captured, so whether this covers it is unconfirmed.
- **CMD-1 Commands:** a mention whose text starts with `/init`, `/review`, `/model`, `/stop` or `/compact` is a command; any other leading `/` stays a prompt. `/init` and `/review` run OpenCode server commands in the thread's session. `/model` lists enabled models from the channel model's provider and switches only the thread's session; attachments are checked against the session's current model. `/stop` interrupts and `/compact` requests compaction. Verified with integration tests and against real OpenCode 2.0.15 with a scripted model; not yet checked in a development Slack workspace (Slack may reject thread replies starting with `/`, so commands are written after the mention).
- **ONB-1 Onboarding:** `@OpenCode register` in an unmapped channel connects a folder from `onboarding.projectsRoot`, with its own container, key proxy, network, volume and server password. See `docs/project-mapping.md`. Not yet verified on the VPS. Cloning repositories and unregistering are not covered.
- **UX-1 Run progress:** when an execution starts, the bridge posts a progress card in the thread above the answer, edits it at most once a second as tools run (`◌` running, `✓` done, `✗` failed, `⏸` waiting for approval), and turns it into a summary at the end, or deletes it when no tool ran. The prompt gets 👀 while its run is active, then ✅ or ❌. Cards name only the tool and, for read/edit/write, a path relative to the project; tool input never reaches Slack. Separate text blocks in a reply get a blank line between them. This is a read-only display, not the stop/status controls SPEC.md leaves out. Verified with integration tests that replay an event stream recorded from real OpenCode 2.0.15 (`spike/v2/record.sh`). Needs the `reactions:write` bot scope; not yet checked in a development Slack workspace. Slack's native status line (`assistant.threads.setStatus`) is a follow-up once it is verified in channel threads.
- **DEMO-1 Screenshot demos:** let the agent show that a feature works by driving a headless browser and posting screenshots or short recordings to the Slack thread, and later to the PR. See the proposal below.

## DEMO-1 Screenshot demos: proposal, not a final design

**Goal:** after a change, the agent opens the running app in a headless Chromium, walks through the feature, and the owner sees the screenshots in the thread without opening a terminal.

- **Browser:** a headless Chromium sidecar container per project on the project's own network, following the per-project key-proxy pattern, so the OpenCode image stays small and the browser is separate from the project files. The alternative is Playwright plus Chromium inside the OpenCode image: simpler, but it adds about 400 MB, and Chromium needs `--no-sandbox` and more shared memory in a read-only container.
- **Agent tools:** Playwright MCP (`@playwright/mcp`) configured in OpenCode and connected to the sidecar over CDP, giving the agent navigate, click, type and screenshot tools.
- **Output:** the agent saves screenshots under `/tmp` and posts them with the `slack_attach` tool ([#42](https://github.com/Kannav02/slack-tag/issues/42)): the plugin reads each file as the agent user and the bridge, which holds the Slack token, uploads it to the thread. The agent receives no Slack or GitHub token.
- **PRs (later):** a token-holding component outside the agent (the bridge or a proxy) attaches images to the PR, for example by committing them to a `pr-assets` branch and linking them in the description, using a token scoped to the repo.

Open questions:

- The app under test must be reachable from the sidecar: a dev server started inside the project container, or a public URL. SEC-5 egress limits would need an allowlist for it.
- Resource cost: Chromium memory per project, and whether the sidecar runs only on demand.
- The browser can reach whatever the project network can; it must not open pages that can reach the host or the bridge.
- Record GIFs or short videos as well as stills.

Acceptance: in a registered project, asking the agent to demo a page posts at least one screenshot of the running app in the thread, the agent's container never receives the Slack or GitHub token, and the sidecar cannot reach another project's containers.

## Host and guest items

Items from 2026-10-20, approved by the owner unless marked otherwise; see [the direction](#hosts-and-guests-direction-2026-10-20) for the order. Each should fit one PR under about 300 changed lines; split it if not. Guests may not be technical, so keep wording short and clear; technical terms are fine where they are the precise words.

### GUEST-1: Plain, concise replies

**Problem:** The plugin's system instructions (`plugin/index.ts`) say nothing about how to reply, so length and style depend on the model. In a shared thread, people need the result first and little else. Bridge replies also name OpenCode instead of the bot.

**Scope:** Add one instruction to the plugin's `context` hook for every session: lead with the result or the answer, keep replies short and in plain sentences, and do not narrate each step or paste long output unless asked; post a long log as a file with `slack_attach` instead. Technical terms, commands, paths and code stay where they are the precise words; this is about brevity, not avoiding technical content. When someone asks it to remember a preference for the project, the agent records it in the project's `AGENTS.md` so every thread follows it. Bridge replies call the bot by its Slack name, not "OpenCode". Document that guest projects should leave per-thread worktrees off, because a worktree server reads `AGENTS.md` only at startup.

**Acceptance:** an integration test drives the `context` hook, as `tests/agents.integration.test.ts` does, and finds the instruction; a real OpenCode 2.0.15 run shows it in the system prompt. Whether a real model follows it needs a live Slack check; report it.

### GUEST-2: Approvals guests understand, and that reach the host

Later (owner, 2026-10-20); kept here for when it is picked up.

**Problem:** `ask` in `bridge/src/turn.ts` posts "Approval needed" with the raw action and buttons into the guest's thread. The guest cannot approve and is not told who can, and the host may not be watching, so the run waits until the timeout rejects it.

**Scope:** The card opens with a plain sentence naming who can approve (the owner and the channel's approvers, as mentions), with the action and resources below it for the approver. When a request is first posted, the bridge sends the owner and each approver a direct message linking to the card (`chat.getPermalink`); cards re-posted after a restart do not notify again. Buttons stay in the thread, so click validation is unchanged. A failed direct message is logged and never blocks the card. Add the `im:write` bot scope to `docs/deploy.md`.

**Acceptance:** integration tests with the simulated Slack server: one direct message per approver with the link; approving in the thread still works; a failed direct message still leaves the card; a restart sends no duplicate messages. A live Slack check is still needed.

### GUEST-3: Only messages that start with the bot mention reach the agent

Scope and acceptance as in [#27](https://github.com/Kannav02/slack-tag/issues/27), so people in a shared thread can talk among themselves. This reverses "replies in a mapped thread continue it without a mention"; update every document that says so. Confirm the one-person-thread decision first.

### GUEST-4: Stop button on the progress card

**Problem:** Guests will not type `/stop`.

**Scope:** While a run is active, its progress card shows a Stop button that anyone in the channel may press, since stopping is always safe. It uses the same interrupt as `/stop` (`bridge/src/commands.ts`), bypasses the queue, and disappears when the run ends. As with approval buttons, a click only counts on the card's own message. The native `/stop` slash command in [#28](https://github.com/Kannav02/slack-tag/issues/28) stays separate.

**Acceptance:** integration tests: a click interrupts the run, the card shows it stopped and the queue moves on; a click on a finished run, from another thread or with a forged value changes nothing.

### GUEST-5: Welcome message and `help`: models, commands and proof

**Scope:** When registration succeeds (`bridge/src/onboard.ts`), the bot posts a short introduction in the channel; `help` or `/help` after the mention posts the same text without creating a session or reaching the model. It covers:

- How to ask: mention the bot at the start of a message.
- Models: the channel's current model and up to three recommended ones, each with a short note, from a list the host sets in `config.json` (without a list, the first three that `/model` shows), and how to switch with `/model`.
- Commands, one line each: `/model`, `/stop`, `/compact`, `/init`, `/review`, `/fix` and `help`, built from the bridge's own command list so the help cannot go stale.
- How it proves its work: the progress card while it runs; files, screenshots and logs posted with `slack_attach` (Word and PDF once DOC-2 lands); `/fix`, which reproduces a problem, fixes it and posts the command log the bridge recorded; and a pull request link on projects with the Git proxy.
- Who approves risky steps (the owner and the channel's approvers) and how to stop a run.

Describe only what this project has when the text is posted; the plugin's status RPC can report whether the Git proxy is set up.

**Acceptance:** integration tests through the entrypoint: registration posts the introduction; `help` replies without creating a session; every command the bridge accepts appears in the help; the model lines follow the host's list, or the fallback without one.

### DOC-1: Word and PDF files in

**Problem:** Uploads accept only images, video and plain-text formats (`bridge/src/attachments.ts`), so a `.docx` manuscript or a PDF paper is refused.

**Scope:** Accept `.docx`, `.odt`, `.epub` and `.pdf` up to the existing 20 MB cap. They are stored in the inbox as today, and the prompt tells the agent where they are instead of passing them as model input. Add `pandoc` and `pdftotext` (`poppler-utils`) to `deploy/Dockerfile` and record the image size change. The policy allows `pandoc` without approval only with `-f`/`--from`, `-t`/`--to`, `-o`/`--output`, `-s`/`--standalone` and `--wrap`, reading under `/inbox`, the project or `/tmp` and writing to the project or `/tmp`; `pdftotext` gets the same path rules. Any other flag asks, because options such as `--filter`, `--lua-filter` and `--defaults` run programs or read other files.

**Acceptance:** integration tests: each type is stored and announced, and unsupported types still get a clear refusal; policy tests for allowed and asking forms; `spike/v2/policy.sh` shows the real resources; a conversion runs in the built image.

### DOC-2: Word and PDF files out

**Scope:** `slack_attach` (`plugin/src/attach.ts`) also accepts `.docx`, `.odt` and `.epub` (ZIP signature `504b0304`) and `.pdf` (`%PDF-`), within its 10 MB cap, and its description tells the agent it can send documents. Binary documents cannot be redacted, like images; update the `slack_attach` row in `docs/trust-boundaries.md`.

**Acceptance:** tests show valid documents are accepted, and a text file named `.pdf` or an oversized file is refused.

### ONB-2: Create a new project from Slack

Scope and acceptance as in [#26](https://github.com/Kannav02/slack-tag/issues/26), so the host can set up a guest's project without logging in to the server. Today `register` only connects a folder that already exists in `projectsRoot` (`bridge/src/onboard.ts`), and answers "There are no unregistered folders" otherwise; creating the folder still needs a login to the server.

### HOST-1, HOST-2, HOST-3, LIFE-1, SEC-8 and MODEL-1

The host-side items (Slack app manifest, one-command install, `doctor`, idle shutdown, CPU and disk limits, other model providers) are written up in [hosting](hosting.md) for the owner's review. Do not start them until approved.

### CHAT-1: Discord

Only if the first guests will not use Slack, and after an owner decision, since `SPEC.md` covers Slack only. First separate the Slack transport from the bridge core without changing behaviour, then add a Discord transport with threads, uploads and approval buttons.
