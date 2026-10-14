import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const token = "test-only-repository-token";
const auth = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
function portOf(server: Server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

await test(
  "Git proxy authenticates clone/pull/push only for its repository",
  { timeout: 30_000 },
  async (t) => {
    const work = await mkdtemp(join(tmpdir(), "git-proxy-"));
    t.after(() => rm(work, { recursive: true, force: true }));
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (args: string[], cwd = work) => run("git", args, { cwd, env });
    await mkdir(join(work, "owner"));
    await git(["init", "--bare", "--initial-branch=main", "owner/repo.git"]);
    const bare = join(work, "owner/repo.git");
    await git(["config", "http.receivepack", "true"], bare);
    // Models GitHub's mandatory no-force/no-deletion rules, enforced outside the agent.
    await git(["config", "receive.denyNonFastForwards", "true"], bare);
    await git(["config", "receive.denyDeletes", "true"], bare);
    await git(["clone", bare, "seed"]);
    const seed = join(work, "seed");
    async function commit(cwd: string, value: string) {
      await writeFile(join(cwd, "data.txt"), value);
      await git(["add", "data.txt"], cwd);
      await git(
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", value],
        cwd,
      );
    }
    await commit(seed, "first");
    await git(["push", "origin", "main"], seed);
    // Distinct advertised tips make clone's upload-pack request large enough for Git's gzip transport.
    for (let i = 0; i < 40; i++) {
      const tip = await git(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit-tree",
          "main^{tree}",
          "-p",
          "main",
          "-m",
          String(i),
        ],
        bare,
      );
      await git(["update-ref", "refs/heads/extra-" + i, tip.stdout.trim()], bare);
    }
    let gzipRequests = 0;
    let redirect = false;
    let requests = 0;
    // Real Git smart HTTP backend stands in only for external GitHub.
    const upstream = createServer((req, res) => {
      requests++;
      if (req.headers["content-encoding"] === "gzip") gzipRequests++;
      if (req.headers.authorization !== auth) return void res.writeHead(401).end();
      if (redirect)
        return void res
          .writeHead(302, { location: "https://other.example/", "set-cookie": token })
          .end(token);
      buffer(req)
        .then(async (body) => {
          const url = new URL(req.url!, "http://fixture");
          const child = spawn("git", ["http-backend"], {
            env: {
              ...env,
              GIT_PROJECT_ROOT: work,
              GIT_HTTP_EXPORT_ALL: "1",
              PATH_INFO: url.pathname,
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: req.method!,
              HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
              CONTENT_TYPE: req.headers["content-type"] ?? "",
              CONTENT_LENGTH: String(body.length),
              REMOTE_USER: "test",
              GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
            },
          });
          child.stdin.end(body);
          const output = await buffer(child.stdout);
          const boundary = output.indexOf("\r\n\r\n");
          assert.ok(boundary >= 0, output.toString());
          for (const header of output.subarray(0, boundary).toString().split("\r\n")) {
            const [name, ...value] = header.split(": ");
            if (name?.toLowerCase() === "status")
              res.statusCode = Number(value.join(": ").slice(0, 3));
            else if (name) res.setHeader(name, value.join(": "));
          }
          res.end(output.subarray(boundary + 4));
        })
        .catch(() => res.destroy());
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(() => {
      upstream.close();
      upstream.closeAllConnections();
    });
    let logs = "";
    async function start(push: boolean) {
      const child = spawn(process.execPath, ["proxy/git-proxy.ts"], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: token,
          GIT_UPSTREAM: `http://127.0.0.1:${portOf(upstream)}`,
          GIT_ALLOW_PUSH: push ? "1" : "0",
          PORT: "0",
          HOST: "127.0.0.1",
        },
      });
      t.after(() => {
        child.kill();
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        logs += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });
      const deadline = Date.now() + 5000;
      while (!/listening on \d+/.test(output) && Date.now() < deadline) await delay(20);
      const port = /listening on (\d+)/.exec(output)?.[1];
      assert.ok(port, logs);
      return `http://127.0.0.1:${port}`;
    }
    const proxy = await start(true);
    const original = "git@github.com-kannav02:owner/repo.git";
    await assert.rejects(
      run("git", ["ls-remote", original], { env: { ...env, GIT_SSH_COMMAND: "/no-such-ssh" } }),
      /no-such-ssh/,
    );
    const agentEnv = {
      ...env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${proxy}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "git@github.com-kannav02:",
    };
    const agentGit = (args: string[], cwd = work) => run("git", args, { cwd, env: agentEnv });
    await agentGit(["clone", original, "agent"]);
    assert.ok(gzipRequests > 0, "real Git clone exercised compressed smart HTTP requests");
    const agent = join(work, "agent");
    assert.equal(await readFile(join(agent, "data.txt"), "utf8"), "first");
    const configBefore = await readFile(join(agent, ".git/config"), "utf8");
    assert.ok(configBefore.includes(original));
    assert.ok(!configBefore.includes(token) && !configBefore.includes(proxy));
    await commit(seed, "second");
    await git(["push", "origin", "main"], seed);
    await agentGit(["fetch", "origin"], agent);
    await agentGit(["pull", "--ff-only", "origin", "main"], agent);
    assert.equal(await readFile(join(agent, "data.txt"), "utf8"), "second");
    await commit(agent, "third");
    await agentGit(["push", "origin", "main"], agent);
    assert.equal((await git(["show", "main:data.txt"], bare)).stdout, "third");
    await assert.rejects(
      agentGit(["push", "--force", "origin", "HEAD~1:main"], agent),
      /non-fast-forward/,
    );
    await assert.rejects(agentGit(["push", "origin", ":main"], agent), /deletion prohibited/);
    assert.equal(await readFile(join(agent, ".git/config"), "utf8"), configBefore);
    const before = requests;
    for (const path of [
      "/other/repo.git/info/refs?service=git-upload-pack",
      "/owner/repo.git/info/refs?service=git-upload-pack&extra=1",
      "/owner/repo.git/HEAD",
      "/owner/repo.git/git-receive-pack?x=1",
    ]) {
      assert.equal((await fetch(proxy + path)).status, 403);
    }
    assert.equal(
      (
        await fetch(`${proxy}/owner/repo.git/git-upload-pack`, {
          method: "POST",
          headers: { "content-encoding": "br" },
          body: "bad",
        })
      ).status,
      415,
    );
    assert.equal(requests, before);
    const readOnly = await start(false);
    assert.equal(
      (await fetch(`${readOnly}/owner/repo.git/info/refs?service=git-receive-pack`)).status,
      403,
    );
    assert.equal(
      (await fetch(`${readOnly}/owner/repo.git/git-receive-pack`, { method: "POST", body: "0000" }))
        .status,
      403,
    );
    redirect = true;
    const denied = await fetch(`${proxy}/owner/repo.git/info/refs?service=git-upload-pack`);
    assert.equal(denied.status, 502);
    assert.equal(denied.headers.get("location"), null);
    assert.equal(denied.headers.get("set-cookie"), null);
    assert.ok(!(await denied.text()).includes(token));
    upstream.close();
    upstream.closeAllConnections();
    assert.equal(
      (await fetch(`${proxy}/owner/repo.git/info/refs?service=git-upload-pack`)).status,
      502,
    );
    assert.ok(!logs.includes(token) && !logs.includes(auth));
  },
);
