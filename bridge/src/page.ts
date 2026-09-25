import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { createApprovals } from "./approvals.ts"
import type { connect } from "./agent.ts"

type Approvals = ReturnType<typeof createApprovals>
type Client = ReturnType<typeof connect>

const page = `<!doctype html>
<meta charset="utf-8">
<title>Slack Tag approvals</title>
<style>
  body { font: 15px/1.4 -apple-system, sans-serif; margin: 0; background: #1a1d21; color: #d1d2d3; }
  main { max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 18px; }
  form, .row { display: flex; gap: 8px; margin: 12px 0; }
  input, button { font: inherit; padding: 8px 12px; border-radius: 6px; border: 0; }
  input { flex: 1; background: #222529; color: inherit; }
  button { background: #148567; color: white; cursor: pointer; }
  button.reject { background: #b73c3c; }
  button.other { background: #3f4146; }
  .card { background: #222529; border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
  .meta { color: #9a9b9d; font-size: 13px; }
  code { color: #e8e6e3; }
</style>
<main>
  <h1>Thread</h1>
  <p class="meta" id="file"></p>
  <div id="log"></div>
  <form id="say">
    <input name="text" placeholder="Message @OpenCode" required>
    <button>Send</button>
  </form>
</main>
<script>
  const owner = "U_OWNER"
  const log = document.querySelector("#log")
  async function refresh() {
    const data = await fetch("/state").then((r) => r.json())
    document.querySelector("#file").textContent = "approved.txt: " + (data.approved ? "exists" : "absent") + " · rejected.txt: " + (data.rejected ? "exists" : "absent")
    log.innerHTML = data.lines.map((line) => '<div class="card"><div>' + line.html + '</div>' + (line.actions || "") + '</div>').join("")
  }
  document.querySelector("#say").onsubmit = async (event) => {
    event.preventDefault()
    const text = new FormData(event.target).get("text")
    await fetch("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, userId: owner }) })
    event.target.reset()
    refresh()
  }
  addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-request]")
    if (!button) return
    await fetch("/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      userId: button.dataset.user,
      requestID: button.dataset.request,
      decision: button.dataset.decision,
    }) })
    refresh()
  })
  setInterval(refresh, 500)
  refresh()
</script>`

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => resolve(body))
  })
}

export function startPage(opts: {
  port: number
  projectDir: string
  ownerUserId: string
  approvals: Approvals
  client: Client
  session: () => Promise<{ id: string }>
  lines: { html: string }[]
}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(page)
      return
    }
    if (req.method === "GET" && url.pathname === "/state") {
      const lines = opts.lines.map((line) => ({ html: line.html }))
      for (const prompt of opts.approvals.prompts) {
        const actions =
          prompt.state === "pending"
            ? `<div class="row"><button data-request="${prompt.requestID}" data-decision="once" data-user="${opts.ownerUserId}">Approve</button><button class="reject" data-request="${prompt.requestID}" data-decision="reject" data-user="${opts.ownerUserId}">Reject</button><button class="other" data-request="${prompt.requestID}" data-decision="once" data-user="U_OTHER">Approve as someone else</button></div>`
            : `<p class="meta">${htmlEscape(prompt.note ?? prompt.state)}</p>`
        lines.push({
          html: `<strong>${htmlEscape(prompt.action)}</strong> <code>${htmlEscape(prompt.command)}</code>${actions}`,
        })
      }
      send(res, {
        approved: existsSync(join(opts.projectDir, "approved.txt")),
        rejected: existsSync(join(opts.projectDir, "rejected.txt")),
        lines,
      })
      return
    }
    const body = JSON.parse((await readBody(req)) || "{}")
    if (req.method === "POST" && url.pathname === "/message") {
      if (body.userId !== opts.ownerUserId) {
        opts.lines.push({ html: "only the owner can talk to the agent" })
        send(res, { ok: false })
        return
      }
      opts.lines.push({ html: htmlEscape(String(body.text)) })
      const session = await opts.session()
      await opts.client.session.prompt({ sessionID: session.id, text: String(body.text) })
      send(res, { ok: true })
      return
    }
    if (req.method === "POST" && url.pathname === "/decide") {
      const result = await opts.approvals.decide({
        userId: String(body.userId),
        requestID: String(body.requestID),
        decision: body.decision,
      })
      if (!result.ok) opts.lines.push({ html: htmlEscape(result.reply) })
      send(res, result)
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(opts.port, "127.0.0.1")
  return server
}

function send(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
