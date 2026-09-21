# Slack Bridge

A single-owner Slack-to-agent bridge. Requirements: [SPEC.md](SPEC.md).
Proposed module interfaces: [architecture.md](architecture.md).
Pinned agent contract: [opencode-interface.md](opencode-interface.md).

## Development setup

Use Bun 1.4.0.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run check:dependencies
```

The dependency check imports libraries and exercises in-memory SQLite. It does not connect to Slack, start OpenCode, or validate agent behavior. No application entry point or feature test suite exists yet.

Keep credentials out of Git. Slack tokens belong only to the bridge, never the project agent environment.
