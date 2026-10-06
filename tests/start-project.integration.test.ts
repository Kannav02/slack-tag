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
import { fakeGitHub } from "./github.ts";

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
    for (const dir of [projects, join(projects, "app"), join(projects, "app", "deep")])
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
  async function start(name: string, envFile?: string, extra: Record<string, string> = {}) {
    if (envFile !== undefined) await writeFile(join(state, "projects", `${name}.env`), envFile);
    return run("sh", [script, name], {
      env: {
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        SLACK_TAG_STATE_DIR: state,
        SLACK_TAG_PROJECTS_ROOT: projects,
        SLACK_TAG_IMAGE: "operator-image",
        ...extra,
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

  // A project registered from a GitHub URL is cloned on its first start with the operator's key.
  const github = await fakeGitHub(work, join(work, "bin"), "Owner/Repo.git");
  const url = "git@github.com:Owner/Repo.git";
  const repoDir = join(projects, "repo");
  const repoEnv = (repo: string, project = repoDir) => envOf(project, `SLACK_TAG_REPO=${repo}\n`);
  const keys = { SLACK_TAG_GIT_KEY: github.key, SLACK_TAG_GIT_KNOWN_HOSTS: github.known };
  await mkdir(join(state, "inbox", "repo"));
  for (const repo of [
    "git@github.com:-oProxyCommand=id/x.git",
    "ext::sh -c id",
    "git@example.com:Owner/Repo.git",
    `${url};id`,
  ]) {
    assert.match(await start("repo", repoEnv(repo), keys), /invalid repository URL/, repo);
  }
  assert.match(
    await start("repo", repoEnv(url, join(projects, "..", "repo")), keys),
    /not directly inside/,
  );
  assert.match(await start("repo", repoEnv(url)), /cloning is not configured/);
  // A failed clone leaves no folder behind.
  assert.match(
    await start("repo", repoEnv("git@github.com:Owner/Missing.git"), keys),
    /cloning git@github.com:Owner\/Missing.git failed/,
  );
  await assert.rejects(lstat(repoDir));
  assert.equal(await start("repo", repoEnv(url), keys), "started");
  assert.equal(await readFile(join(repoDir, "README.md"), "utf8"), "# BillClear\n");
  assert.match(
    await readFile(join(repoDir, ".git", "config"), "utf8"),
    /url = git@github.com:Owner\/Repo.git/,
  );
  await assert.rejects(lstat(join(projects, ".clone-repo")));
  // SSH uses only the configured key and pinned host keys, and never prompts.
  const ssh = await readFile(github.sshLog, "utf8");
  for (const option of [
    `-i ${github.key}`,
    "IdentitiesOnly=yes",
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    `UserKnownHostsFile=${github.known}`,
  ]) {
    assert.ok(ssh.includes(option), option);
  }
  // An existing folder is never cloned again: a restart only prepares and starts it.
  assert.equal(await start("repo", repoEnv(url), keys), "started");
  assert.equal(await readFile(github.sshLog, "utf8"), ssh);
  assert.equal(
    (await dockerCalls()).at(-1),
    `compose -p slack-tag-repo -f ${join(root, "deploy/project.yaml")} --env-file /dev/null up -d`,
  );
});
