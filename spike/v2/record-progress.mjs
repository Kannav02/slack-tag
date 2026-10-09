import { writeFileSync } from "node:fs"
import { connect, recorder, sessionOf } from "./lib.mjs"

// Runs one scripted prompt, approves the shell request, and writes every event of the session as JSON lines.
const out = process.argv[2]
if (!out) throw new Error("usage: record-progress.mjs <output.jsonl>")

const client = connect()
const rec = recorder(client)
await new Promise((r) => setTimeout(r, 500))

const session = await client.session.create({ title: "progress", location: { directory: process.env.PROJECT_DIR } })
await client.session.prompt({ sessionID: session.id, text: "Look around this project." })
const mine = (e) => sessionOf(e) === session.id
const asked = await rec.waitFor((e) => e.type === "permission.asked" && mine(e), { timeout: 30000 })
await client.permission.reply({ sessionID: session.id, requestID: asked.data.id, decision: "once" })
await rec.waitFor((e) => e.type.startsWith("session.execution.") && e.type !== "session.execution.started" && mine(e), { timeout: 30000 })
await new Promise((r) => setTimeout(r, 300))

const events = rec.events.filter(mine)
writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
for (const e of events) {
  const d = e.data ?? {}
  const keys = ["ordinal", "id", "name", "finish", "delta", "input", "error"].filter((k) => k in d)
  console.log(e.type.padEnd(32), keys.map((k) => `${k}=${JSON.stringify(d[k]).slice(0, 70)}`).join(" "))
}
rec.stop()
process.exit(0)
