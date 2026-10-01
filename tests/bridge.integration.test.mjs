import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"

const root = fileURLToPath(new URL("../", import.meta.url))

// Start the production process, replace only external services, and inspect messages plus persisted state.
async function harness(t) {
  const work = await mkdtemp(join(tmpdir(), "slack-tag-integration-"))
  const messages = []
  const sessions = []
  const prompts = []
  const calls = []
  const model = (providerID, id, input) => ({ id, modelID: id, providerID, name: id, enabled: true, capabilities: { input } })
  const models = [model("test", "test", ["text", "image"]), model("test", "text-only", ["text"]), model("other", "x", ["text"])]
  const unexpected = []
  const streams = new Set()
  let child, socket, stream, db
  let logs = ""
  let sequence = 0
  let base

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const args = req.headers["content-type"]?.includes("json")
      ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw))
    if (typeof args.blocks === "string") args.blocks = JSON.parse(args.blocks)
    const path = new URL(req.url, base).pathname
    const json = (value) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(value))
    }
    if (path === "/api/event") {
      stream = res
      streams.add(res)
      res.on("close", () => streams.delete(res))
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.flushHeaders()
      return
    }
    if (path === "/api/rpc/slack-tag/status") return json({ output: { pluginVersion: "test", policyVersion: 2 } })
    if (path === "/api/session" && req.method === "POST") {
      const id = `ses_test${sessions.length + 1}`
      sessions.push({ id, ...args })
      return json({ data: { id } })
    }
    const prompt = path.match(/^\/api\/session\/([^/]+)\/prompt$/)
    if (prompt) {
      prompts.push({ sessionID: prompt[1], ...args })
      return json({})
    }
    if (path === "/api/model") return json({ data: models })
    const call = path.match(/^\/api\/session\/([^/]+)(?:\/(command|interrupt|compact|model))?$/)
    if (call && req.method === "GET" && !call[2]) return json({ data: sessions.find((s) => s.id === call[1]) })
    if (call?.[2]) {
      calls.push({ type: call[2], sessionID: call[1], ...args })
      if (call[2] === "model") sessions.find((s) => s.id === call[1]).model = args.model
      if (call[2] === "interrupt") return json({ interrupted: true })
      if (call[2] === "compact") return json({ data: {} })
      res.writeHead(204)
      return res.end()
    }
    if (/^\/api\/session\/[^/]+\/permission$/.test(path)) return json({ data: [] })
    if (path === "/api/auth.test") return json({ ok: true, user_id: "UBOT", team_id: "TTEST" })
    if (path === "/api/apps.connections.open") return json({ ok: true, url: `${base.replace("http:", "ws:")}/socket` })
    if (["/api/chat.postMessage", "/api/chat.update", "/api/chat.postEphemeral"].includes(path)) {
      const ts = args.ts ?? `200.${++sequence}`
      messages.push({ method: path.split("/").at(-1), ...args, ts })
      return json({ ok: true, ts, channel: args.channel })
    }
    unexpected.push(`${req.method} ${path}`)
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server, path: "/socket" })
  wss.on("connection", (ws) => {
    socket = ws
    ws.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "ATEST" } }))
  })

  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill()
      await exited
    }
  }
  t.after(async () => {
    await stop()
    db?.close()
    for (const ws of wss.clients) ws.terminate()
    for (const res of streams) res.end()
    wss.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(work, { recursive: true, force: true })
  })
  async function until(check) {
    const deadline = Date.now() + 5000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for bridge outcome.\n${logs}`)
      await delay(20)
    }
  }
  async function start() {
    socket = stream = undefined
    logs = ""
    child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", join(root, "bridge/src/main.ts")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: work,
        SLACK_TAG_CONFIG: join(work, "config.json"),
        SLACK_API_URL: `${base}/api/`,
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        OPENCODE_SERVER_PASSWORD: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (chunk) => { logs += chunk })
    child.stderr.on("data", (chunk) => { logs += chunk })
    await until(() => socket && stream && logs.includes("bridge connected"))
  }
  function send(event) {
    const id = `event-${++sequence}`
    socket.send(JSON.stringify({
      envelope_id: id, type: "events_api", accepts_response_payload: false,
      payload: { type: "event_callback", team_id: "TTEST", api_app_id: "ATEST", event_id: id,
        event: { type: "message", channel: "CTEST", user: "UOWNER", text: "<@UBOT> start", ...event } },
    }))
  }
  function emit(type, sessionID, delta) {
    stream.write(`data: ${JSON.stringify({ type, data: { sessionID, delta } })}\n\n`)
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(work, "config.json"), JSON.stringify({
    ownerUserId: "UOWNER",
    channels: { CTEST: { name: "test", projectDir: work, serverDir: "/project", opencodeUrl: base, model: "test/test" } },
  }))
  await start()
  db = new DatabaseSync(join(work, "slack-tag.sqlite"), { readOnly: true })
  return { messages, sessions, prompts, calls, unexpected, base, db, until, start, stop, send, emit }
}

test("Slack routing, queued prompts, Markdown replies, and session persistence", { timeout: 30_000 }, async (t) => {
  const { messages, sessions, prompts, unexpected, db, until, start, stop, send, emit } = await harness(t)
  send({ ts: "100.1", user: "UOTHER" })
  await until(() => messages.some((m) => m.method === "chat.postEphemeral"))
  assert.equal(messages[0].user, "UOTHER")
  assert.match(messages[0].text, /Only the owner/)
  assert.equal(sessions.length, 0)
  assert.equal(prompts.length, 0)

  send({ ts: "100.2", channel: "CUNMAPPED" })
  await until(() => messages.some((m) => m.text === "This channel is not mapped to a project."))
  assert.equal(sessions.length, 0)

  send({ ts: "100.3" })
  await until(() => prompts.length === 1)
  assert.equal(sessions[0].location.directory, "/project")
  assert.deepEqual(sessions[0].model, { providerID: "test", id: "test" })
  const sessionID = sessions[0].id
  assert.equal(prompts[0].text, "start")
  assert.equal(prompts[0].delivery, "queue")

  const sample = "# Heading\n\n**bold** and `inline`\n- item\n[link](https://example.com)\n```js\nconst n = 1\n```\nxoxb-synthetic-secret"
  const expected = sample.replace("xoxb-synthetic-secret", "[redacted]")
  emit("session.text.delta", sessionID, sample)
  await until(() => messages.some((m) => m.thread_ts === "100.3" && m.blocks))
  const first = messages.find((m) => m.thread_ts === "100.3" && m.blocks)
  assert.equal(first.text, expected)
  assert.deepEqual(first.blocks, [{ type: "markdown", text: expected }])

  emit("session.text.delta", sessionID, "\nFinal xapp-synthetic-secret")
  emit("session.execution.succeeded", sessionID)
  await until(() => db.prepare("SELECT state FROM replies WHERE message_ts = ?").get(first.ts)?.state === "done")
  const last = messages.filter((m) => m.ts === first.ts).at(-1)
  assert.equal(last.method, "chat.update")
  assert.equal(last.text, `${expected}\nFinal [redacted]`)
  assert.deepEqual(last.blocks, [{ type: "markdown", text: last.text }])
  assert.ok(!JSON.stringify(messages).includes("synthetic-secret"))

  send({ ts: "100.4", thread_ts: "100.3", text: "continue without a mention" })
  await until(() => prompts.length === 2)
  assert.equal(prompts[1].sessionID, sessionID)
  assert.equal(prompts[1].delivery, "queue")
  assert.equal(sessions.length, 1)
  send({ ts: "100.5" })
  await until(() => prompts.length === 3)
  assert.notEqual(prompts[2].sessionID, sessionID)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threads").get().n, 2)

  await stop()
  await start()
  send({ ts: "100.6", thread_ts: "100.3", text: "continue after restart" })
  await until(() => prompts.length === 4)
  assert.equal(prompts[3].sessionID, sessionID)
  assert.equal(prompts[3].text, "continue after restart")
  assert.equal(sessions.length, 2)
  assert.deepEqual(unexpected, [])
})

test("Slack commands run OpenCode commands and control the thread's session", { timeout: 30_000 }, async (t) => {
  const h = await harness(t)
  const reply = async (thread, pattern) => {
    await h.until(() => h.messages.some((m) => m.thread_ts === thread && pattern.test(m.text)))
    return h.messages.findLast((m) => m.thread_ts === thread && pattern.test(m.text)).text
  }

  h.send({ ts: "300.1", text: "<@UBOT> /stop" })
  await reply("300.1", /No session in this thread yet/)
  assert.equal(h.sessions.length, 0)

  h.send({ ts: "300.2", text: "<@UBOT> /review branch" })
  await h.until(() => h.calls.length === 1)
  const sessionID = h.sessions[0].id
  assert.deepEqual(h.calls[0], { type: "command", sessionID, name: "review", text: "branch", files: [], delivery: "queue" })
  h.emit("session.text.delta", sessionID, "Review: looks good")
  h.emit("session.execution.succeeded", sessionID)
  await reply("300.2", /^Review: looks good$/)

  h.send({ ts: "300.3", thread_ts: "300.2", text: "<@UBOT> /model" })
  const list = await reply("300.2", /Available models/)
  assert.match(list, /Current model:\* `test\/test`/)
  assert.match(list, /`test\/test` \(images\) \(current\)/)
  assert.match(list, /`test\/text-only`\n/)
  assert.doesNotMatch(list, /other\/x/)

  h.send({ ts: "300.4", thread_ts: "300.2", text: "<@UBOT> /model other/x" })
  await reply("300.2", /`other\/x` is not available/)
  h.send({ ts: "300.5", thread_ts: "300.2", text: "<@UBOT> /model text-only" })
  await reply("300.2", /Model set to `test\/text-only` for this thread/)
  assert.deepEqual(h.calls.filter((c) => c.type === "model").map((c) => c.model), [{ providerID: "test", id: "text-only" }])

  // The switched model cannot read images, so the upload is refused before download.
  h.send({ ts: "300.6", thread_ts: "300.2", subtype: "file_share", text: "look",
    files: [{ name: "shot.png", mimetype: "image/png", size: 10, url_private: `${h.base}/files/shot.png` }] })
  await reply("300.2", /test\/text-only cannot read images/)

  h.send({ ts: "300.7", thread_ts: "300.2", text: "<@UBOT> /stop" })
  await reply("300.2", /Stopped the current run/)
  h.send({ ts: "300.8", thread_ts: "300.2", text: "<@UBOT> /compact" })
  await reply("300.2", /Compaction requested/)
  assert.deepEqual(h.calls.slice(-2).map((c) => [c.type, c.sessionID]), [["interrupt", sessionID], ["compact", sessionID]])

  h.send({ ts: "300.9", text: "<@UBOT> /model text-only" })
  await reply("300.9", /Model set to `test\/text-only`/)
  assert.deepEqual(h.sessions[1].model, { providerID: "test", id: "text-only" })

  h.send({ ts: "300.10", text: "<@UBOT> /tmp/log.txt is empty, why?" })
  await h.until(() => h.prompts.length === 1)
  assert.equal(h.prompts[0].text, "/tmp/log.txt is empty, why?")
  assert.equal(h.calls.filter((c) => c.type === "command").length, 1)
  assert.deepEqual(h.unexpected, [])
})
