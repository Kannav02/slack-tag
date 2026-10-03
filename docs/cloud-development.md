# Develop Slack Tag in Codex Cloud

## Create the environment

Select `Kannav02/slack-tag` in a new Codex Cloud environment. Use Node.js 24 (see `.node-version`) and npm. Allow setup to reach the npm registry. Normal checks need no external network after installation, credentials, Docker or VPS access; localhost HTTP/WebSocket connections must work.

From the repository root:

```sh
bash scripts/setup-cloud.sh
npm run check
```

Record these commands in environment setup, review the results, and publish only after they pass. Repeat setup when dependency locks change. Each feature task should read `AGENTS.md`, `SPEC.md` and `docs/backlog.md`, implement one focused item, and report checks and remaining verification. Preparing this repo does not itself create or publish a Cloud environment.

[Official setup documentation](https://learn.chatgpt.com/docs/environments/cloud-environments) covers repository selection, installation, networking and publishing. Legacy Cloud environments have a different settings interface; use the same install/check commands there.

## Claude Code cloud sessions

`.claude/hooks/session-start.sh` runs on every Claude Code cloud session start: it installs Node from `.node-version` with nvm (the image ships Node 22), puts it on the session `PATH`, installs the root, `bridge/` and `plugin/` packages, and runs `npm run check:dependencies`. It does nothing outside cloud sessions. The environment's network policy must allow the npm registry and nodejs.org.

## Verification levels

| Check | What it establishes | Requirements |
| --- | --- | --- |
| `npm run check` | Actual bridge against simulated APIs, real SQLite, application typechecking | Node/npm; localhost sockets |
| `cd spike/v2 && npm ci && npm run spike` | Real pinned OpenCode with a scripted model, session/queue behavior | CLI download, Git, curl, bash; free ports from spike config |
| `demo/run.sh` | Interactive fake Slack against real OpenCode/live model | Development inference key; see `demo/README.md` |
| Development Slack app | Real authentication, Socket Mode and visual rendering | Separate dev app, channel and credentials |
| VPS deployment checks | Docker mounts, systemd, persistence and isolation | Explicit deployment authorization and VPS access |

The spike uses historical permission fixtures, not the complete production policy. Passing simulated-service tests does not prove real Slack rendering; a plain Node run does not prove Docker/gVisor isolation. CI runs the credential-free suite only.

## Live development configuration

Supply `SLACK_TAG_CONFIG`, each channel's server password (under its `passwordEnv` name), `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` through the environment, then run `npm --prefix bridge start`. Base config on `config/example.json`; use disposable project directories and a development OpenCode server. Provider credentials belong to that server, not committed config.

Use a separate Slack app for every concurrently connected test deployment. Never reuse the production app token: Slack distributes events across Socket Mode connections. The fake Slack demo needs no workspace Slack tokens.

## Notion access

The [Slack Tag page](https://www.notion.so/3e91697f7f2281d988abf6e8d9ed6b78) is optional planning context. Repo docs carry the baseline so feature work is not blocked on Notion.

In a Cloud task, check whether the connected Notion plugin is available and can read that page. Availability depends on the task surface, workspace settings and Notion authorization. A local plugin installation or Mac keychain login does not prove cloud access. Connect it there if supported, then verify by reading the project page.

For CLI/API access, install the `ntn` CLI in the environment and configure a scoped Notion credential through Cloud's credential settings, allowing `api.notion.com`. Prefer the CLI over browser automation. Do not copy Mac auth files into the repo. Notion permissions must include the project page/database; read access does not imply write access. Never print tokens. Credential setup is separate from repo preparation.

See [plugins documentation](https://learn.chatgpt.com/docs/plugins) and [Cloud credential settings](https://learn.chatgpt.com/docs/environments/cloud-environments). If Notion tools are unavailable, use the repo backlog or paste an authorized item's scope into the task prompt.

## Feature handoff prompt

> Work on the named item in docs/backlog.md. Read AGENTS.md and SPEC.md first. Confirm existing behavior before editing. Keep OpenCode 2.0.15 pinned. Use integration tests through the public entrypoint and run npm run check. Report any live Slack, real OpenCode or container checks still needed. Do not deploy to production as part of this task.
