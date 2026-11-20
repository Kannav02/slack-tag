# AGENTS.md

## Commands

- Node.js 24 + npm. Clean setup: `bash scripts/setup-cloud.sh`.
- Required checks: `npm run check`. One feature test: `node --test tests/bridge.integration.test.ts`.
- Bridge entrypoint: `npm --prefix bridge start` with development variables from `docs/cloud-development.md`.
- Lint: `npm run lint` (Oxlint with type-aware rules, `.oxlintrc.json`); keep `npm run typecheck` separate. Format: `npm run format` (Oxfmt, `.oxfmtrc.json`; source files only); `npm run check` runs `format:check`.
- Do not use historical Bun scaffold commands.

## Boundaries

### Always Do

- Use `SPEC.md` and `docs/backlog.md` for requirements; distinguish proposals from verified behavior.
- Keep OpenCode server/client/plugin at 2.2.7 together unless an upgrade is the task. Bridge dependencies resolve from `bridge/`, not the root.
- Test through public entrypoints; mock only external services. Use disposable projects/SQLite and verify outputs.
- Distinguish simulated-service tests, real OpenCode checks, and real Slack verification.

### Ask First

- Get explicit task authorization before production deployment or live Slack/Notion configuration changes. Feature implementation alone does not authorize those operations.

### Never Do

- Never use production Slack tokens in development: competing Socket Mode connections steal live events.
- Never commit credentials, `.env` files, databases, attachments, or local Notion login state.
- Never treat old `docs/plan.md` slice prompts or Bun design documents as current setup instructions.

## VPS Deployment Order

Only after explicit authorization (see Ask First). Commands and migrations are in `docs/deploy.md` (Install and Update); follow this order, because each step depends on the one before:

1. Install gVisor (`runsc install`, restart Docker), or set `SLACK_TAG_RUNTIME=runc` where it cannot run.
2. Stop `slack-tag`. Create `proxy.env` (Go key) and one env file per project; add each channel's `passwordEnv` to `config.json` and its password to `bridge.env`.
3. Create the `slack-tag` user and fix state/inbox ownership, and create `/var/lib/slack-tag/inbox/<channel name>`. The bridge user (SEC-4) never ships without the separate inbox (SEC-1): the hardened unit cannot reach project folders.
4. Rerun `deploy/prepare-project.sh` on every project (agent shells need group write).
5. `docker compose down`, then `up -d --build`: the containers and the bridge must move together (the bridge only accepts plugin policy version 3, and networks get fixed subnets).
6. Install both units; start `slack-tag-firewall` before `slack-tag`.
7. Verify: `journalctl -u slack-tag` shows every channel ready, then a real Slack mention, reply, approval and upload. Record results in `docs/findings.md`.

## Code Structure

- `architecture.md`, `opencode-interface.md`, and original `docs/plan.md` prompts are historical. Current deployment mapping is in `docs/project-mapping.md`.
- The bridge imports the plugin RPC definition directly; install both packages before checking or starting it.
- OpenCode's catalog can override provider-level `settings.baseURL` with a model-specific URL. Keep deployed models explicitly routed through `key-proxy` in `deploy/opencode.global.jsonc`; verify proxy traffic after catalog/image refreshes.

## Coding Style

- Keep imports at the top and preserve the existing TypeScript style. Prefer functions unless shared state/lifecycle justifies a class.
- Integration tests only unless explicitly requested otherwise; assert observable results, not internal mock calls.

## Git Rules

- Commit each authorized logical change with a conventional prefix; stage relevant files only. No co-author trailers.
- Keep PRs focused, target under 300 changed lines; split larger features before implementation. Use the task's relevant base branch.
