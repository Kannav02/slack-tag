import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import plugin from "../plugin/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const TOKEN = "gho-test-only-token";
const PROXY = ["--experimental-strip-types", "--no-warnings", "proxy/git-proxy.ts"];
type Tool = { execute(input: unknown, context: { sessionID: string }): Promise<unknown> };

// Fake GitHub REST API for owner/repo (default branch main) that remembers opened pull requests.
async function fakeGitHub(t: TestContext) {
  const received: { call: string; auth: string | undefined; body: string }[] = [];
  const pulls = new Map<string, { html_url: string }>();
  const server = createServer((req, res) => {
    const reply = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    text(req)
      .then((body) => {
        received.push({ call: `${req.method} ${req.url}`, auth: req.headers.authorization, body });
        const query = new URL(req.url!, "http://github").searchParams.get("head");
        if (req.method === "GET" && query) return reply(200, [pulls.get(query)].filter(Boolean));
        if (req.method === "GET")
          return reply(200, { default_branch: "main", temp_clone_token: TOKEN });
        const { head } = JSON.parse(body) as { head: string };
        // An upstream error that echoes the credential must never reach the caller.
        if (head === "jeff/refused") return reply(422, { message: req.headers.authorization });
        const pr = { html_url: `https://github.com/owner/repo/pull/${pulls.size + 1}` };
        pulls.set(`owner:${head}`, pr);
        reply(201, pr);
      })
      .catch(() => res.destroy());
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  t.after(() => server.close());
  return { received, upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// Starts the real proxy entrypoint for owner/repo against the fake GitHub.
async function startProxy(t: TestContext, upstream: string, allow: Record<string, string> = {}) {
  let logs = "";
  const env = { PATH: process.env.PATH, GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: TOKEN };
  const child = spawn(process.execPath, PROXY, {
    cwd: root,
    env: { ...env, GIT_UPSTREAM: upstream, PORT: "0", HOST: "127.0.0.1", ...allow },
  });
  for (const out of [child.stdout, child.stderr]) out.on("data", (chunk) => (logs += chunk));
  t.after(() => child.kill());
  const deadline = Date.now() + 10_000;
  while (!/listening on \d+/.test(logs) && Date.now() < deadline) await delay(50);
  const port = /listening on (\d+)/.exec(logs)?.[1];
  assert.ok(port, logs);
  return { url: `http://127.0.0.1:${port}`, logs: () => logs };
}

await test("pull requests via the repository-bound Git proxy", { timeout: 20_000 }, async (t) => {
  const { received, upstream } = await fakeGitHub(t);
  const proxy = await startProxy(t, upstream, { GIT_ALLOW_PULL_REQUESTS: "1" });
  const replies: string[] = [];
  const call = async (method: string, path: string, value?: object) => {
    const headers = { authorization: "Bearer caller" };
    const reply = await fetch(proxy.url + path, { method, headers, body: JSON.stringify(value) });
    replies.push(await reply.text());
    return `${reply.status} ${replies.at(-1)}`;
  };
  const pr = { title: "Greet", body: "Adds a greeting.", head: "jeff/greeting", base: "main" };
  const url = "https://github.com/owner/repo/pull/1";
  const lookup = "/repos/owner/repo/pulls?head=owner%3Ajeff%2Fgreeting&state=open";

  // Open, find and read the default branch, with the caller's credential replaced.
  const opened = await call("POST", "/repos/owner/repo/pulls", { ...pr, issue: 3 });
  assert.equal(opened, `201 {"html_url":"${url}"}`);
  assert.equal(received.at(-1)?.body, JSON.stringify(pr), "only the checked fields reach GitHub");
  assert.equal(await call("GET", lookup), `200 [{"html_url":"${url}"}]`);
  assert.equal(received.at(-1)?.call, `GET ${lookup}`);
  assert.equal(await call("GET", "/repos/owner/repo"), '200 {"default_branch":"main"}');
  assert.ok(
    received.every((r) => r.auth === `Bearer ${TOKEN}`),
    "caller auth never forwarded",
  );

  // Other repositories, endpoints, branches and fields, and oversized bodies, never reach GitHub.
  const forwarded = received.length;
  const refused: [string, string, object?][] = [
    ["GET", "/repos/other/repo"],
    ["GET", lookup.replaceAll("owner", "other")],
    ["GET", lookup.replace("jeff%2Fgreeting", "main")],
    ["GET", `${lookup}&per_page=100`],
    ["GET", "/repos/owner/repo/issues"],
    ["PATCH", "/repos/owner/repo/pulls/1"],
    ["PUT", "/repos/owner/repo/pulls/1/merge"],
    ["GET", "/user"],
    ["POST", "/repos/other/repo/pulls", pr],
    ["POST", "/repos/owner/repo/pulls", { ...pr, head: "feature/greeting" }],
    ["POST", "/repos/owner/repo/pulls", { ...pr, head: "owner:jeff/greeting" }],
    ["POST", "/repos/owner/repo/pulls", { ...pr, base: "jeff/greeting" }],
    ["POST", "/repos/owner/repo/pulls", { ...pr, title: 1 }],
  ];
  for (const [method, path, value] of refused)
    assert.match(await call(method, path, value), /^403 /, `${method} ${path}`);
  const large = { ...pr, body: "x".repeat(70_000) };
  assert.match(await call("POST", "/repos/owner/repo/pulls", large), /^413 /);
  assert.equal(received.length, forwarded, "refused calls never reach GitHub");

  // GitHub errors become generic, so the token never reaches a caller or the logs.
  const error = await call("POST", "/repos/owner/repo/pulls", { ...pr, head: "jeff/refused" });
  assert.equal(error, "502 GitHub API failed (422)");
  assert.ok(!replies.join().includes(TOKEN) && !proxy.logs().includes(TOKEN));

  // Without GIT_ALLOW_PULL_REQUESTS=1 nothing reaches GitHub.
  const disabled = await startProxy(t, upstream);
  assert.equal((await fetch(`${disabled.url}/repos/owner/repo`)).status, 403);
  const create = { method: "POST", body: JSON.stringify(pr) };
  assert.equal((await fetch(`${disabled.url}/repos/owner/repo/pulls`, create)).status, 403);
  assert.equal(received.length, forwarded + 1);

  // The plugin tool, loaded as OpenCode loads it, in a disposable repository on jeff/tool.
  const dir = await mkdtemp(join(tmpdir(), "slack-tag-pr-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q", "-b", "jeff/tool");
  git("remote", "add", "origin", "git@github.com-kannav02:owner/repo.git");
  let tool: Tool | undefined;
  const tools = { add: (added: Tool) => (tool = added) };
  const host = {
    rpc: { register: async () => undefined },
    permission: { hook: async () => undefined },
    shell: { hook: async () => undefined },
    session: { hook: async () => undefined, get: async () => ({ location: { directory: dir } }) },
    tool: { transform: async (edit: (editor: typeof tools) => void) => edit(tools) },
  };
  await plugin.setup(host as unknown as Parameters<typeof plugin.setup>[0]);
  const open = () => tool!.execute({ title: "Add tool", body: "Hi." }, { sessionID: "ses_1" });
  process.env.GIT_PROXY_URL = proxy.url;
  const result = { content: "https://github.com/owner/repo/pull/2" };
  assert.deepEqual(await open(), result);
  assert.deepEqual(await open(), result, "the open pull request is found, not opened again");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  await assert.rejects(open(), /jeff\/<slug> branch, not main/);
  delete process.env.GIT_PROXY_URL;
  await assert.rejects(open(), /not set up for this project/);
});
