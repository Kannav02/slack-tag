import { connect, recorder, sessionOf } from "./lib.mjs"

// Anything that waits on a person (a permission request or a form) is answered no and fails the check.
const client = connect()
const rec = recorder(client)
await new Promise((r) => setTimeout(r, 500))

const finished = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
const s = await client.session.create({ title: "websearch", location: { directory: process.env.PROJECT_DIR } })
await client.session.prompt({ sessionID: s.id, text: "SEARCH: opencode release notes" })
const waited = []
for (;;) {
  const match = (e) => (sessionOf(e) ?? e.data?.form?.sessionID) === s.id && !e.seen && (e.type === "permission.asked" || e.type === "form.created" || finished.includes(e.type))
  const event = await rec.waitFor(match, { timeout: 90000 })
  event.seen = true
  if (event.type === "permission.asked") {
    waited.push(`permission ${event.data.action} ${JSON.stringify(event.data.resources)}`)
    await client.permission.reply({ sessionID: s.id, requestID: event.data.id, decision: "reject" })
  } else if (event.type === "form.created") {
    waited.push(`form ${JSON.stringify(event.data.form.title)}`)
    await client.session.form.cancel({ sessionID: s.id, formID: event.data.form.id })
  } else break
}
const tool = rec.events.find((e) => sessionOf(e) === s.id && /^session\.tool\.(success|failed)$/.test(e.type))
const output = tool?.data.content?.map((c) => c.text).join("") ?? tool?.data.error?.message ?? ""
rec.stop()
console.log(`waited on: ${waited.length ? waited.join("; ") : "nothing"}`)
console.log(`tool: ${tool?.type ?? "none"} ${JSON.stringify(output.trim().slice(0, 200))}`)
// The search must reach a provider; a provider error is fine where its host is unreachable.
const ok = waited.length === 0 && tool !== undefined && !/declined|cancelled|Blocked/.test(output)
console.log(ok ? "PASS web search ran without asking" : "FAIL web search waited on a person")
process.exit(ok ? 0 : 1)
