import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { connect, recorder, sessionOf } from "./lib.mjs"

const project = process.env.PROJECT_DIR
if (!project) throw new Error("PROJECT_DIR is required")

const client = connect()
const rec = recorder(client)
await new Promise((r) => setTimeout(r, 500))

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e.message })
    console.log(`FAIL ${name}: ${e.message}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const file = (name) => join(project, name)

async function newSession(title) {
  return client.session.create({ title, location: { directory: project } })
}
const asked = (sessionID) => (e) => e.type === "permission.asked" && sessionOf(e) === sessionID
const finished = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
const idle = (sessionID) => (e) => finished.includes(e.type) && sessionOf(e) === sessionID

for (const f of ["approved.txt", "rejected.txt", "pending.txt", "queued.txt"]) rmSync(file(f), { force: true })

await check("text reply streams as deltas and finishes", async () => {
  const s = await newSession("text")
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: "say hello" })
  await rec.waitFor(idle(s.id), { since })
  const deltas = rec.events.slice(since).filter((e) => e.type === "session.text.delta" && sessionOf(e) === s.id)
  assert(deltas.length > 1, `expected several text deltas, got ${deltas.length}`)
})

await check("ask blocks the command until approved once", async () => {
  const s = await newSession("approve")
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: "RUN: touch approved.txt" })
  const req = await rec.waitFor(asked(s.id), { since })
  await sleep(1500)
  assert(!existsSync(file("approved.txt")), "command ran before approval")
  await client.permission.reply({ sessionID: s.id, requestID: req.data.id, decision: "once" })
  await rec.waitFor(idle(s.id), { since })
  assert(existsSync(file("approved.txt")), "command did not run after approval")
})

await check("reject leaves the command unexecuted", async () => {
  const s = await newSession("reject")
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: "RUN: touch rejected.txt" })
  const req = await rec.waitFor(asked(s.id), { since })
  await client.permission.reply({ sessionID: s.id, requestID: req.data.id, decision: "reject", message: "rejected in Slack" })
  await rec.waitFor(idle(s.id), { since })
  assert(!existsSync(file("rejected.txt")), "rejected command ran")
})

await check("pending requests can be listed for recovery after a bridge restart", async () => {
  const s = await newSession("pending")
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: "RUN: touch pending.txt" })
  const req = await rec.waitFor(asked(s.id), { since })
  const pending = await client.permission.list({ sessionID: s.id })
  assert(pending.some((p) => p.id === req.data.id), "pending request missing from permission.list")
  await client.permission.reply({ sessionID: s.id, requestID: req.data.id, decision: "reject" })
  await rec.waitFor(idle(s.id), { since })
  assert(!existsSync(file("pending.txt")), "rejected command ran")
})

await check("global policy hard-denies git push without asking", async () => {
  const s = await newSession("policy")
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: "RUN: git push origin main" })
  await rec.waitFor(idle(s.id), { since })
  const mine = rec.events.slice(since).filter((e) => sessionOf(e) === s.id)
  assert(!mine.some((e) => e.type === "permission.asked"), "policy-denied command still prompted")
  const failed = mine.find((e) => e.type === "session.tool.failed")
  assert(failed, "expected a failed tool event")
  console.log(`  tool failure: ${JSON.stringify(failed.data).slice(0, 200)}`)
})

await check("a message sent while busy is queued and runs afterwards", async () => {
  const s = await newSession("queue")
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: "RUN: touch queued.txt" })
  const req = await rec.waitFor(asked(s.id), { since })
  await client.session.prompt({ sessionID: s.id, text: "say hello again", delivery: "queue" })
  await client.permission.reply({ sessionID: s.id, requestID: req.data.id, decision: "once" })
  const afterReply = rec.events.length
  await rec.waitFor((e) => e.type === "session.inbox.delivered" && sessionOf(e) === s.id, { since: afterReply })
  await rec.waitFor(idle(s.id), { since: afterReply })
  await sleep(500)
  const messages = await client.message.list({ sessionID: s.id })
  const text = JSON.stringify(messages)
  assert(existsSync(file("queued.txt")), "first command did not run")
  assert(text.includes("say hello again"), "queued message missing from history")
})

rec.stop()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
