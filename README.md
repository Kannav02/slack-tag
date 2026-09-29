# Slack Tag

A self-hosted Slack interface to OpenCode: each configured channel selects a project, and each thread has its own persistent agent conversation. The deployed version is owner-only; multiplayer and Slack project onboarding are planned.

## Development

Use Node.js 24 and npm. From the repository root:

```sh
bash scripts/setup-cloud.sh
npm run check
```

Setup installs root development tools and the separately locked `bridge/` and `plugin/` packages. OpenCode client/plugin versions remain pinned to 2.0.15; the bridge uses Slack Bolt 4.4.0. No Bun runtime is required for the application or these checks.

The checks verify dependencies, typecheck the application, and run integration tests through the actual bridge entrypoint. Tests use temporary SQLite/project files and simulated Slack/OpenCode servers on localhost, with no credentials, Docker, or production access. They do not prove real Slack rendering or real OpenCode execution; see [Cloud development](docs/cloud-development.md).

## Run and deploy

- [Interactive demo](demo/README.md): fake Slack UI with real OpenCode; requires a development inference key.
- [VPS deployment](docs/deploy.md): systemd bridge plus Docker Compose project servers.
- [Project → server → session mapping](docs/project-mapping.md).
- [Verification findings](docs/findings.md): real runtime/Slack evidence and limitations.

## Feature work

- [SPEC.md](SPEC.md): product requirements and implementation boundaries.
- [Backlog and decisions](docs/backlog.md): security, commands, onboarding, and multiplayer.
- [Codex Cloud setup](docs/cloud-development.md): setup, verification levels, and Notion access.
- [Slack Tag in Notion](https://www.notion.so/3e91697f7f2281d988abf6e8d9ed6b78): planning page and work-item database.

Never give a development bridge the production Slack app token: Socket Mode distributes events between connections using the same app. Keep credentials out of Git and project-agent environments.
