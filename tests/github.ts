import { execFile } from "node:child_process";
import { chmod, chown, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A stand-in for GitHub over SSH: real git clones `git@github.com:<repo>` from a local bare repository.
 *
 * 1. Commit a README to a source repository and clone it bare to `<work>/github/<repo>`.
 * 2. Put an `ssh` in `bin` that logs its arguments and runs the requested upload-pack there.
 * 3. Return the deploy key and known_hosts paths the start script needs (their content is never read).
 */
export async function fakeGitHub(work: string, bin: string, repo: string) {
  const source = join(work, "source");
  const github = join(work, "github");
  const sshLog = join(work, "ssh.log");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "README.md"), "# BillClear\n");
  const git = (...args: string[]) => run("git", args, { cwd: source });
  await git("init", "-q");
  await git("add", ".");
  await git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "init",
  );
  await run("git", ["clone", "-q", "--bare", source, join(github, repo)]);
  await writeFile(
    join(bin, "ssh"),
    `#!/bin/sh\necho "$*" >> "${sshLog}"\nfor last; do :; done\ncd "${github}" && exec sh -c "git \${last#git-}"\n`,
  );
  await chmod(join(bin, "ssh"), 0o755);
  const key = join(work, "deploy_key");
  const known = join(work, "known_hosts");
  await writeFile(key, "test key\n", { mode: 0o600 });
  await writeFile(known, "github.com ssh-ed25519 test\n");
  await writeFile(sshLog, "");
  // As root, the clone runs as uid 1000, which must own the repository (Git's safe.directory) and write the log.
  if (process.getuid?.() === 0) {
    await run("chown", ["-R", "1000:1000", github]);
    await chown(sshLog, 1000, 1000);
  }
  return { key, known, sshLog };
}
