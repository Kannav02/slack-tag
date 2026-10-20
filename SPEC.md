# Slack Bridge: V1

Status: owner-only V1 is deployed. Current feature scope is in `docs/backlog.md`; Cloud development instructions are in `docs/cloud-development.md`.
Tracking: the Slack Tag Notion page and the repository backlog.

This document includes original requirements, not a claim that every feature shipped. Automatic idle shutdown/cold starts remain unimplemented; the build plan is historical.

Current permission policy (2026-10-02, policy version 3, replacing the 2026-09-27 allow-all policy):

- Runs without asking: reads and searches (except `.env` files), edits inside the project outside protected paths, and shell commands (including newline batches, background jobs and OpenCode command resources when every command is safe) from a named list: `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `echo`, `grep`, `cut`, `tr`, `sort` (without `-o`/`--output`/`--compress-program`), `uniq` (without an output file), `rg`, `find` (without `-delete`/`-exec`), `git status|log|diff|show|branch|add|commit`, read-only `git rev-parse|rev-list|ls-files|show-ref|blame|shortlog|describe|merge-base`, remote listing, `ls-remote`, `fetch`, `pull` (plain or `--ff-only`), and ordinary `push` to configured remotes (without destructive flags, executable overrides or history rewriting), `npm|pnpm|yarn test|run|install|ci`, `pytest`, `make`, `tsc`, `node --test`, `sleep`, and `curl` over HTTP(S) to `localhost`, `127.0.0.1` or `[::1]` (any port or path) with only `-s`, `-S`, `-f`, `-i`, `-I`, `-v`, `-k` or their long names. Redirections that only merge or discard output (`2>&1`, `>&2`, `2>/dev/null`, `>/dev/null`) and `$?` do not make a command ask; any other redirection or expansion, or whitespace other than spaces, tabs and newlines, does.
- Agent shells get `pull.ff=only` through `GIT_CONFIG_*`, appended after any existing entries such as the Git proxy rewrites. A plain `git pull` therefore only fast-forwards, even when the repository sets `pull.rebase`; `--rebase`, `--no-ff` and other reconciling flags still ask, and an approved one overrides the default.
- Screenshots also run without asking: the image's `playwright screenshot` of an `http(s)` URL on `localhost`, `127.0.0.1` or `[::1]` into a `.png` under `/tmp` or the project, with only page-size and wait flags (see `docs/trust-boundaries.md`).
- Document conversions also run without asking: `pandoc` of files under `/inbox`, `/tmp` or the project, with only `-s`/`--standalone`, `--wrap=auto|none|preserve`, `-f`/`--from` and `-t`/`--to` (built-in formats except `pdf`) and at most one `-o`/`--output` that is not a PDF, under `/tmp` or the project and outside protected paths; and `pdftotext` of one such `.pdf` with only `-layout`, `-nopgbrk`, `-f N` and `-l N`, writing to stdout (`-`), `/tmp` or the project. Paths with `..`, dot folders or `:` (URLs), other options such as `--filter`, `--lua-filter` or `--defaults`, and `pandoc lua`/`pandoc server` ask.
- Always refused, no prompt: force pushes (`--force*`, `-f`, `+refspec`, `--mirror`), `sudo`/`su`/`doas`, download-and-run (`curl … | sh`), edits to protected OpenCode/Git configuration, built-in reads or searches under the server's `/proc` and `/data`, and shell commands that move, copy, delete or redirect into a `.git` path (Git's own subcommands are unaffected).
- Force-push blocking inspects command text. Existing remote mirror or forced push-refspec configuration can make an ordinary push force updates; enforce GitHub branch rules for server-side protection.
- Everything else asks the owner in Slack, including unparsed shell chains/pipelines, other `curl` hosts or flags, destructive Git operations, web fetch/search and unknown actions. No answer within the timeout, a plugin error, or a missing plugin never allows.

## Problem Statement

Direction since 2026-10-20 ([positioning](docs/positioning.md)): the owner makes things with people who are not technical, such as a parent writing a book, a professor on a research project or a sibling building a game. Chat assistants such as ChatGPT and Claude give each person a private conversation, so collaborators copy files and answers back and forth, and each needs an account. Coding agents such as Claude Code, Codex and Capy are built for programmers and software teams. The owner wants one shared agent per project that everyone can talk to in a chat app, working on the project's real files, while the owner hosts it, pays one flat bill and decides what it may do.

The original problem still holds for the owner's own projects: the owner already uses coding agents and pays for inference subscriptions, but wants to work with those agents from Slack instead of switching to a terminal. Existing hosted assistants introduce another product and bill; a custom bridge should connect Slack to the existing agent without becoming a new agent or knowledge platform.

## Solution

A self-hosted bridge run by one owner, the host. Guests in the host's Slack workspace talk to it; only the host and named approvers allow risky actions. A configured Slack channel selects a project folder and an isolated agent environment. Each thread starts a separate agent session; subsequent messages resume that session. The agent can use project files and instructions, with no memory imported from other threads.

OpenCode is the first supported backend. A small common agent interface and backend-specific adapters separate Slack behavior from each agent's protocol. Messages and attachments go to the agent, streamed responses return to the same thread, and permission requests become approval prompts for the owner and the channel's named approvers.

## User Stories

1. As the owner, I want to talk to an agent in Slack, so that Slack is my main interface for coding and knowledge work.
2. As the owner, I want a channel linked to a project folder, so that work happens in the intended project.
3. As the owner, I want each new thread to create a new agent session, so that conversations remain separate.
4. As the owner, I want replies in a thread to continue its session, so that I can build on that conversation.
5. As the owner, I want the agent to access the project's files and instructions, so that it can work with the existing project context.
6. As the owner, I want new sessions to exclude other threads' chat history, so that context stays limited to the current conversation and shared project files.
7. As the owner, I want thread-session associations and agent history to survive restarts, so that I can resume a conversation later.
8. As the owner, I want responses to appear progressively in the originating thread, so that I can follow the agent's answer.
9. As the owner, I want uploaded files and supported images passed as agent inputs, so that I can discuss material directly from Slack.
10. As the owner, I want unsupported attachments to produce a clear explanation, so that inputs are not silently ignored.
11. As the owner, I want routine permitted actions to proceed automatically, so that I do not have to approve every step.
12. As the owner, I want restricted or destructive actions to wait for my approval, so that I control consequential operations.
13. As the owner, I want approval to authorize only the pending action, so that one approval does not grant broad future permission.
14. As the owner, I want rejected or unanswered requests to remain unexecuted, so that silence never grants permission.
15. As the owner, I want my workspace teammates to talk to the agent in mapped channels while only I and the channel's named approvers approve actions, and only I register channels, so that we can share a project without giving up control of consequential operations.
16. As the owner, I want project execution isolated from other projects and the host, so that an agent's mistakes have a limited blast radius.
17. As the owner, I want to use OpenCode's supported authentication and available provider access, so that the bridge does not introduce its own inference billing layer.
18. As a maintainer, I want backend-specific behavior behind an adapter, so that adding another compatible agent does not require rewriting the Slack integration.
19. As the owner, I want visible failures when the agent cannot complete a request, so that a failed run is not mistaken for success.
20. As the owner, I want idle project servers to stop automatically, so that inactive projects do not retain running agent processes and their memory usage.
21. As the owner, I want a new message to restart a stopped project server and resume the same session, so that resource savings do not discard conversation context.
22. As the owner, I want each Slack thread to work in its own Git worktree and branch, so that people and tasks sharing a channel neither wait for nor overwrite each other.
23. As the owner, I want every task that changes files to end in a pull request, so that each piece of work is isolated and reviewable.
24. As the owner, I want the agent to post evidence such as logs, command output and screenshots to the thread, so that I can check that something works without opening a terminal.
25. As the owner, I want routine local commands that reproduce and check a problem to run without approval, so that approvals are reserved for consequential actions.
26. As a guest, I want short, plain replies that lead with the result, so that I can follow the work without reading through every step.
27. As a guest, I want to upload and receive Word and PDF files, so that I can work on documents I already have.
28. As the owner, I want approval requests to reach me directly, so that a guest's work does not stall while I am elsewhere.
29. As the owner, I want to create a new project from Slack, so that I can set up a guest's project without logging in to the server.
30. As people sharing a thread, we want only messages addressed to the agent to reach it, so that we can talk among ourselves.
31. As a guest, I want the bot to tell me how to use it, which models it offers, its commands and how it proves its work, so that I can start without asking the owner.

## Implementation Decisions

### Scope and responsibilities

- The bridge transports messages, routes sessions, persists associations, handles attachments, and relays permission decisions. It does not implement its own agent reasoning or tool catalog.
- Any member of the bridge's workspace can send messages in a mapped channel. One configured Slack owner identity registers channels; the owner and each channel's optional `approvers` decide its approval actions. Finer multi-user roles are excluded.
- Channel-to-folder mappings are operator configuration, not agent-controlled paths or a provisioning UI.
- A channel selects one project environment. Threads within it use separate sessions, not separate copies of the project files.
- The bridge runs one prompt at a time per project, in arrival order across all its threads, so sessions never edit the shared files concurrently. A message that has to wait gets a "Queued" reply. The queue is in memory; messages still waiting when the bridge restarts are dropped.
- Execution is isolated per configured project/channel, not merely separated by process. Enforcement must constrain mounted files, host privileges, credentials, and resource access. Exact runtime configuration remains an implementation decision.

### Sessions and context

- Routing identifies the Slack workspace, channel, and thread and associates them with the backend session and project.
- Persist both routing associations and the agent's session data. Persisting only a session identifier is insufficient if backend history is lost.
- Restart recovery means the conversation can resume. It does not promise that an in-flight command continues or is automatically replayed.
- Each new session starts in its configured project folder and uses project instructions supported by the backend. Folder access does not mean every file is eagerly loaded into the model context. In a per-thread worktree the backend's project config, and with it its automatic `AGENTS.md` loading, is disabled for isolation, so the safety plugin reads `AGENTS.md` and supplies it instead.
- No automatic ingestion of channel history, other thread histories, or cross-project knowledge. Files written by another session remain visible because the project folder is shared.

### Project server lifecycle

- Keep one agent server per active project environment, serving that project's thread sessions. A saved thread does not require a permanently running process of its own.
- The bridge remains available to receive Slack messages while project servers are stopped.
- After a configurable idle period, gracefully stop the project server and its managed execution environment, preserving project files, attachments, backend session data, and bridge mappings. The idle duration is not yet selected.
- Stopping means releasing the environment's running processes and their memory, not freezing a process that still holds RAM. Persistent storage and the bridge still consume resources.
- Stop only when every session in the project is inactive, with no running tools or commands, pending inputs, or outstanding approval requests. Leaving a Slack thread or closing Slack does not itself stop work or establish idleness. If activity cannot be established safely, do not stop automatically.
- On an authorized message to a stopped project, start its environment, wait for backend readiness, then deliver the input to the mapped session. A new thread creates a new session instead. Cold-start latency is an accepted V1 tradeoff.
- Coordinate startup and shutdown with incoming messages so a transition does not lose or duplicate input or start duplicate project servers. This lifecycle coordination is required even though concurrent-edit coordination is out of scope.
- A failed startup produces a visible failure, not a silent replacement session or a false success. Recovery restores conversation context; it does not resume or replay interrupted commands.

### Agent interface

- The common interface covers session creation/resumption, sending messages and attachments, receiving response/completion/error events, and receiving/replying to permission requests.
- These are agent operations, not individual tools such as shell or file editing.
- Implement only the OpenCode adapter in V1. Future adapters translate their backend's RPC or equivalent structured protocol into this interface.
- Streaming support alone does not establish compatibility. Sessions, attachments, authentication, and permission behavior must be verified separately. Unsupported capabilities must be explicit rather than silently bypassed.
- The bridge uses the backend's supported login/provider configuration. It does not promise that every subscription can be reused with every agent.
- V1 targets OpenCode v2 through `@opencode/client`, pinned with the server to 2.0.15. Required capabilities were verified in `spike/v2`; see `docs/findings.md`.
- Inference uses the owner's OpenCode Go subscription via OpenCode's `opencode-go` provider. Anthropic subscriptions are not used.
- The Slack bot is addressed as `@OpenCode` and runs on the owner's VPS.
- The bridge is Node.js and TypeScript, stores its state in SQLite, and connects to Slack with Socket Mode. The design and the slices are in `docs/plan.md`.

### Permissions and isolation

- Routine permitted work proceeds without intervention. Restricted actions pause for an approve-once or reject decision in Slack from the configured owner or one of the channel's approvers.
- The execution layer must withhold the action until a valid approval arrives. A Slack prompt or model instruction by itself is not enforcement.
- No response, failed delivery, or an unauthorized click must grant permission. Decisions must be bound to the correct pending request and session.
- Approval does not expand container mounts, host privileges, or other hard isolation boundaries.
- The concrete allow/ask/deny policy must be defined and verified during implementation. "Dangerous" is a product intent, not a complete executable policy, and command-name matching alone is not a security guarantee.
- Slack credentials belong to the bridge and must not be exposed to the project agent. Backend credentials receive only the access necessary for supported authentication.
- A small OpenCode server plugin, loaded from the global config, applies the allow/ask/deny policy and removes secrets from agent shell environments. The agent must not be able to add or change plugins or project config.
- The OpenCode Go key stays in a separate `key-proxy` container. Project containers send model requests there with a placeholder credential, so an agent cannot read the key from its own container. There is still no general egress restriction; the server password remains in project containers.

### Slack inputs and outputs

- Text and supported attachments are delivered to the correct session. Attachments use project-scoped storage and must not overwrite arbitrary project or host paths.
- Supported attachment types depend on the selected backend/model. Unsupported inputs receive a clear user-visible response.
- Word (`.docx`), ODT, EPUB and PDF uploads are accepted with any model: they are stored like other uploads but not sent as model input, and the prompt names their path in the inbox (`/inbox` in the container) for the agent to read with `pandoc` or `pdftotext`.
- Agent text responses stream back to the originating thread. The agent can post a file it can read (images, logs and other text, up to 10 MB) to the thread with the safety plugin's `slack_attach` tool; see `docs/trust-boundaries.md`.
- Basic failure reporting is part of the bridge; a separate run-control interface is not.

## Testing Decisions

Run `npm run check` for dependency checks, application typechecking and integration tests through the real bridge entrypoint with simulated external APIs and real SQLite. Keep tests feature-oriented and mock only external boundaries. Real Slack rendering, OpenCode execution and container isolation still require the corresponding runtime checks described in `docs/cloud-development.md`.

Manual checks go through the public flow: messages, uploads, and button clicks in Slack, against the real pinned OpenCode server. Where enforcement depends on the agent or sandbox, run the check against the real OpenCode 2.0.15 runtime and the actual container, with disposable projects. A Slack prompt or the model's own report cannot prove that an action was blocked. Check the side effect directly, such as a file, a command's output, or a database row.

The spike scripts in `spike/v2` may be used as manual tools, for example to drive a server with the fake model or to dump events. They are not a test suite to maintain.

The manual checks must demonstrate these behaviours:

| Feature | Behavioral acceptance |
| --- | --- |
| Access | Messages from any workspace member in a mapped channel work; approval clicks from anyone but the owner or that channel's approvers, and registration choices from anyone but the owner, cannot trigger execution. |
| Channel routing | A request uses the configured project's files and instructions; an unmapped channel cannot launch arbitrary project work. |
| Thread sessions | Replies retain the current thread's conversation; another thread begins a separate session without the first thread's chat history. |
| Persistence | After restarting the bridge and backend with retained storage, a thread resumes its existing conversation rather than starting over. |
| Idle shutdown | After the configured idle period, an inactive project's managed processes stop while project files and conversation data remain. Active work, pending input, and pending approvals prevent shutdown. |
| Cold-start recovery | A message to a stopped project starts one environment and continues the mapped conversation with prior context; a new thread creates a separate session. Inputs arriving during lifecycle transitions are not lost or duplicated, and startup failures are reported visibly. |
| Streaming | Agent output appears progressively in the originating thread and concludes with the correct final response or visible failure. |
| Attachments | Supported files/images arrive as usable inputs in the correct session; unsupported inputs fail clearly and cannot escape project-scoped storage. |
| Automatic actions | A representative routine permitted action completes without an approval prompt. |
| Restricted actions | A representative restricted action has no side effect before approval; approve-once permits it; rejection or no response leaves it unexecuted. |
| Project isolation | An agent can operate on permitted project data but cannot read an unmounted sibling project, host secrets, or use prohibited host privileges. |
| OpenCode adapter | The public bridge flow works against the selected OpenCode version for messages, session continuation, and permission decisions. |

Keep checks feature-oriented. Combine related acceptance scenarios in one checklist where useful.

## Out of Scope

- Roles beyond the owner and per-channel approvers, team administration, and hosted multi-tenant operation.
- Cross-thread memory, automatic channel-history ingestion, shared wikis, and cross-project knowledge retrieval.
- Additional agent adapters beyond OpenCode.
- A web dashboard, scheduled jobs, or a new agent/tool execution engine.
- User-facing stop/status controls and advanced run management beyond the automatic idle shutdown and on-demand startup described above.
- Merging the agent's pull requests automatically, and parallel runs within one thread.
- Comprehensive support for every attachment format or every provider subscription.

## Further Notes

- Project onboarding is currently manual: an operator prepares the folder, adds a Compose service and channel configuration, and restarts services. A future guided setup should connect a project without hand-editing Compose or JSON, preserve existing data, and verify server readiness. This is not implemented; see [project mapping and onboarding](docs/project-mapping.md).

- This document follows the to-spec structure, with local documentation replacing external issue publication at the owner's request.
- Requirements are sufficient to start a minimal prototype. Remaining technical choices should be resolved through focused compatibility checks, not another product interview.
- `spike/v2` is a compatibility spike; the bridge implementation is in `bridge/`.
- Passing manual checks establish the checked contract, not proof against every destructive command or sandbox escape.
