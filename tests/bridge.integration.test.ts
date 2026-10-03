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
async function harness(t: TestContext) {
  const work = await mkdtemp(join(tmpdir(), "slack-tag-integration-"));
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
  const unexpected: string[] = [];
  const replies: Record<string, unknown>[] = [];
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
    if (path === "/api/model") return json({ data: models });
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
    if (["/api/chat.postMessage", "/api/chat.update", "/api/chat.postEphemeral"].includes(path)) {
      const slack = slackCall.parse(args);
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
        },
      },
    }),
  );
  await start();
  const db = new DatabaseSync(join(state, "slack-tag.sqlite"), { readOnly: true });
  t.after(() => db.close());
  return {
    state,
    project,
    outside,
    base,
    db,
    messages,
    sessions,
    prompts,
    calls,
    replies,
    fetched,
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
    send({ ts: "100.1", user: "UOTHER" });
    await until(() => messages.some((m) => m.method === "chat.postEphemeral"));
    assert.equal(messages[0]?.user, "UOTHER");
    assert.match(messages[0]?.text ?? "", /Only the owner/);
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
    assert.equal(prompts[0]?.text, "start");
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

    send({ ts: "100.4", thread_ts: "100.3", text: "continue without a mention" });
    await until(() => prompts.length === 2);
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
    assert.equal(prompts[3]?.text, "continue after restart");
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
    assert.equal(h.prompts[0]?.text, "/tmp/log.txt is empty, why?");
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
