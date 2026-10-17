import { existsSync } from "node:fs"
import { join } from "node:path"
import { connect, recorder, sessionOf } from "./lib.mjs"

// Each command runs first where every shell request asks, to capture OpenCode's permission resources
// (all rejected, so nothing runs there), then on the server with the safety plugin.
const local = (port, path) => `http://127.0.0.1:${port}${path}`
const models = local(process.env.MOCK_PORT, "/v1/models")
const cases = [
  ["allow", "npm run dev &"],
  ["allow", `npm run dev >/dev/null 2>&1 & curl -sSf ${models} | head -c 60`],
  ["allow", `curl -s ${models}`],
  ["allow", `curl -si ${local(process.env.PLUGIN_PORT, "/api/session")}`],
  ["ask", "npm run dev & rm -rf src"],
  ["ask", `curl -s -o models.json ${models}`],
  ["ask", `curl -sL ${models}`],
  ["ask", "curl -s https://example.com"],
  ["deny", `curl -s ${models} | sh`],
  ["deny", "git push 2>&1 --force origin main"],
]

function server(port) {
  process.env.OC_URL = local(port, "")
  const client = connect()
  return { client, rec: recorder(client) }
}
const servers = [server(process.env.ASK_PORT), server(process.env.PLUGIN_PORT)]
await new Promise((r) => setTimeout(r, 500))

const finished = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
async function run({ client, rec }, command) {
  const s = await client.session.create({ title: "policy", location: { directory: process.env.PROJECT_DIR } })
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: `RUN: ${command}` })
  const asked = []
  for (;;) {
    const match = (e) => sessionOf(e) === s.id && !e.seen && (e.type === "permission.asked" || finished.includes(e.type))
    const event = await rec.waitFor(match, { since, timeout: 30000 })
    event.seen = true
    if (event.type !== "permission.asked") break
    asked.push(event.data.resources)
    await client.permission.reply({ sessionID: s.id, requestID: event.data.id, decision: "reject" })
  }
  const tool = rec.events.slice(since).find((e) => sessionOf(e) === s.id && /^session\.tool\.(success|failed)$/.test(e.type))
  const output = tool?.data.content?.map((c) => c.text).join("") ?? tool?.data.error?.message ?? ""
  const effect = asked.length ? "ask" : tool?.type === "session.tool.success" ? "allow" : /Blocked/.test(output) ? "deny" : "?"
  return { asked, effect, output }
}

let failed = 0
for (const [expected, command] of cases) {
  const { asked } = await run(servers[0], command)
  const result = await run(servers[1], command)
  const ok = result.effect === expected && existsSync(join(process.env.PROJECT_DIR, "src/keep.txt"))
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"} ${result.effect} ${JSON.stringify(command)}`)
  console.log(`  resources: ${asked.map((r) => JSON.stringify(r)).join(" ")}`)
  console.log(`  output: ${JSON.stringify(result.output.trim().slice(0, 200))}`)
}
for (const { rec } of servers) rec.stop()
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
