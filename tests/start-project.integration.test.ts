import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "deploy/start-project.sh");
const password = "a".repeat(48);

// The root-side start script with a stand-in docker CLI: what it lets through is exactly what Docker would get.
await test("start-project.sh starts only checked projects and passes Docker only checked values", async (t) => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "slack-tag-start-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const state = join(work, "state");
  const projects = join(work, "projects");
  const outside = join(work, "outside");
  for (const dir of [
    join(state, "projects"),
    join(state, "inbox", "app"),
    join(projects, "app", "deep"),
    outside,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await symlink(outside, join(projects, "link"));
  // As root, the script prepares the folder as uid 1000, which must be able to reach and own it.
  const asRoot = process.getuid?.() === 0;
  if (asRoot) {
    await chmod(work, 0o755);
    for (const dir of [join(projects, "app"), join(projects, "app", "deep")])
      await chown(dir, 1000, 1000);
  }
  await mkdir(join(work, "bin"));
  await writeFile(
    join(work, "bin", "docker"),
    `#!/bin/sh\necho "$*" >> "${work}/docker.log"\nenv > "${work}/docker.env"\n`,
  );
  await chmod(join(work, "bin", "docker"), 0o755);
  const dockerCalls = async () =>
    (await readFile(join(work, "docker.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);

  const envOf = (project: string, extra = "") =>
    `SLACK_TAG_PROJECT=${project}\nSLACK_TAG_PORT=4102\nSLACK_TAG_PASSWORD=${password}\nSLACK_TAG_NET=3\n${extra}`;
  async function start(name: string, envFile?: string, gitProxy?: string) {
    if (envFile !== undefined) await writeFile(join(state, "projects", `${name}.env`), envFile);
    return run("sh", [script, name], {
      env: {
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        SLACK_TAG_STATE_DIR: state,
        SLACK_TAG_PROJECTS_ROOT: projects,
        SLACK_TAG_IMAGE: "operator-image",
        ...(gitProxy ? { GIT_PROXY_ENV_FILE: gitProxy } : {}),
      },
    }).then(
      () => "started",
      (error: unknown) =>
        error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "failed",
    );
  }

  // Refused before Docker is ever called.
  const refusals: [string, string | undefined, RegExp][] = [
    ["../app", undefined, /invalid project name/],
    ["App", undefined, /invalid project name/],
    ["missing", undefined, /no env file/],
    ["app", envOf(join(projects, "link")), /project folder is missing/],
    ["app", envOf(join(projects, "app", "deep")), /not directly inside/],
    ["app", envOf(outside), /not directly inside/],
    ["app", envOf(projects), /not directly inside/],
    ["app", envOf(join(projects, "app")).replace("PORT=4102", "PORT=80"), /invalid port/],
    ["app", envOf(join(projects, "app")).replace("PORT=4102", "PORT=4102;id"), /invalid port/],
    ["app", envOf(join(projects, "app")).replace("NET=3", "NET=0"), /invalid network number/],
    ["app", envOf(join(projects, "app")).replace(password, "short"), /invalid server password/],
  ];
  for (const [name, envFile, reason] of refusals) {
    assert.match(await start(name, envFile), reason, `${name}: ${envFile ?? ""}`);
  }
  await rm(join(state, "inbox", "app"), { recursive: true });
  assert.match(await start("app", envOf(join(projects, "app"))), /upload inbox .* is missing/);
  await mkdir(join(state, "inbox", "app"));
  // A symlink the agent left in the project is refused, and nothing is written through it.
  await symlink(join(outside, "planted"), join(projects, "app", "opencode.json"));
  assert.match(
    await start("app", envOf(join(projects, "app"))),
    /opencode.json in .* is a symlink/,
  );
  await assert.rejects(lstat(join(outside, "planted")));
  await rm(join(projects, "app", "opencode.json"));
  assert.deepEqual(await dockerCalls(), []);

  // A valid project starts; extra lines in the bridge-written env file never reach Docker.
  const planted =
    "SLACK_TAG_IMAGE=attacker-image\nPROXY_ENV_FILE=/etc/shadow\nGIT_PROXY_ENV_FILE=/etc/attacker\nSLACK_BOT_TOKEN=xoxb-x\n";
  assert.equal(await start("app", envOf(join(projects, "app"), planted)), "started");
  assert.deepEqual(await dockerCalls(), [
    `compose -p slack-tag-app -f ${join(root, "deploy/project.yaml")} --env-file /dev/null up -d`,
  ]);
  // The folder is prepared before Docker mounts it, closed to other users, and as root owned by uid 1000.
  const prepared = await lstat(join(projects, "app", "opencode.json"));
  assert.ok(prepared.isFile());
  if (asRoot) assert.equal(prepared.uid, 1000);
  assert.equal((await lstat(join(projects, "app"))).mode & 0o007, 0);
  const dockerEnv = await readFile(join(work, "docker.env"), "utf8");
  for (const line of [
    `SLACK_TAG_PROJECT=${join(projects, "app")}`,
    "SLACK_TAG_PORT=4102",
    `SLACK_TAG_PASSWORD=${password}`,
    "SLACK_TAG_NET=3",
    `SLACK_TAG_INBOX=${join(state, "inbox", "app")}`,
    "SLACK_TAG_IMAGE=operator-image",
  ]) {
    assert.match(dockerEnv, new RegExp(`^${line}$`, "m"));
  }
  assert.doesNotMatch(
    dockerEnv,
    /attacker-image|\/etc\/shadow|GIT_PROXY_ENV_FILE|xoxb|SLACK_TAG_PROJECTS_ROOT|SLACK_TAG_STATE_DIR/,
  );
  // An operator opts in one systemd instance; its explicit path reaches only the override.
  assert.equal(
    await start("app", envOf(join(projects, "app")), "/etc/slack-tag/git/app.env"),
    "started",
  );
  assert.match(
    (await dockerCalls()).at(-1)!,
    /git-proxy-project.yaml --env-file \/dev\/null up -d$/,
  );
  assert.match(
    await readFile(join(work, "docker.env"), "utf8"),
    /^GIT_PROXY_ENV_FILE=\/etc\/slack-tag\/git\/app.env$/m,
  );
});
