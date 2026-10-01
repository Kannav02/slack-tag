import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"

const root = fileURLToPath(new URL("../", import.meta.url))

// The real bridge and prepare-project.sh run; Slack, OpenCode and the docker CLI are stand-ins.
test("registering a project folder from Slack", { timeout: 30_000 }, async (t) => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "slack-tag-register-")))
  const code = join(work, "code")
  const envFile = join(work, "projects", "app-one.env")
  const messages = []
  const sessions = []
  const prompts = []
  const streams = new Set()
  let child, socket
  let logs = ""
  let sequence = 0
  let base

  const projectPassword = async () => (await readFile(envFile, "utf8")).match(/SLACK_TAG_PASSWORD=(\w+)/)?.[1]
  const handler = async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const args = req.headers["content-type"]?.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw))
    if (typeof args.blocks === "string") args.blocks = JSON.parse(args.blocks)
    const path = new URL(req.url, base).pathname
    const json = (value) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(value))
    }
    if (path.startsWith("/api/") && !path.includes(".")) {
      // The registered project's OpenCode server accepts only that project's password.
      const password = await projectPassword().catch(() => undefined)
      if (!password || req.headers.authorization !== "Basic " + Buffer.from(`opencode:${password}`).toString("base64")) {
        res.writeHead(401)
        return res.end()
      }
    }
    if (path === "/api/event") {
      streams.add(res)
      res.on("close", () => streams.delete(res))
      res.writeHead(200, { "content-type": "text/event-stream" })
      return res.flushHeaders()
    }
    if (path === "/api/rpc/slack-tag/status") return json({ output: { pluginVersion: "test", policyVersion: 2 } })
    if (path === "/api/session" && req.method === "POST") {
      sessions.push(args)
      return json({ data: { id: `ses_${sessions.length}` } })
    }
    if (/^\/api\/session\/[^/]+\/prompt$/.test(path)) {
      prompts.push(args)
      return json({})
    }
    if (/^\/api\/session\/[^/]+\/permission$/.test(path)) return json({ data: [] })
    if (path === "/api/auth.test") return json({ ok: true, user_id: "UBOT", team_id: "TTEST" })
    if (path === "/api/apps.connections.open") return json({ ok: true, url: `${base.replace("http:", "ws:")}/socket` })
    const ts = args.ts ?? `200.${++sequence}`
    messages.push({ method: path.split("/").at(-1), ...args, ts })
    json({ ok: true, ts, channel: args.channel })
  }
  // Slack is served from the start; the project's OpenCode only once `docker compose up` succeeds.
  const server = createServer(handler)
  const opencode = createServer(handler)
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
    for (const ws of wss.clients) ws.terminate()
    for (const res of streams) res.end()
    wss.close()
    for (const s of [server, opencode]) {
      s.closeAllConnections()
      if (s.listening) await new Promise((resolve) => s.close(resolve))
    }
    await rm(work, { recursive: true, force: true })
  })
  async function until(check) {
    const deadline = Date.now() + 8000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for bridge outcome.\n${logs}\n${JSON.stringify(messages, null, 1)}`)
      await delay(20)
    }
  }
  async function start() {
    socket = undefined
    logs = ""
    child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", join(root, "bridge/src/main.ts")], {
      cwd: root,
      env: {
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        HOME: work,
        SLACK_TAG_CONFIG: join(work, "config.json"),
        SLACK_API_URL: `${base}/api/`,
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        OPENCODE_SERVER_PASSWORD: "shared",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (chunk) => { logs += chunk })
    child.stderr.on("data", (chunk) => { logs += chunk })
    await until(() => socket && logs.includes("bridge connected"))
  }
  function send(type, payload) {
    const id = `event-${++sequence}`
    socket.send(JSON.stringify({ envelope_id: id, type, accepts_response_payload: false, payload }))
  }
  const mention = (event) => send("events_api", {
    type: "event_callback", team_id: "TTEST", api_app_id: "ATEST", event_id: `ev-${sequence}`,
    event: { type: "message", channel: "CNEW", user: "UOWNER", text: "<@UBOT> register", ts: `100.${sequence}`, ...event },
  })
  const choose = (value, user = "UOWNER") => send("interactive", {
    type: "block_actions", user: { id: user }, team: { id: "TTEST" }, channel: { id: "CNEW" }, api_app_id: "ATEST", trigger_id: "t",
    message: { ts: offerTs, thread_ts: "100.1" }, container: { type: "message", message_ts: offerTs, channel_id: "CNEW" },
    actions: [{ type: "static_select", action_id: "register_folder", block_id: "b", selected_option: { value }, action_ts: "1" }],
  })
  const status = () => messages.filter((m) => m.ts === offerTs).at(-1)?.text ?? ""
  const dockerCalls = async () => (await readFile(join(work, "docker.log"), "utf8").catch(() => "")).split("\n").filter(Boolean)

  await mkdir(join(work, "bin"))
  await writeFile(join(work, "bin", "docker"), `#!/bin/sh\necho "$*" >> "${work}/docker.log"\nenv > "${work}/docker.env"\n[ -e "${work}/fail" ] && { echo "port is already allocated" >&2; exit 1; }\nexit 0\n`)
  await chmod(join(work, "bin", "docker"), 0o755)
  for (const dir of ["app-one", "taken", ".hidden"]) await mkdir(join(code, dir), { recursive: true })
  await writeFile(join(code, "notes.txt"), "not a folder")
  await symlink(work, join(code, "link"))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
  await new Promise((resolve) => opencode.listen(0, "127.0.0.1", resolve))
  const port = opencode.address().port
  await new Promise((resolve) => opencode.close(resolve))
  await writeFile(join(work, "config.json"), JSON.stringify({
    ownerUserId: "UOWNER",
    onboarding: { projectsRoot: code, model: "test/test", firstPort: port },
    channels: { CTAKEN: { name: "taken", projectDir: join(code, "taken"), serverDir: "/project", opencodeUrl: "http://127.0.0.1:1", model: "test/test" } },
  }))
  await start()

  // Only unregistered, real folders are offered.
  mention({ ts: "100.1" })
  await until(() => messages.some((m) => m.blocks?.[1]?.elements?.[0]?.action_id === "register_folder"))
  const offer = messages.find((m) => m.blocks?.[1])
  const offerTs = offer.ts
  assert.equal(offer.thread_ts, "100.1")
  assert.deepEqual(offer.blocks[1].elements[0].options.map((o) => o.value), ["app-one"])

  choose("app-one", "UOTHER")
  await until(() => messages.some((m) => m.method === "chat.postEphemeral"))
  assert.match(messages.find((m) => m.method === "chat.postEphemeral").text, /Only the owner/)

  choose("../taken")
  await until(() => status().includes("is not a folder"))
  assert.deepEqual(await dockerCalls(), [])

  // A failed start reports the step, and the retry reuses the same port and password.
  await writeFile(join(work, "fail"), "")
  choose("app-one")
  await until(() => status().includes("❌"))
  assert.match(status(), /✅ Folder prepared\n❌ Starting the container failed: port is already allocated/)
  const firstEnv = await readFile(envFile, "utf8")
  await rm(join(work, "fail"))
  choose("app-one")
  await until(async () => (await dockerCalls()).length === 2)
  await new Promise((resolve) => opencode.listen(port, "127.0.0.1", resolve))
  await until(() => status().includes("Connected"))
  assert.equal(await readFile(envFile, "utf8"), firstEnv)

  const calls = await dockerCalls()
  assert.equal(calls.length, 2)
  assert.equal(calls[1], `compose -p slack-tag-app-one -f ${join(root, "deploy/project.yaml")} --env-file ${envFile} up -d`)
  const dockerEnv = await readFile(join(work, "docker.env"), "utf8")
  assert.doesNotMatch(dockerEnv, /xoxb-test|xapp-test|OPENCODE_SERVER_PASSWORD/)
  assert.equal((await stat(envFile)).mode & 0o777, 0o600)
  const password = await projectPassword()
  assert.match(password, /^[0-9a-f]{48}$/)
  assert.match(firstEnv, new RegExp(`SLACK_TAG_PROJECT=${join(code, "app-one")}\nSLACK_TAG_PORT=${port}\n`))
  await stat(join(code, "app-one", ".slack-tag", "inbox"))
  await stat(join(code, "app-one", "opencode.json"))
  await stat(join(code, "app-one", ".git", "config"))

  const saved = JSON.parse(await readFile(join(work, "config.json"), "utf8"))
  assert.equal((await stat(join(work, "config.json"))).mode & 0o777, 0o600)
  assert.deepEqual(saved.channels.CNEW, { name: "app-one", projectDir: join(code, "app-one"), serverDir: "/project", opencodeUrl: `http://127.0.0.1:${port}`, model: "test/test", password })
  assert.ok(saved.channels.CTAKEN)

  // The new channel works without a restart, and again after one.
  mention({ ts: "100.50", text: "<@UBOT> hello" })
  await until(() => prompts.length === 1)
  assert.equal(sessions[0].location.directory, "/project")
  assert.equal(prompts[0].text, "hello")
  await stop()
  await start()
  mention({ ts: "100.60", text: "<@UBOT> after restart" })
  await until(() => prompts.length === 2)
  assert.equal(prompts[1].text, "after restart")
  assert.match(logs, /channel CNEW \(app-one\) ready/)
})
