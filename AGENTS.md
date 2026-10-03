# AGENTS.md

## Commands

- Node.js 24 + npm. Clean setup: `bash scripts/setup-cloud.sh`.
- Required checks: `npm run check`. One feature test: `node --test tests/bridge.integration.test.ts`.
- Bridge entrypoint: `npm --prefix bridge start` with development variables from `docs/cloud-development.md`.
- Do not use historical Bun scaffold commands. No formatter/linter is configured; do not claim otherwise.

## Boundaries

### Always Do

- Use `SPEC.md` and `docs/backlog.md` for requirements; distinguish proposals from verified behavior.
- Keep OpenCode server/client/plugin at 2.0.15 together unless an upgrade is the task. Bridge dependencies resolve from `bridge/`, not the root.
- Test through public entrypoints; mock only external services. Use disposable projects/SQLite and verify outputs.
- Distinguish simulated-service tests, real OpenCode checks, and real Slack verification.

### Ask First

- Get explicit task authorization before production deployment or live Slack/Notion configuration changes. Feature implementation alone does not authorize those operations.

### Never Do

- Never use production Slack tokens in development: competing Socket Mode connections steal live events.
- Never commit credentials, `.env` files, databases, attachments, or local Notion login state.
- Never treat old `docs/plan.md` slice prompts or Bun design documents as current setup instructions.

## Code Structure

- `architecture.md`, `opencode-interface.md`, and original `docs/plan.md` prompts are historical. Current deployment mapping is in `docs/project-mapping.md`.
- The bridge imports the plugin RPC definition directly; install both packages before checking or starting it.

## Coding Style

- Keep imports at the top and preserve the existing TypeScript style. Prefer functions unless shared state/lifecycle justifies a class.
- Integration tests only unless explicitly requested otherwise; assert observable results, not internal mock calls.

## Git Rules

- Commit each authorized logical change with a conventional prefix; stage relevant files only. No co-author trailers.
- Keep PRs focused, target under 300 changed lines; split larger features before implementation. Use the task's relevant base branch.
