import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin from "../plugin/index.ts";

type Setup = Parameters<typeof plugin.setup>[0];
type Context = { system: { type: string; text: string }[] };

const FLAG = "OPENCODE_CONFIG_PROJECT_DISABLE";

// A disposable session directory, canonicalized so the plugin's symlink-free read is not tripped by a
// symlinked temp root (for example /tmp -> /private/tmp).
async function sessionDir() {
  return realpath(await mkdtemp(join(tmpdir(), "slack-tag-agents-")));
}

// Load the plugin as OpenCode does for a session in `directory` and return its context hook. AGENTS.md
// is read during setup through /bin/sh (no agent-shell in tests), so set the flag before calling this.
async function contextHook(directory: string) {
  const hooks = new Map<string, (input: Context) => void>();
  const host = {
    location: { directory },
    rpc: { register: async () => undefined },
    permission: { hook: async () => undefined },
    shell: { hook: async () => undefined },
    session: {
      hook: async (name: string, fn: (input: Context) => void) => {
        hooks.set(name, fn);
      },
    },
    tool: { transform: async () => undefined },
    command: { transform: async () => undefined },
  };
  delete process.env.GIT_PROXY_URL;
  await plugin.setup(host as unknown as Setup);
  const hook = hooks.get("context");
  assert.ok(hook);
  return hook;
}

// The system-prompt fragments the context hook adds for a fresh session.
function systemFor(hook: (input: Context) => void): string[] {
  const input: Context = { system: [] };
  hook(input);
  return input.system.map((part) => part.text);
}

await test("a worktree session (project config disabled) gets its AGENTS.md in the system prompt", async () => {
  const dir = await sessionDir();
  const text = "# Project rules\nAlways answer in French. Run `npm run check` before finishing.";
  await writeFile(join(dir, "AGENTS.md"), text);
  process.env[FLAG] = "1";
  try {
    const system = systemFor(await contextHook(dir));
    // The existing instructions still load, and AGENTS.md is added verbatim as its own fragment.
    assert.match(system.join("\n"), /multiplayer session/);
    assert.ok(system.includes(text), "AGENTS.md text missing from the system prompt");
  } finally {
    delete process.env[FLAG];
    await rm(dir, { recursive: true, force: true });
  }
});

await test("without the flag OpenCode auto-loads AGENTS.md, so the plugin adds nothing (no double)", async () => {
  const dir = await sessionDir();
  await writeFile(join(dir, "AGENTS.md"), "# Project rules\nAlways answer in French.");
  delete process.env[FLAG];
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  try {
    const system = systemFor(await contextHook(dir));
    assert.ok(
      !system.join("\n").includes("French"),
      "AGENTS.md must not be injected when project config is on",
    );
    assert.equal(system.length, 3); // multiplayer + concise + screenshot only
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("an AGENTS.md symlinked to a server-only or outside file is not read", async () => {
  const dir = await sessionDir();
  const outside = await sessionDir();
  await writeFile(join(outside, "secret.md"), "OUTSIDE SECRET CONTENT");
  process.env[FLAG] = "1";
  try {
    // A symlink to the server's own environment (#51) and to a readable file outside the session are
    // both refused: realpath does not equal the requested path, so the guarded read fails.
    for (const target of ["/proc/self/environ", join(outside, "secret.md")]) {
      await rm(join(dir, "AGENTS.md"), { force: true });
      await symlink(target, join(dir, "AGENTS.md"));
      const system = systemFor(await contextHook(dir));
      assert.ok(
        !/OUTSIDE SECRET CONTENT|PATH=|environ/.test(system.join("\n")),
        `a symlinked AGENTS.md (${target}) leaked into the prompt`,
      );
      assert.equal(system.length, 3); // nothing injected beyond the base instructions
    }
  } finally {
    delete process.env[FLAG];
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

await test("a missing AGENTS.md injects nothing and does not error", async () => {
  const dir = await sessionDir();
  process.env[FLAG] = "1";
  try {
    const system = systemFor(await contextHook(dir)); // setup must not throw
    assert.equal(system.length, 3); // multiplayer + concise + screenshot only
  } finally {
    delete process.env[FLAG];
    await rm(dir, { recursive: true, force: true });
  }
});

await test("an AGENTS.md larger than the 32 KiB cap is not injected", async () => {
  const dir = await sessionDir();
  await writeFile(join(dir, "AGENTS.md"), "x".repeat(33 * 1024));
  process.env[FLAG] = "1";
  try {
    const system = systemFor(await contextHook(dir));
    assert.ok(!system.join("\n").includes("xxxx"), "an over-cap AGENTS.md was injected");
    assert.equal(system.length, 3);
  } finally {
    delete process.env[FLAG];
    await rm(dir, { recursive: true, force: true });
  }
});
