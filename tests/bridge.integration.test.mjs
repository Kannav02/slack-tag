import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
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
test("Slack routing, queued prompts, Markdown replies, and session persistence", { timeout: 30_000 }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), "slack-tag-integration-"))
  const messages = []
  const sessions = []
  const prompts = []
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
    if (path === "/api/model") return json({ data: [{ providerID: "test", id: "test", capabilities: { input: ["text"] } }] })
    if (path === "/files/note.txt") return res.end("uploaded note")
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
        SLACK_TAG_CONFIG: join(state, "config.json"),
        SLACK_API_URL: `${base}/api/`,
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        TEST_SERVER_PASSWORD: "test",
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
  // The agent controls the project folder: point the old inbox and .git/info/exclude outside it.
  const project = join(work, "project")
  const state = join(work, "state")
  await mkdir(state)
  const outside = join(work, "outside")
  await mkdir(join(project, ".slack-tag"), { recursive: true })
  await mkdir(join(project, ".git", "info"), { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, "victim.txt"), "untouched")
  await symlink(outside, join(project, ".slack-tag", "inbox"))
  await symlink(join(outside, "victim.txt"), join(project, ".git", "info", "exclude"))
  await writeFile(join(state, "config.json"), JSON.stringify({
    ownerUserId: "UOWNER",
    channels: { CTEST: { name: "test", projectDir: project, serverDir: "/project", opencodeUrl: base, passwordEnv: "TEST_SERVER_PASSWORD", model: "test/test" } },
  }))
  await start()
  db = new DatabaseSync(join(state, "slack-tag.sqlite"), { readOnly: true })

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

  const file = { name: "note.txt", mimetype: "text/plain", size: 13, url_private: `${base}/files/note.txt` }
  send({ ts: "100.7", thread_ts: "100.3", subtype: "file_share", text: "read this", files: [file] })
  await until(() => prompts.length === 5)
  assert.deepEqual(prompts[4].files, [{ uri: "file:///inbox/100.3/note.txt", name: "note.txt" }])
  assert.equal(await readFile(join(state, "inbox", "test", "100.3", "note.txt"), "utf8"), "uploaded note")
  assert.deepEqual(await readdir(outside), ["victim.txt"])
  assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "untouched")
  assert.deepEqual(unexpected, [])
})

// Two fake OpenCode servers record which password reached them; Slack is never reached.
test("each channel's server gets its own password, and a reused password stops startup", { timeout: 20_000 }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), "slack-tag-passwords-"))
  const seen = { A: [], B: [] }
  const servers = await Promise.all(Object.keys(seen).map(async (name) => {
    const server = createServer((req, res) => {
      seen[name].push(Buffer.from((req.headers.authorization ?? "").replace("Basic ", ""), "base64").toString())
      res.writeHead(401).end()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    return server
  }))
  t.after(async () => {
    for (const server of servers) server.close()
    await rm(work, { recursive: true, force: true })
  })
  await mkdir(join(work, "state"))
  const channel = (name, server) => ({ name, projectDir: join(work, "project"), opencodeUrl: `http://127.0.0.1:${server.address().port}`, passwordEnv: `${name}_PASSWORD`, model: "test/test" })
  await writeFile(join(work, "state", "config.json"), JSON.stringify({ ownerUserId: "UOWNER", channels: { CA: channel("A", servers[0]), CB: channel("B", servers[1]) } }))
  async function run(passwords) {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", join(root, "bridge/src/main.ts")], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: work, SLACK_TAG_CONFIG: join(work, "state", "config.json"), SLACK_API_URL: "http://127.0.0.1:9/api/",
        SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test", ...passwords },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let logs = ""
    child.stdout.on("data", (chunk) => { logs += chunk })
    child.stderr.on("data", (chunk) => { logs += chunk })
    const exit = once(child, "exit")
    for (let i = 0; i < 100 && child.exitCode === null && !logs.includes("channel CB"); i++) await delay(50)
    child.kill()
    await exit
    return logs
  }

  assert.match(await run({ A_PASSWORD: "alpha-secret", B_PASSWORD: "beta-secret" }), /channel CB \(B\) unavailable/)
  assert.deepEqual([...new Set(seen.A)], ["opencode:alpha-secret"])
  assert.deepEqual([...new Set(seen.B)], ["opencode:beta-secret"])

  seen.B.length = 0
  assert.match(await run({ A_PASSWORD: "same", B_PASSWORD: "same" }), /channel CB reuses another channel's server password/)
  assert.match(await run({ A_PASSWORD: "only-a" }), /B_PASSWORD is required/)
  assert.deepEqual(seen.B, [])
})

test("a project folder that is /, holds, or sits inside the bridge state folder stops startup", { timeout: 20_000 }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), "slack-tag-projectdir-"))
  const state = join(work, "state")
  await mkdir(state)
  t.after(() => rm(work, { recursive: true, force: true }))
  for (const projectDir of ["/", work, state, join(state, "project")]) {
    await writeFile(join(state, "config.json"), JSON.stringify({ ownerUserId: "UOWNER", channels: {
      CA: { name: "a", projectDir, opencodeUrl: "http://127.0.0.1:9", passwordEnv: "A_PASSWORD", model: "test/test" } } }))
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", join(root, "bridge/src/main.ts")], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: work, SLACK_TAG_CONFIG: join(state, "config.json"), A_PASSWORD: "a",
        SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let logs = ""
    child.stderr.on("data", (chunk) => { logs += chunk })
    const [code] = await once(child, "exit")
    assert.notEqual(code, 0)
    assert.match(logs, /channel CA projectDir must not be \/, contain, or sit inside/)
  }
})
