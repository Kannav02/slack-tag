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
  async function start(name: string, envFile?: string) {
    if (envFile !== undefined) await writeFile(join(state, "projects", `${name}.env`), envFile);
    return run("sh", [script, name], {
      env: {
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        SLACK_TAG_STATE_DIR: state,
        SLACK_TAG_PROJECTS_ROOT: projects,
        SLACK_TAG_IMAGE: "operator-image",
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
    "SLACK_TAG_IMAGE=attacker-image\nPROXY_ENV_FILE=/etc/shadow\nSLACK_BOT_TOKEN=xoxb-x\n";
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
    /attacker-image|\/etc\/shadow|xoxb|SLACK_TAG_PROJECTS_ROOT|SLACK_TAG_STATE_DIR/,
  );
});

// `register new`: the helper creates <projects root>/<name> only when the env file asks, and never over anything.
await test("start-project.sh creates a new project's folder only when asked, only under its own name", async (t) => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "slack-tag-create-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const state = join(work, "state");
  const projects = join(work, "projects");
  await mkdir(join(state, "projects"), { recursive: true });
  for (const name of ["book", "taken", "linked"])
    await mkdir(join(state, "inbox", name), { recursive: true });
  await mkdir(projects);
  // As root, the folder is created as uid 1000, which owns the projects root (docs/deploy.md).
  const asRoot = process.getuid?.() === 0;
  if (asRoot) {
    await chmod(work, 0o755);
    await chown(projects, 1000, 1000);
  }
  await mkdir(join(work, "bin"));
  await writeFile(join(work, "bin", "docker"), `#!/bin/sh\necho "$*" >> "${work}/docker.log"\n`);
  await chmod(join(work, "bin", "docker"), 0o755);
  const dockerCalls = async () =>
    (await readFile(join(work, "docker.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const envOf = (project: string, create = true) =>
    `SLACK_TAG_PROJECT=${project}\nSLACK_TAG_PORT=4102\nSLACK_TAG_PASSWORD=${password}\nSLACK_TAG_NET=3\n${create ? "SLACK_TAG_CREATE=1\n" : ""}`;
  async function start(name: string, envFile?: string) {
    if (envFile !== undefined) await writeFile(join(state, "projects", `${name}.env`), envFile);
    const env = { PATH: `${join(work, "bin")}:${process.env.PATH}`, SLACK_TAG_STATE_DIR: state };
    return run("sh", [script, name], { env: { ...env, SLACK_TAG_PROJECTS_ROOT: projects } }).then(
      () => "started",
      (error: unknown) =>
        error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "failed",
    );
  }
  const book = join(projects, "book");

  // Without the flag, for another name's path, or with an invalid value, nothing is created.
  assert.match(await start("book", envOf(book, false)), /project folder is missing/);
  assert.match(await start("book", envOf(join(projects, "other"))), /project folder is missing/);
  assert.match(await start("book", envOf(book).replace("NET=3", "NET=0")), /invalid network/);
  await assert.rejects(lstat(book));
  await assert.rejects(lstat(join(projects, "other")));
  // A file or a symlink already at the path is never replaced or followed.
  await writeFile(join(projects, "taken"), "keep");
  assert.match(await start("taken", envOf(join(projects, "taken"))), /project folder is missing/);
  assert.equal(await readFile(join(projects, "taken"), "utf8"), "keep");
  await symlink(state, join(projects, "linked"));
  assert.match(await start("linked", envOf(join(projects, "linked"))), /project folder is missing/);
  assert.deepEqual(await dockerCalls(), []);

  // Asked for and absent: created (as uid 1000 when run as root), prepared as a Git repository, started.
  assert.equal(await start("book", envOf(book)), "started");
  const created = await lstat(book);
  assert.ok(created.isDirectory());
  if (asRoot) assert.equal(created.uid, 1000);
  assert.equal(created.mode & 0o007, 0);
  await lstat(join(book, ".git", "config"));
  // Starting again while the flag is still set keeps the folder and its files.
  await writeFile(join(book, "chapter.md"), "draft");
  if (asRoot) await chown(join(book, "chapter.md"), 1000, 1000);
  assert.equal(await start("book"), "started");
  assert.equal(await readFile(join(book, "chapter.md"), "utf8"), "draft");
  assert.equal((await dockerCalls()).length, 2);
});
