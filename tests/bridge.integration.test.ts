import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));

// Requests the bridge sends to the fake services; loose objects keep every field for the secret checks.
const blockList = z.array(
  z.looseObject({
    type: z.string(),
    text: z.unknown().optional(),
    elements: z.array(z.looseObject({ value: z.string().optional() })).optional(),
  }),
);
const slackCall = z.looseObject({
  channel: z.string().optional(),
  user: z.string().optional(),
  text: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  blocks: z
    .preprocess(
      (value): unknown => (typeof value === "string" ? JSON.parse(value) : value),
      blockList,
    )
    .optional(),
});
const modelRef = z.object({ providerID: z.string(), id: z.string() });
const sessionCall = z.looseObject({
  location: z.object({ directory: z.string() }),
  model: modelRef,
});
const promptCall = z.looseObject({
  text: z.string(),
  delivery: z.string(),
  files: z.array(z.object({ uri: z.string(), name: z.string() })),
});
const anyCall = z.record(z.string(), z.unknown());
type Message = z.infer<typeof slackCall> & { method: string | undefined; ts: string };
type Bridge = ChildProcessByStdio<null, Readable, Readable>;

function portOf(server: Server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

// Start the production process, replace only external services, and inspect messages plus persisted state.
async function harness(
  t: TestContext,
  opts: { worktrees?: boolean; legacy?: { thread_ts: string; session_id: string }[] } = {},
) {
  const work = await mkdtemp(join(tmpdir(), "slack-tag-integration-"));
  const worktreeSlugs: string[] = [];
  const worktree = { fails: false };
  const messages: Message[] = [];
  const sessions: (z.infer<typeof sessionCall> & { id: string })[] = [];
  const prompts: (z.infer<typeof promptCall> & { sessionID: string | undefined })[] = [];
  const calls: (Record<string, unknown> & { type: string; sessionID: string | undefined })[] = [];
  const model = (providerID: string, id: string, input: string[]) => ({
    id,
    modelID: id,
    providerID,
    name: id,
    enabled: true,
    capabilities: { input },
  });
  const models = [
    model("test", "test", ["text", "image"]),
    model("test", "text-only", ["text"]),
    model("other", "x", ["text"]),
  ];
  // OpenCode answers its first model lists with an empty catalog while it is still loading.
  const catalog = { emptyLists: 0 };
  const slackErrors = { updateTs: "" };
  const unexpected: string[] = [];
  const replies: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const fetched: { path: string; authorization: string | undefined }[] = [];
  const streams = new Set<ServerResponse>();
  let child: Bridge | undefined;
  let socket: WebSocket | undefined;
  let stream: ServerResponse | undefined;
  let logs = "";
  let sequence = 0;
  let base = "";

  const server = createServer((req, res) => {
    text(req)
      .then((raw) => respond(req, res, raw))
      .catch((error: unknown) => {
        unexpected.push(error instanceof Error ? error.message : "request failed");
        res.destroy();
      });
  });
  function respond(req: IncomingMessage, res: ServerResponse, raw: string) {
    const args: unknown = req.headers["content-type"]?.includes("json")
      ? JSON.parse(raw || "{}")
      : Object.fromEntries(new URLSearchParams(raw));
    const path = new URL(req.url ?? "/", base).pathname;
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/api/event") {
      stream = res;
      streams.add(res);
      res.on("close", () => streams.delete(res));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    if (path.startsWith("/files/") || path === "/steal")
      fetched.push({ path, authorization: req.headers.authorization });
    if (path === "/files/ok.txt") return res.end("ok");
    if (path === "/files/redirect")
      return res
        .writeHead(302, { location: `${base.replace("127.0.0.1", "localhost")}/steal` })
        .end();
    if (path === "/files/note.txt") return res.end("uploaded note");
    if (path === "/api/rpc/slack-tag/status")
      return json({ output: { pluginVersion: "test", policyVersion: 3 } });
    if (path === "/api/rpc/slack-tag/worktree") {
      const slug = (args as { input?: { slug?: string } }).input?.slug ?? "";
      worktreeSlugs.push(slug);
      // worktree.fails simulates a server that cannot create one safely (project config not disabled).
      return json({ output: worktree.fails ? {} : { directory: `/worktrees/${slug}` } });
    }
    if (path === "/api/model") {
      if (catalog.emptyLists > 0) {
        catalog.emptyLists--;
        return json({ data: [] });
      }
      return json({ data: models });
    }
    if (path === "/api/session" && req.method === "POST") {
      const id = `ses_test${sessions.length + 1}`;
      sessions.push({ id, ...sessionCall.parse(args) });
      return json({ data: { id } });
    }
    const prompt = path.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (prompt) {
      prompts.push({ sessionID: prompt[1], ...promptCall.parse(args) });
      return json({});
    }
    if (/^\/api\/session\/[^/]+\/permission$/.test(path)) return json({ data: [] });
    const reply = path.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
    if (reply) {
      replies.push({ sessionID: reply[1], requestID: reply[2], ...anyCall.parse(args) });
      return res.writeHead(204).end();
    }
    // ses_child is a subagent of the first Slack session; ses_orphan has no mapped ancestor.
    const info = path.match(/^\/api\/session\/(ses_child|ses_orphan)$/);
    if (info)
      return json({
        data: { id: info[1], ...(info[1] === "ses_child" ? { parentID: sessions[0]?.id } : {}) },
      });
    const call = path.match(/^\/api\/session\/([^/]+)(?:\/(command|interrupt|compact|model))?$/);
    if (call && req.method === "GET" && !call[2])
      return json({ data: sessions.find((s) => s.id === call[1]) });
    if (call?.[2]) {
      calls.push({ ...anyCall.parse(args), type: call[2], sessionID: call[1] });
      const session = sessions.find((s) => s.id === call[1]);
      if (call[2] === "model" && session)
        session.model = z.object({ model: modelRef }).parse(args).model;
      if (call[2] === "interrupt") return json({ interrupted: true });
      if (call[2] === "compact") return json({ data: {} });
      res.writeHead(204);
      return res.end();
    }
    if (path === "/api/auth.test") return json({ ok: true, user_id: "UBOT", team_id: "TTEST" });
    if (path === "/api/apps.connections.open")
      return json({ ok: true, url: `${base.replace("http:", "ws:")}/socket` });
    if (path === "/api/reactions.add" || path === "/api/reactions.remove") {
      const { name, timestamp } = anyCall.parse(args);
      reactions.push(`${path.endsWith("add") ? "+" : "-"}${String(name)}@${String(timestamp)}`);
      return json({ ok: true });
    }
    if (path === "/api/chat.delete") {
      const slack = slackCall.parse(args);
      messages.push({ method: "chat.delete", ...slack, ts: slack.ts ?? "" });
      return json({ ok: true });
    }
    if (["/api/chat.postMessage", "/api/chat.update", "/api/chat.postEphemeral"].includes(path)) {
      const slack = slackCall.parse(args);
      if (path === "/api/chat.update" && slack.ts === slackErrors.updateTs)
        return json({ ok: false, error: "message_not_found" });
      const ts = slack.ts ?? `200.${++sequence}`;
      messages.push({ method: path.split("/").at(-1), ...slack, ts });
      return json({ ok: true, ts, channel: slack.channel });
    }
    unexpected.push(`${req.method} ${path}`);
    res.writeHead(404);
    res.end();
  }
  const wss = new WebSocketServer({ server, path: "/socket" });
  wss.on("connection", (ws) => {
    socket = ws;
    ws.send(
      JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "ATEST" } }),
    );
  });

  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  t.after(async () => {
    await stop();
    for (const ws of wss.clients) ws.terminate();
    for (const res of streams) res.end();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(work, { recursive: true, force: true });
  });
  async function until(check: () => unknown) {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for bridge outcome.\n${logs}\n${unexpected.join("\n")}`);
      await delay(20);
    }
  }
  async function start() {
    socket = stream = undefined;
    logs = "";
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--experimental-sqlite", join(root, "bridge/src/main.ts")],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: work,
          SLACK_TAG_CONFIG: join(state, "config.json"),
          SLACK_API_URL: `${base}/api/`,
          SLACK_BOT_TOKEN: "xoxb-test",
          SLACK_APP_TOKEN: "xapp-test",
          SLACK_FILES_URL: `${base}/files`,
          TEST_SERVER_PASSWORD: "pw-synthetic-secret",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    await until(() => socket && stream && logs.includes("bridge connected"));
  }
  function send(event: Record<string, unknown>, team = "TTEST") {
    const id = `event-${++sequence}`;
    assert.ok(socket);
    socket.send(
      JSON.stringify({
        envelope_id: id,
        type: "events_api",
        accepts_response_payload: false,
        payload: {
          type: "event_callback",
          team_id: team,
          api_app_id: "ATEST",
          event_id: id,
          event: {
            type: "message",
            channel: "CTEST",
            user: "UOWNER",
            text: "<@UBOT> start",
            ...event,
          },
        },
      }),
    );
  }
  function click(actionId: string, user: string, message: Message | undefined) {
    const id = `click-${++sequence}`;
    assert.ok(message && socket);
    const value = message.blocks?.[1]?.elements?.[0]?.value;
    socket.send(
      JSON.stringify({
        envelope_id: id,
        type: "interactive",
        accepts_response_payload: false,
        payload: {
          type: "block_actions",
          team: { id: "TTEST" },
          api_app_id: "ATEST",
          token: "t",
          trigger_id: id,
          user: { id: user },
          channel: { id: "CTEST" },
          container: { type: "message", message_ts: message.ts },
          message: { ts: message.ts, thread_ts: message.thread_ts },
          actions: [{ type: "button", action_id: actionId, block_id: "b", value, action_ts: "1" }],
        },
      }),
    );
  }
  function permission(id: string, sessionID: string, command: string) {
    assert.ok(stream);
    stream.write(
      `data: ${JSON.stringify({ type: "permission.asked", data: { id, sessionID, action: "shell", resources: [command] } })}\n\n`,
    );
  }
  const prompted = (id: string) =>
    messages.find(
      (m) => m.method === "chat.postMessage" && m.blocks?.[1]?.elements?.[0]?.value?.includes(id),
    );
  function emit(
    type: string,
    sessionID: string,
    delta?: string,
    data: object = { sessionID, delta },
  ) {
    assert.ok(stream);
    stream.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  }
  // A click with any button value, workspace and thread, for the malformed and misdirected cases.
  function rawClick(
    value: string,
    { team = "TTEST", thread = "100.3" }: { team?: string; thread?: string } = {},
  ) {
    assert.ok(socket);
    socket.send(
      JSON.stringify({
        envelope_id: `click-${++sequence}`,
        type: "interactive",
        accepts_response_payload: false,
        payload: {
          type: "block_actions",
          team: { id: team },
          user: { id: "UOWNER" },
          api_app_id: "ATEST",
          token: "t",
          trigger_id: "t",
          channel: { id: "CTEST" },
          message: { ts: "200.99", thread_ts: thread },
          container: { type: "message" },
          actions: [{ type: "button", action_id: "approve", block_id: "b", value, action_ts: "1" }],
        },
      }),
    );
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${portOf(server)}`;
  // The agent controls the project folder: point the old inbox and .git/info/exclude outside it.
  const project = join(work, "project");
  const state = join(work, "state");
  await mkdir(state);
  const outside = join(work, "outside");
  await mkdir(join(project, ".slack-tag"), { recursive: true });
  await mkdir(join(project, ".git", "info"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "victim.txt"), "untouched");
  await symlink(outside, join(project, ".slack-tag", "inbox"));
  await symlink(join(outside, "victim.txt"), join(project, ".git", "info", "exclude"));
  await writeFile(
    join(state, "config.json"),
    JSON.stringify({
      ownerUserId: "UOWNER",
      approvalTimeoutMinutes: 0.001,
      channels: {
        CTEST: {
          name: "test",
          projectDir: project,
          serverDir: "/project",
          opencodeUrl: base,
          passwordEnv: "TEST_SERVER_PASSWORD",
          model: "test/test",
          ...(opts.worktrees ? { worktrees: true } : {}),
        },
      },
    }),
  );
  // Seed thread→session rows mapped before per-thread worktrees: the pre-migration schema has no
  // directory column, so these keep the shared /project checkout.
  if (opts.legacy?.length) {
    const seed = new DatabaseSync(join(state, "slack-tag.sqlite"));
    seed.exec(
      "CREATE TABLE threads (team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (team_id, channel_id, thread_ts))",
    );
    for (const row of opts.legacy)
      seed
        .prepare("INSERT INTO threads VALUES ('TTEST', 'CTEST', ?, ?, '2026-01-01')")
        .run(row.thread_ts, row.session_id);
    seed.close();
  }
  await start();
  const db = new DatabaseSync(join(state, "slack-tag.sqlite"), { readOnly: true });
  t.after(() => db.close());
  return {
    state,
    project,
    outside,
    base,
    db,
    worktreeSlugs,
    worktree,
    messages,
    sessions,
    prompts,
    calls,
    replies,
    reactions,
    fetched,
    catalog,
    slackErrors,
    unexpected,
    logs: () => logs,
    until,
    start,
    stop,
    send,
    emit,
    click,
    rawClick,
    permission,
    prompted,
  };
}

await test(
  "Slack routing, queued prompts, Markdown replies, approvals, and session persistence",
  { timeout: 60_000 },
  async (t) => {
    const {
      state,
      outside,
      base,
      db,
      messages,
      sessions,
      prompts,
      replies,
      fetched,
      unexpected,
      logs,
      until,
      start,
      stop,
      send,
      emit,
      click,
      rawClick,
      permission,
      prompted,
    } = await harness(t);
    // Only the owner may register an unmapped channel.
    send({ ts: "100.1", user: "UOTHER", channel: "CUNMAPPED" });
    await until(() => messages.some((m) => m.method === "chat.postEphemeral"));
    assert.equal(messages[0]?.user, "UOTHER");
    assert.match(messages[0]?.text ?? "", /Only the owner can register/);
    assert.equal(sessions.length, 0);
    assert.equal(prompts.length, 0);

    send({ ts: "100.2", channel: "CUNMAPPED" });
    await until(() =>
      messages.some((m) => m.text?.startsWith("This channel is not mapped to a project.")),
    );
    assert.equal(sessions.length, 0);

    send({ ts: "100.3" });
    await until(() => prompts.length === 1);
    assert.equal(sessions[0]?.location.directory, "/project");
    assert.deepEqual(sessions[0]?.model, { providerID: "test", id: "test" });
    const sessionID = sessions[0]?.id ?? "";
    assert.equal(prompts[0]?.text, "<@UOWNER>: start");
    assert.equal(prompts[0]?.delivery, "queue");

    const sample =
      "# Heading\n\n**bold** and `inline`\n- item\n[link](https://example.com)\n```js\nconst n = 1\n```\nxoxb-synthetic-secret";
    const expected = sample.replace("xoxb-synthetic-secret", "[redacted]");
    emit("session.text.delta", sessionID, sample);
    await until(() => messages.some((m) => m.thread_ts === "100.3" && m.blocks));
    const first = messages.find((m) => m.thread_ts === "100.3" && m.blocks);
    assert.ok(first);
    assert.equal(first.text, expected);
    assert.deepEqual(first.blocks, [{ type: "markdown", text: expected }]);

    emit("session.text.delta", sessionID, "\nFinal xapp-synthetic-secret");
    emit("session.execution.succeeded", sessionID);
    await until(
      () =>
        db.prepare("SELECT state FROM replies WHERE message_ts = ?").get(first.ts)?.state ===
        "done",
    );
    const last = messages.filter((m) => m.ts === first.ts).at(-1);
    assert.ok(last);
    assert.equal(last.method, "chat.update");
    assert.equal(last.text, `${expected}\nFinal [redacted]`);
    assert.deepEqual(last.blocks, [{ type: "markdown", text: last.text }]);
    assert.ok(!JSON.stringify(messages).includes("synthetic-secret"));

    // Another member of the mapped channel continues the same session.
    send({ ts: "100.4", thread_ts: "100.3", user: "UOTHER", text: "continue without a mention" });
    await until(() => prompts.length === 2);
    assert.equal(prompts[1]?.text, "<@UOTHER>: continue without a mention");
    assert.equal(prompts[1]?.sessionID, sessionID);
    assert.equal(prompts[1]?.delivery, "queue");
    assert.equal(sessions.length, 1);

    // Approve once: another user's click is refused, the owner's click replies "once".
    permission("per_approve", sessionID, "rm -rf build");
    await until(() => prompted("per_approve"));
    assert.equal(prompted("per_approve")?.thread_ts, "100.3");
    click("approve", "UOTHER", prompted("per_approve"));
    await until(() =>
      messages.some(
        (m) => m.method === "chat.postEphemeral" && /Only the owner can approve/.test(m.text ?? ""),
      ),
    );
    assert.equal(replies.length, 0);
    click("approve", "UOWNER", prompted("per_approve"));
    await until(() => replies.length === 1);
    assert.deepEqual(replies[0], { sessionID, requestID: "per_approve", decision: "once" });
    await until(() =>
      messages.some((m) => m.method === "chat.update" && /Approved once/.test(m.text ?? "")),
    );

    permission("per_reject", sessionID, "git reset --hard");
    await until(() => prompted("per_reject"));
    click("reject", "UOWNER", prompted("per_reject"));
    await until(() => replies.length === 2);
    assert.deepEqual(replies[1], { sessionID, requestID: "per_reject", decision: "reject" });

    // A request without any mapped thread is refused at once; a subagent's request reaches its parent's thread.
    permission("per_orphan", "ses_orphan", "rm -rf /");
    await until(() => replies.length === 3);
    assert.deepEqual(replies[2], {
      sessionID: "ses_orphan",
      requestID: "per_orphan",
      decision: "reject",
    });
    assert.equal(prompted("per_orphan"), undefined);
    permission("per_child", "ses_child", "rm -rf src");
    await until(() => prompted("per_child"));
    assert.equal(prompted("per_child")?.thread_ts, "100.3");

    // Nobody answers: the bridge's 15-second expiry sweep rejects it.
    const deadline = Date.now() + 20_000;
    while (replies.length < 4 && Date.now() < deadline) await delay(100);
    assert.deepEqual(replies[3], {
      sessionID: "ses_child",
      requestID: "per_child",
      decision: "reject",
    });
    await until(() =>
      messages.some(
        (m) => m.method === "chat.update" && /nobody answered in time/.test(m.text ?? ""),
      ),
    );

    send({ ts: "100.5" });
    await until(() =>
      messages.some((m) => m.thread_ts === "100.5" && (m.text ?? "").startsWith("Queued: 1 ahead")),
    );
    assert.equal(prompts.length, 2);
    emit("session.execution.succeeded", sessionID);
    await until(() => prompts.length === 3);
    assert.notEqual(prompts[2]?.sessionID, sessionID);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threads").get()?.n, 2);

    await stop();
    await start();
    send({ ts: "100.6", thread_ts: "100.3", text: "continue after restart" });
    await until(() => prompts.length === 4);
    assert.equal(prompts[3]?.sessionID, sessionID);
    assert.equal(prompts[3]?.text, "<@UOWNER>: continue after restart");
    assert.equal(sessions.length, 2);
    // Prompts in one project run one at a time, so finish each run before the next prompt.
    emit("session.execution.succeeded", sessionID);

    // Another workspace's event is ignored.
    send({ ts: "100.7" }, "TOTHER");
    send({ ts: "100.8" });
    await until(() => prompts.length === 5);
    await delay(200);
    assert.equal(prompts.length, 5);
    assert.equal(sessions.length, 3);
    emit("session.execution.succeeded", prompts[4]?.sessionID ?? "");

    // Server passwords are redacted and broadcasts neutralised in agent output.
    emit("session.text.delta", sessionID, "<!channel> <!here|here> @everyone pw-synthetic-secret");
    emit("session.execution.succeeded", sessionID);
    await until(() =>
      messages.some((m) => m.thread_ts === "100.3" && m.text?.includes("everyone")),
    );
    const loudTs = messages.find(
      (m) => m.thread_ts === "100.3" && m.text?.includes("everyone"),
    )?.ts;
    const loud = messages.findLast((m) => m.ts === loudTs);
    assert.ok(loud);
    assert.equal(loud.text, "@\u200bchannel @\u200bhere @\u200beveryone [redacted]");
    assert.deepEqual(loud.blocks, [{ type: "markdown", text: loud.text }]);

    // The bot token goes only to the Slack files origin, without following redirects elsewhere.
    const file = (url_private: string) => [
      { name: "a.txt", mimetype: "text/plain", size: 2, url_private },
    ];
    send({ ts: "100.9", files: file(`${base}/files/ok.txt`) });
    await until(() => prompts.length === 6);
    assert.equal(prompts[5]?.files.length, 1);
    emit("session.execution.succeeded", prompts[5]?.sessionID ?? "");
    const refused: [string, string][] = [
      ["100.10", `${base.replace("127.0.0.1", "localhost")}/steal`],
      ["100.11", `${base}/files/redirect`],
    ];
    for (const [ts, url] of refused) {
      send({ ts, files: file(url) });
      await until(() => messages.some((m) => m.thread_ts === ts));
      assert.equal(
        messages.find((m) => m.thread_ts === ts)?.text,
        "The request failed. The details are in the bridge log.",
      );
    }
    assert.deepEqual(fetched, [
      { path: "/files/ok.txt", authorization: "Bearer xoxb-test" },
      { path: "/files/redirect", authorization: "Bearer xoxb-test" },
    ]);
    assert.match(logs(), /refused to download from localhost/);

    // Approval clicks must be well formed, from this workspace, and in the asking thread.
    emit("permission.asked", sessionID, undefined, {
      id: "per_1",
      sessionID,
      action: "shell",
      resources: ["rm -rf x"],
    });
    await until(() => prompted("per_1"));
    const value = prompted("per_1")?.blocks?.[1]?.elements?.[0]?.value;
    assert.ok(value);
    rawClick("{oops");
    rawClick(value, { team: "TOTHER" });
    rawClick(value, { thread: "100.5" });
    await until(() =>
      messages.some((m) => m.text === "This button does not belong to this thread."),
    );
    await delay(200);
    assert.equal(replies.length, 4);
    assert.match(logs(), /click ignored: malformed button value/);
    rawClick(value);
    await until(() => replies.length === 5);
    assert.deepEqual(replies[4], { sessionID, requestID: "per_1", decision: "once" });
    assert.ok(!JSON.stringify(messages).includes("synthetic-secret"));

    // Uploads land in the bridge-owned inbox, not through the agent's symlinks.
    const note = {
      name: "note.txt",
      mimetype: "text/plain",
      size: 13,
      url_private: `${base}/files/note.txt`,
    };
    send({
      ts: "100.12",
      thread_ts: "100.3",
      subtype: "file_share",
      text: "read this",
      files: [note],
    });
    await until(() => prompts.length === 7);
    assert.deepEqual(prompts[6]?.files, [
      { uri: "file:///inbox/100.3/note.txt", name: "note.txt" },
    ]);
    assert.equal(
      await readFile(join(state, "inbox", "test", "100.3", "note.txt"), "utf8"),
      "uploaded note",
    );
    assert.deepEqual(await readdir(outside), ["victim.txt"]);
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "untouched");
    assert.deepEqual(unexpected, []);
  },
);

await test(
  "Slack commands run OpenCode commands and control the thread's session",
  { timeout: 30_000 },
  async (t) => {
    const h = await harness(t);
    const reply = async (thread: string, pattern: RegExp) => {
      const matches = (m: Message) => m.thread_ts === thread && pattern.test(m.text ?? "");
      await h.until(() => h.messages.some(matches));
      return h.messages.findLast(matches)?.text ?? "";
    };

    h.send({ ts: "300.1", text: "<@UBOT> /stop" });
    await reply("300.1", /No session in this thread yet/);
    assert.equal(h.sessions.length, 0);

    h.send({ ts: "300.2", text: "<@UBOT> /review branch" });
    await h.until(() => h.calls.length === 1);
    const sessionID = h.sessions[0]?.id ?? "";
    assert.deepEqual(h.calls[0], {
      type: "command",
      sessionID,
      name: "review",
      text: "branch",
      files: [],
      delivery: "queue",
    });
    h.emit("session.text.delta", sessionID, "Review: looks good");
    h.emit("session.execution.succeeded", sessionID);
    await reply("300.2", /^Review: looks good$/);

    h.send({ ts: "300.3", thread_ts: "300.2", text: "<@UBOT> /model" });
    const list = await reply("300.2", /Available models/);
    assert.match(list, /Current model:\* `test\/test`/);
    assert.match(list, /`test\/test` \(images\) \(current\)/);
    assert.match(list, /`test\/text-only`\n/);
    assert.doesNotMatch(list, /other\/x/);

    h.send({ ts: "300.4", thread_ts: "300.2", text: "<@UBOT> /model other/x" });
    await reply("300.2", /`other\/x` is not available/);
    h.send({ ts: "300.5", thread_ts: "300.2", text: "<@UBOT> /model text-only" });
    await reply("300.2", /Model set to `test\/text-only` for this thread/);
    assert.deepEqual(
      h.calls.filter((c) => c.type === "model").map((c) => c.model),
      [{ providerID: "test", id: "text-only" }],
    );

    // The switched model cannot read images, so the upload is refused before download.
    h.send({
      ts: "300.6",
      thread_ts: "300.2",
      subtype: "file_share",
      text: "look",
      files: [
        {
          name: "shot.png",
          mimetype: "image/png",
          size: 10,
          url_private: `${h.base}/files/shot.png`,
        },
      ],
    });
    await reply("300.2", /test\/text-only cannot read images/);

    h.send({ ts: "300.7", thread_ts: "300.2", text: "<@UBOT> /stop" });
    await reply("300.2", /Stopped the current run/);
    h.send({ ts: "300.8", thread_ts: "300.2", text: "<@UBOT> /compact" });
    await reply("300.2", /Compaction requested/);
    assert.deepEqual(
      h.calls.slice(-2).map((c) => [c.type, c.sessionID]),
      [
        ["interrupt", sessionID],
        ["compact", sessionID],
      ],
    );

    h.send({ ts: "300.9", text: "<@UBOT> /model text-only" });
    await reply("300.9", /Model set to `test\/text-only`/);
    assert.deepEqual(h.sessions[1]?.model, { providerID: "test", id: "text-only" });

    h.send({ ts: "300.10", text: "<@UBOT> /tmp/log.txt is empty, why?" });
    await h.until(() => h.prompts.length === 1);
    assert.equal(h.prompts[0]?.text, "<@UOWNER>: /tmp/log.txt is empty, why?");
    assert.equal(h.calls.filter((c) => c.type === "command").length, 1);

    // A server command starts a run, so it waits behind the project's running prompt.
    h.send({ ts: "300.11", text: "<@UBOT> /review again" });
    await reply("300.11", /^Queued: 1 ahead/);
    assert.equal(h.calls.filter((c) => c.type === "command").length, 1);
    h.emit("session.execution.succeeded", h.prompts[0]?.sessionID ?? "");
    await h.until(() => h.calls.filter((c) => c.type === "command").length === 2);
    assert.equal(h.calls.at(-1)?.text, "again");
    assert.deepEqual(h.unexpected, []);
  },
);

await test(
  "/model as a thread's first message waits for OpenCode's model catalog",
  { timeout: 30_000 },
  async (t) => {
    const h = await harness(t);
    const reply = async (thread: string, pattern: RegExp) => {
      const matches = (m: Message) => m.thread_ts === thread && pattern.test(m.text ?? "");
      await h.until(() => h.messages.some(matches));
      return h.messages.findLast(matches)?.text ?? "";
    };

    h.catalog.emptyLists = 2;
    h.send({ ts: "400.1", text: "<@UBOT> /model" });
    const list = await reply("400.1", /Available models/);
    assert.match(list, /`test\/test` \(images\) \(current\)/);
    assert.match(list, /`test\/text-only`/);
    assert.equal(h.catalog.emptyLists, 0);

    // A catalog that never loads gets a retry hint instead of an empty list or a false refusal.
    h.catalog.emptyLists = 1000;
    h.send({ ts: "400.2", text: "<@UBOT> /model" });
    await reply("400.2", /model list is still loading/);
    h.send({ ts: "400.3", text: "<@UBOT> /model text-only" });
    await reply("400.3", /model list is still loading/);
    assert.equal(h.sessions.length, 0);
    assert.deepEqual(h.unexpected, []);
  },
);

// The event stream recorded from a real OpenCode 2.0.15 run (spike/v2/record.sh): a note, three tool steps
// (one failed, one behind an approval), and a final answer, with paths rewritten to /project.
const recorded = (await readFile(join(root, "tests/fixtures/opencode-progress-run.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) =>
    z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line)),
  );

await test(
  "a run shows a progress card above the answer, and reactions on the prompt",
  { timeout: 30_000 },
  async (t) => {
    const h = await harness(t);
    const thread = (ts: string) => h.messages.filter((m) => m.thread_ts === ts || m.ts === ts);
    const card = (ts: string) => {
      const post = h.messages.find((m) => m.thread_ts === ts && m.method === "chat.postMessage");
      return { post, last: h.messages.findLast((m) => m.ts === post?.ts) };
    };

    h.send({ ts: "400.1" });
    await h.until(() => h.prompts.length === 1);
    const sessionID = h.sessions[0]?.id ?? "";
    for (const { type, data } of recorded)
      h.emit(
        type,
        sessionID,
        undefined,
        anyCall.parse(JSON.parse(JSON.stringify(data).replaceAll("SESSION", sessionID))),
      );
    await h.until(() => h.reactions.includes("+white_check_mark@400.1"));
    await h.until(() => /Done/.test(card("400.1").last?.text ?? ""));

    const { post, last } = card("400.1");
    assert.equal(post?.text, "*Working…*");
    assert.match(last?.text ?? "", /^\*✓ Done\* · 4 steps · 0:0\d$/m);
    assert.deepEqual(last?.text?.split("\n").slice(1), [
      "✓ Read `README.md`",
      "✓ Searched the code",
      "✗ Read `missing.md`",
      "✓ Ran a command",
    ]);
    // The card was posted first, so the answer follows it; text blocks are separated by a blank line.
    const answer = thread("400.1").filter((m) => m.blocks?.[0]?.type === "markdown");
    assert.ok(h.messages.indexOf(post!) < h.messages.indexOf(answer[0]!));
    assert.equal(
      h.messages.findLast((m) => m.ts === answer[0]?.ts)?.text,
      "Let me check the readme first.\n\nTwo more checks.\n\nDone. The project has one readme and nothing else to report.",
    );
    // Thirteen tool and approval events reached the bridge, but the card is only edited a few times.
    assert.ok(
      h.messages.filter((m) => m.ts === post?.ts && m.method === "chat.update").length <= 3,
    );
    assert.deepEqual(h.reactions, ["+eyes@400.1", "-eyes@400.1", "+white_check_mark@400.1"]);
    assert.equal(
      h.db.prepare("SELECT state FROM replies WHERE message_ts = ?").get(post!.ts)?.state,
      "done",
    );

    // Tool input never reaches Slack: a path outside the project is not named, and commands are never shown.
    h.send({ ts: "400.2" });
    await h.until(() => h.prompts.length === 2);
    const second = h.sessions[1]?.id ?? "";
    h.emit("session.execution.started", second);
    h.emit("session.tool.input.started", second, undefined, {
      sessionID: second,
      id: "c1",
      name: "read",
    });
    h.emit("session.tool.called", second, undefined, {
      sessionID: second,
      id: "c1",
      input: { path: "/etc/pw-secret" },
    });
    h.emit("session.tool.input.started", second, undefined, {
      sessionID: second,
      id: "c2",
      name: "shell",
    });
    h.emit("session.tool.called", second, undefined, {
      sessionID: second,
      id: "c2",
      input: { command: "echo pw-secret" },
    });
    h.emit("session.execution.failed", second, undefined, {
      sessionID: second,
      error: { message: "boom" },
    });
    await h.until(() => h.reactions.includes("+x@400.2"));
    await h.until(() => /Failed/.test(card("400.2").last?.text ?? ""));
    assert.match(
      card("400.2").last?.text ?? "",
      /◌ Reading `a file outside the project`\n◌ Running a command$/,
    );
    assert.ok(!JSON.stringify(h.messages).includes("pw-secret"));

    // A run without tools leaves no card behind.
    h.send({ ts: "400.3" });
    await h.until(() => h.prompts.length === 3);
    const third = h.sessions[2]?.id ?? "";
    h.emit("session.execution.started", third);
    h.emit("session.text.delta", third, "Short answer.");
    h.emit("session.execution.succeeded", third);
    await h.until(() => h.messages.some((m) => m.method === "chat.delete"));
    assert.equal(h.messages.find((m) => m.method === "chat.delete")?.ts, card("400.3").post?.ts);
    assert.deepEqual(h.unexpected, []);
  },
);

await test("a failed progress update still posts and persists an approval", async (t) => {
  const h = await harness(t);
  h.send({ ts: "400.1" });
  await h.until(() => h.prompts.length === 1);
  const sessionID = h.sessions[0]?.id ?? "";
  h.emit("session.execution.started", sessionID);
  await h.until(() => h.messages.some((m) => m.text === "*Working…*"));
  const card = h.messages.find((m) => m.text === "*Working…*");
  assert.ok(card);
  h.emit("session.tool.input.started", sessionID, undefined, {
    sessionID,
    id: "tool_approval",
    name: "shell",
  });
  await h.until(() =>
    h.messages.some((m) => m.ts === card.ts && /Running a command/.test(m.text ?? "")),
  );
  await delay(1100);
  h.slackErrors.updateTs = card.ts;
  h.emit("permission.asked", sessionID, undefined, {
    id: "per_progress_failure",
    sessionID,
    action: "shell",
    resources: ["rm -rf build"],
    source: { id: "tool_approval" },
  });
  await h.until(() => h.prompted("per_progress_failure"));
  const approval = h.prompted("per_progress_failure");
  assert.ok(approval);
  assert.match(h.logs(), /progress update failed:.*message_not_found/);
  assert.equal(approval.thread_ts, "400.1");
  assert.deepEqual(
    {
      ...h.db
        .prepare("SELECT state, message_ts FROM approvals WHERE request_id = ?")
        .get("per_progress_failure"),
    },
    { state: "pending", message_ts: approval.ts },
  );
  h.click("approve", "UOWNER", approval);
  await h.until(() => h.replies.length === 1);
  assert.deepEqual(h.replies[0], {
    sessionID,
    requestID: "per_progress_failure",
    decision: "once",
  });
  assert.deepEqual(h.unexpected, []);
});

// Two fake OpenCode servers record which password reached them; Slack is never reached.
await test(
  "each channel's server gets its own password, and a reused password stops startup",
  { timeout: 20_000 },
  async (t) => {
    const work = await mkdtemp(join(tmpdir(), "slack-tag-passwords-"));
    const seen: Record<"A" | "B", string[]> = { A: [], B: [] };
    const servers = await Promise.all(
      (["A", "B"] as const).map(async (name) => {
        const server = createServer((req, res) => {
          seen[name].push(
            Buffer.from(
              (req.headers.authorization ?? "").replace("Basic ", ""),
              "base64",
            ).toString(),
          );
          res.writeHead(401).end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        return server;
      }),
    );
    t.after(async () => {
      for (const server of servers) server.close();
      await rm(work, { recursive: true, force: true });
    });
    await mkdir(join(work, "state"));
    const channel = (name: string, server: Server | undefined) => ({
      name,
      projectDir: join(work, "project"),
      opencodeUrl: `http://127.0.0.1:${server ? portOf(server) : 9}`,
      passwordEnv: `${name}_PASSWORD`,
      model: "test/test",
    });
    await writeFile(
      join(work, "state", "config.json"),
      JSON.stringify({
        ownerUserId: "UOWNER",
        channels: { CA: channel("A", servers[0]), CB: channel("B", servers[1]) },
      }),
    );
    async function run(passwords: Record<string, string>) {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--experimental-sqlite", join(root, "bridge/src/main.ts")],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: work,
            SLACK_TAG_CONFIG: join(work, "state", "config.json"),
            SLACK_API_URL: "http://127.0.0.1:9/api/",
            SLACK_BOT_TOKEN: "xoxb-test",
            SLACK_APP_TOKEN: "xapp-test",
            ...passwords,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let logs = "";
      child.stdout.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });
      const exit = once(child, "exit");
      for (let i = 0; i < 100 && child.exitCode === null && !logs.includes("channel CB"); i++)
        await delay(50);
      child.kill();
      await exit;
      return logs;
    }

    assert.match(
      await run({ A_PASSWORD: "alpha-secret", B_PASSWORD: "beta-secret" }),
      /channel CB \(B\) unavailable/,
    );
    assert.deepEqual([...new Set(seen.A)], ["opencode:alpha-secret"]);
    assert.deepEqual([...new Set(seen.B)], ["opencode:beta-secret"]);

    seen.B.length = 0;
    assert.match(
      await run({ A_PASSWORD: "same", B_PASSWORD: "same" }),
      /channel CB reuses another channel's server password/,
    );
    assert.match(await run({ A_PASSWORD: "only-a" }), /B_PASSWORD is required/);
    assert.deepEqual(seen.B, []);
  },
);

await test(
  "a project folder that is /, holds, or sits inside the bridge state folder stops startup",
  { timeout: 20_000 },
  async (t) => {
    const work = await mkdtemp(join(tmpdir(), "slack-tag-projectdir-"));
    const state = join(work, "state");
    await mkdir(state);
    t.after(() => rm(work, { recursive: true, force: true }));
    for (const projectDir of ["/", work, state, join(state, "project")]) {
      await writeFile(
        join(state, "config.json"),
        JSON.stringify({
          ownerUserId: "UOWNER",
          channels: {
            CA: {
              name: "a",
              projectDir,
              opencodeUrl: "http://127.0.0.1:9",
              passwordEnv: "A_PASSWORD",
              model: "test/test",
            },
          },
        }),
      );
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--experimental-sqlite", join(root, "bridge/src/main.ts")],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: work,
            SLACK_TAG_CONFIG: join(state, "config.json"),
            A_PASSWORD: "a",
            SLACK_BOT_TOKEN: "xoxb-test",
            SLACK_APP_TOKEN: "xapp-test",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let logs = "";
      child.stderr.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });
      await once(child, "exit");
      assert.notEqual(child.exitCode, 0);
      assert.match(logs, /channel CA projectDir must not be \/, contain, or sit inside/);
    }
  },
);

await test(
  "worktree-enabled channel: new threads get their own jeff/<slug> worktree and run concurrently",
  { timeout: 30_000 },
  async (t) => {
    const h = await harness(t, {
      worktrees: true,
      legacy: [
        { thread_ts: "900.1", session_id: "ses_legacy1" },
        { thread_ts: "901.1", session_id: "ses_legacy2" },
      ],
    });
    const dirOf = (sessionID: string | undefined) =>
      h.sessions.find((s) => s.id === sessionID)?.location.directory;
    const queued = (thread: string) =>
      h.messages.some((m) => m.thread_ts === thread && (m.text ?? "").startsWith("Queued"));

    // New thread A starts a session in its own worktree directory, with no "Queued" reply.
    h.send({ ts: "500.1" });
    await h.until(() => h.prompts.length === 1);
    assert.deepEqual(h.worktreeSlugs, ["500-1"]);
    assert.equal(dirOf(h.prompts[0]?.sessionID), "/worktrees/500-1");
    const sessionA = h.prompts[0]?.sessionID;

    // New thread B runs concurrently: its prompt is delivered while A is still running, no "Queued".
    h.send({ ts: "500.2" });
    await h.until(() => h.prompts.length === 2);
    assert.deepEqual([...h.worktreeSlugs].sort(), ["500-1", "500-2"]);
    assert.equal(dirOf(h.prompts[1]?.sessionID), "/worktrees/500-2");
    assert.notEqual(h.prompts[1]?.sessionID, sessionA);
    assert.ok(!queued("500.1") && !queued("500.2"));

    // A second message in thread A waits for A's running prompt: the same thread stays in order.
    h.send({ ts: "500.3", thread_ts: "500.1", text: "second in A" });
    await h.until(() => queued("500.1"));
    assert.match(
      h.messages.findLast((m) => m.thread_ts === "500.1")?.text ?? "",
      /Queued: 1 ahead/,
    );
    await delay(200);
    assert.equal(h.prompts.length, 2);
    h.emit("session.execution.succeeded", sessionA ?? "");
    await h.until(() => h.prompts.length === 3);
    assert.equal(h.prompts[2]?.sessionID, sessionA);
    assert.equal(h.prompts[2]?.text, "<@UOWNER>: second in A");

    // An old mapping keeps /project and never creates a worktree; two such threads share the /project queue.
    h.send({ ts: "900.2", thread_ts: "900.1", text: "legacy A" });
    await h.until(() => h.prompts.length === 4);
    assert.equal(h.prompts[3]?.sessionID, "ses_legacy1");
    h.send({ ts: "901.2", thread_ts: "901.1", text: "legacy B" });
    await h.until(() => queued("901.1"));
    await delay(200);
    assert.equal(h.prompts.length, 4);
    assert.deepEqual([...h.worktreeSlugs].sort(), ["500-1", "500-2"]);
    assert.equal(h.sessions.length, 2);
    assert.deepEqual(h.unexpected, []);
  },
);

await test("a worktree-enabled channel falls back to /project when the server refuses", async (t) => {
  const h = await harness(t, { worktrees: true });
  // The simulated server reports it cannot create a worktree safely (project config not disabled).
  h.worktree.fails = true;
  h.send({ ts: "600.1" });
  await h.until(() => h.prompts.length === 1);
  assert.equal(h.sessions[0]?.location.directory, "/project");
  assert.match(h.logs(), /worktree unavailable, using \/project/);
  assert.deepEqual(h.unexpected, []);
});
