import { readFileSync } from "node:fs"
import { connect, recorder, sessionOf } from "./lib.mjs"

// Real check of the safety plugin's /fix command (run with ./attach.sh fix-check.mjs). The scripted model runs
// the RUN lines of the argument; the shell tool events it causes are what the bridge's fix-commands.log is built from.
const client = connect()
const rec = recorder(client)
const location = { directory: process.env.PROJECT_DIR }
await new Promise((r) => setTimeout(r, 500)) // let the event subscription start
const session = await client.session.create({ title: "fix", location })
const mine = (e) => sessionOf(e) === session.id
const text = "the login test fails\nRUN: ls\nRUN: cat missing.txt\nRUN: sudo true\nRUN: rm -rf nothing"
await client.session.command({ sessionID: session.id, name: "fix", text, delivery: "queue" })
const asked = await rec.waitFor((e) => mine(e) && e.type === "permission.asked", { timeout: 30000 })
await client.permission.reply({ sessionID: session.id, requestID: asked.data.id, decision: "reject" })
const settled = await rec.waitFor((e) => mine(e) && /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type))
// Listed afterwards: right after the server starts, the list can lack plugin commands that already run.
const listed = (await client.command.list({ location })).data.find((c) => c.name === "fix")
const calls = rec.events.filter((e) => mine(e) && /^session\.tool\.(called|success|failed)$/.test(e.type))
for (const { type, data } of calls) console.log(type, JSON.stringify({ input: data.input, content: data.content, metadata: data.metadata, error: data.error }))
const results = calls.filter((e) => e.type !== "session.tool.called").map((e) => e.data.metadata?.exit ?? e.data.error?.message)
const users = readFileSync(process.env.MOCK_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line).user)
const checks = {
  [`fix is listed: ${listed?.description}`]: Boolean(listed),
  "the model received the template with the argument": users.some((u) => u.startsWith(`Fix this problem: ${text}\n`) && u.includes("slack_attach")),
  [`shell results ${JSON.stringify(results)}, then ${settled.type}`]:
    JSON.stringify(results) === JSON.stringify([0, 1, "Blocked by the safety plugin", "The user declined this tool call"]),
}
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`)
rec.stop()
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
