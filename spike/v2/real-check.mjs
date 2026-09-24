import { existsSync } from "node:fs"
import { join } from "node:path"
import { connect, recorder, sessionOf } from "./lib.mjs"

const [providerID, ...rest] = (process.env.MODEL ?? "").split("/")
const model = rest.join("/")
if (!providerID || !model) throw new Error("MODEL=provider/model is required")
const project = process.env.PROJECT_DIR

const client = connect()
const rec = recorder(client)
await new Promise((r) => setTimeout(r, 500))

const finished = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
const session = await client.session.create({
  title: "real-model",
  location: { directory: project },
  model: { providerID, id: model },
})
await client.session.prompt({
  sessionID: session.id,
  text: "Use the shell tool to run exactly `touch real-model.txt` in the project directory, then reply with the single word DONE.",
})

let asked = 0
const deadline = Date.now() + 180_000
let end
while (!end && Date.now() < deadline) {
  const event = await rec.waitFor(
    (e) => sessionOf(e) === session.id && (e.type === "permission.asked" || finished.includes(e.type)) && !e.handled,
    { timeout: deadline - Date.now() },
  )
  event.handled = true
  if (event.type === "permission.asked") {
    asked++
    console.log(`permission asked: ${event.data.action} ${JSON.stringify(event.data.resources)}`)
    await client.permission.reply({ sessionID: session.id, requestID: event.data.id, decision: "once" })
  } else end = event
}

const mine = rec.events.filter((e) => sessionOf(e) === session.id)
const text = mine.filter((e) => e.type === "session.text.delta").map((e) => e.data.delta ?? e.data.text ?? "").join("")
const failures = mine.filter((e) => ["session.step.failed", "session.execution.failed", "session.retry.scheduled"].includes(e.type))
console.log(`model: ${providerID}/${model}`)
console.log(`end: ${end?.type ?? "timeout"}`)
console.log(`permission prompts: ${asked}`)
console.log(`text deltas: ${mine.filter((e) => e.type === "session.text.delta").length}, reply: ${JSON.stringify(text.slice(-200))}`)
for (const f of failures) console.log(`${f.type}: ${JSON.stringify(f.data).slice(0, 300)}`)
const created = existsSync(join(project, "real-model.txt"))
console.log(`file created after approval: ${created}`)
rec.stop()
process.exit(end?.type === "session.execution.succeeded" && asked > 0 && created ? 0 : 1)
