// A local stand-in for Slack, for demos without a workspace. It serves the Web API methods the
// bridge calls, a Socket Mode websocket, and a browser page of two channels. Not for production.
import { createServer } from "node:http"
import { readdirSync } from "node:fs"
import { createRequire } from "node:module"

const { WebSocketServer } = createRequire(new URL("../bridge/package.json", import.meta.url))("ws")
const port = Number(process.env.FAKE_SLACK_PORT ?? 3000)
const projectDir = process.env.DEMO_PROJECT
const USERS = { UOWNER: "Kannav (owner)", UOTHER: "Other user", UBOT: "OpenCode" }
const CHANNELS = { CDEMO: "demo", CUNMAPPED: "unmapped" }
const messages = []
const files = new Map()
let seq = 0
let socket
const newTs = () => `${Math.floor(Date.now() / 1000)}.${String(++seq).padStart(6, "0")}`
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function send(type, payload) {
  const envelope = { envelope_id: `env-${++seq}`, type, accepts_response_payload: false, payload }
  if (socket) socket.send(JSON.stringify(envelope))
}

const api = {
  "auth.test": () => ({ user_id: "UBOT", bot_id: "BBOT", user: "opencode", team_id: "TDEMO", team: "Demo" }),
  "apps.connections.open": () => ({ url: `ws://127.0.0.1:${port}/socket` }),
  "chat.postMessage": (a) => {
    const m = { ts: newTs(), channel: a.channel, thread_ts: a.thread_ts, user: "UBOT", text: a.text, blocks: a.blocks, edits: 0 }
    messages.push(m)
    return { ts: m.ts, channel: m.channel }
  },
  "chat.update": (a) => {
    const m = messages.find((x) => x.ts === a.ts)
    if (!m) return { ok: false, error: "message_not_found" }
    Object.assign(m, { text: a.text, blocks: a.blocks, edits: m.edits + 1 })
    return { ts: m.ts, channel: m.channel }
  },
  "chat.postEphemeral": (a) => {
    messages.push({ ts: newTs(), channel: a.channel, thread_ts: a.thread_ts, user: "UBOT", text: a.text, ephemeralFor: a.user, edits: 0 })
    return { message_ts: String(seq) }
  },
}

function postFromUi({ user, channel, text, thread_ts, file }) {
  const m = { ts: newTs(), channel, user, thread_ts, text: escape(text).replace(/@OpenCode\b/g, "<@UBOT>"), edits: 0 }
  const event = { type: "message", channel, user, text: m.text, ts: m.ts, ...(thread_ts ? { thread_ts } : {}) }
  if (file) {
    const id = `F${++seq}`
    files.set(id, { ...file, data: Buffer.from(file.data, "base64") })
    m.files = event.files = [{ id, name: file.name, mimetype: file.mimetype, size: files.get(id).data.length, url_private: `http://127.0.0.1:${port}/files/${id}` }]
    event.subtype = "file_share"
  }
  messages.push(m)
  send("events_api", { type: "event_callback", team_id: "TDEMO", api_app_id: "ADEMO", event_id: `Ev${seq}`, event_time: Date.now() / 1000, event })
}

function clickFromUi({ user, ts, action_id }) {
  const m = messages.find((x) => x.ts === ts)
  const button = m?.blocks?.flatMap((b) => b.elements ?? []).find((e) => e.action_id === action_id)
  if (!button) return
  send("interactive", {
    type: "block_actions",
    user: { id: user, name: USERS[user] },
    team: { id: "TDEMO" },
    channel: { id: m.channel },
    message: { ts: m.ts, thread_ts: m.thread_ts, text: m.text },
    container: { type: "message", message_ts: m.ts, channel_id: m.channel },
    actions: [{ type: "button", action_id, block_id: "b", value: button.value, action_ts: String(Date.now() / 1000) }],
    trigger_id: "t",
    api_app_id: "ADEMO",
  })
}

const read = (req) => new Promise((resolve) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => resolve(Buffer.concat(chunks).toString()))
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
  if (url.pathname.startsWith("/api/")) {
    const raw = await read(req)
    const args = req.headers["content-type"]?.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw))
    if (typeof args.blocks === "string") args.blocks = JSON.parse(args.blocks)
    const method = api[url.pathname.slice(5)]
    return json({ ok: true, ...(method ? method(args) : {}) })
  }
  if (url.pathname.startsWith("/files/")) {
    const file = files.get(url.pathname.slice(7))
    if (!file || !req.headers.authorization?.startsWith("Bearer xoxb-")) { res.writeHead(404); return res.end() }
    res.writeHead(200, { "content-type": file.mimetype, "content-length": file.data.length })
    return res.end(file.data)
  }
  if (url.pathname === "/ui/state") {
    const project = projectDir ? readdirSync(projectDir).filter((n) => n !== ".git").sort() : []
    return json({ messages, users: USERS, channels: CHANNELS, project, connected: Boolean(socket) })
  }
  if (req.method === "POST" && url.pathname === "/ui/message") { postFromUi(JSON.parse(await read(req))); return json({}) }
  if (req.method === "POST" && url.pathname === "/ui/click") { clickFromUi(JSON.parse(await read(req))); return json({}) }
  res.writeHead(200, { "content-type": "text/html" })
  res.end(PAGE)
})

const wss = new WebSocketServer({ server, path: "/socket" })
wss.on("connection", (ws) => {
  socket = ws
  ws.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "ADEMO" } }))
  const ping = setInterval(() => ws.ping(), 5000)
  ws.on("close", () => { clearInterval(ping); if (socket === ws) socket = undefined })
})
server.listen(port, "127.0.0.1", () => console.log(`fake Slack on http://127.0.0.1:${port}`))

const PAGE = `<!doctype html><meta charset="utf-8"><title>Slack Tag demo</title>
<style>
body{margin:0;font:15px/1.45 -apple-system,Segoe UI,sans-serif;display:grid;grid-template-columns:200px 1fr 230px;height:100vh;color:#1d1c1d}
nav{background:#3f0e40;color:#cfc3cf;padding:12px}nav h2{color:#fff;font-size:17px;margin:4px 0 16px}nav div{padding:4px 8px;border-radius:6px;cursor:pointer}
nav .on{background:#1164a3;color:#fff}main{display:flex;flex-direction:column;overflow:hidden}header{padding:10px 18px;border-bottom:1px solid #ddd;font-weight:700;display:flex;gap:12px;align-items:center}
#log{flex:1;overflow:auto;padding:8px 18px}.msg{padding:6px 0}.who{font-weight:700}.ed{color:#888;font-size:12px;margin-left:6px}.eph{background:#f4f4f4;border-left:3px solid #aaa;padding:4px 8px;color:#555}
.thread{margin:4px 0 12px 22px;border-left:2px solid #e5e5e5;padding-left:12px}pre{background:#f6f6f6;border:1px solid #ddd;padding:6px;white-space:pre-wrap;margin:4px 0}
button{font:inherit;border:1px solid #bbb;border-radius:4px;padding:3px 12px;margin-right:6px;cursor:pointer;background:#fff}.primary{background:#007a5a;color:#fff;border-color:#007a5a}.danger{color:#e01e5a;border-color:#e01e5a}
form{display:flex;gap:6px;padding:10px 18px;border-top:1px solid #ddd}form input[type=text]{flex:1;padding:8px;border:1px solid #bbb;border-radius:6px}.reply{display:flex;gap:6px;margin-top:4px}.reply input{flex:1;padding:4px}
aside{border-left:1px solid #ddd;padding:12px;background:#fafafa;overflow:auto}aside li{font-family:monospace}.mention{background:#e8f5fa;color:#1264a3;border-radius:3px;padding:0 2px}
</style>
<nav><h2>Slack Tag demo</h2><div id="channels"></div><p style="margin-top:24px">Posting as</p><div id="users"></div><p id="conn"></p></nav>
<main><header><span id="title"></span></header><div id="log"></div>
<form id="compose"><input type="text" id="text" placeholder="Message, e.g. @OpenCode hello" autocomplete="off"><input type="file" id="file"><button class="primary">Send</button></form></main>
<aside><b>Project folder on the host</b><ul id="files"></ul></aside>
<script>
let me = "UOWNER", channel = "CDEMO", state = { messages: [] }
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const md = (t) => esc(t || "").replace(/&amp;(lt|gt|amp);/g, "&$1;").replace(/&lt;@(\\w+)&gt;/g, (_, u) => '<span class="mention">@' + (state.users[u] || u) + "</span>")
  .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, "<pre>$1</pre>").replace(/\`([^\`]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<b>$1</b>").replace(/\\*([^*\\n]+)\\*/g, "<b>$1</b>")
const file64 = (f) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result.split(",")[1]); r.readAsDataURL(f) })
async function post(text, thread_ts, input) {
  const f = input?.files?.[0]
  const file = f && { name: f.name, mimetype: f.type || "application/octet-stream", data: await file64(f) }
  await fetch("/ui/message", { method: "POST", body: JSON.stringify({ user: me, channel, text, thread_ts, file }) })
  if (input) input.value = ""
  refresh()
}
function view(m) {
  if (m.ephemeralFor && m.ephemeralFor !== me) return ""
  const blocks = (m.blocks || []).map((b) => b.type === "section" ? "<div>" + md(b.text.text) + "</div>" :
    "<div>" + b.elements.map((e) => '<button class="' + e.style + '" onclick="click_(\\'' + m.ts + "','" + e.action_id + "')\\">" + esc(e.text.text) + "</button>").join("") + "</div>").join("")
  const body = blocks || "<div>" + md(m.text) + "</div>"
  const files = (m.files || []).map((f) => "<div>📎 " + esc(f.name) + "</div>").join("")
  return '<div class="msg' + (m.ephemeralFor ? " eph" : "") + '"><span class="who">' + esc(state.users[m.user]) + "</span>" +
    (m.edits ? '<span class="ed">edited ' + m.edits + "×</span>" : "") + (m.ephemeralFor ? '<span class="ed">only visible to you</span>' : "") + body + files + "</div>"
}
function render() {
  document.querySelector("#channels").innerHTML = Object.entries(state.channels).map(([id, n]) => '<div class="' + (id === channel ? "on" : "") + '" onclick="channel=\\'' + id + "';last='';refresh()\\"># " + n + "</div>").join("")
  document.querySelector("#users").innerHTML = ["UOWNER", "UOTHER"].map((u) => '<div class="' + (u === me ? "on" : "") + '" onclick="me=\\'' + u + "';last='';refresh()\\">" + state.users[u] + "</div>").join("")
  document.querySelector("#conn").textContent = state.connected ? "bridge connected" : "bridge not connected"
  document.querySelector("#title").textContent = "# " + state.channels[channel] + " — posting as " + state.users[me]
  const mine = state.messages.filter((m) => m.channel === channel)
  const log = document.querySelector("#log"), atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30
  const open = document.activeElement?.dataset?.thread, typed = document.activeElement?.value
  log.innerHTML = mine.filter((m) => !m.thread_ts || m.thread_ts === m.ts).map((m) => view(m) + '<div class="thread">' +
    mine.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts).map(view).join("") +
    '<div class="reply"><input data-thread="' + m.ts + '" placeholder="Reply in thread…"><input type="file" data-file="' + m.ts + '"><button onclick="replyTo(\\'' + m.ts + "')\\">Reply</button></div></div>").join("")
  if (open) { const el = log.querySelector('[data-thread="' + open + '"]'); el.value = typed; el.focus() }
  if (atEnd) log.scrollTop = log.scrollHeight
  document.querySelector("#files").innerHTML = state.project.map((n) => "<li>" + esc(n) + "</li>").join("")
}
window.replyTo = (ts) => post(document.querySelector('[data-thread="' + ts + '"]').value, ts, document.querySelector('[data-file="' + ts + '"]'))
window.click_ = (ts, action_id) => fetch("/ui/click", { method: "POST", body: JSON.stringify({ user: me, ts, action_id }) })
document.querySelector("#compose").onsubmit = (e) => { e.preventDefault(); const t = document.querySelector("#text"); post(t.value, undefined, document.querySelector("#file")); t.value = "" }
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.thread) replyTo(e.target.dataset.thread) })
let last = ""
async function refresh() { const raw = await fetch("/ui/state").then((r) => r.text()); if (raw !== last) { last = raw; state = JSON.parse(raw); render() } }
setInterval(refresh, 700); refresh()
</script>`
