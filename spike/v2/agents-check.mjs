import { readFileSync } from "node:fs"
import { connect, recorder, sessionOf } from "./lib.mjs"

// Prompts each server once and checks, from the scripted model's log, whether the AGENTS.md sentinel
// reached the system prompt. The plugin server should inject it; the no-plugin server (the control)
// should not, which shows OpenCode does not auto-load AGENTS.md while project config is disabled.
const project = process.env.PROJECT_DIR
const sentinel = process.env.SENTINEL
const finished = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
const idle = (id) => (e) => finished.includes(e.type) && sessionOf(e) === id

async function prompt(port) {
  process.env.OC_URL = `http://127.0.0.1:${port}`
  const client = connect()
  const rec = recorder(client)
  await new Promise((r) => setTimeout(r, 300))
  const session = await client.session.create({ title: "agents", location: { directory: project } })
  await client.session.prompt({ sessionID: session.id, text: "say hello" })
  await rec.waitFor(idle(session.id), { timeout: 30000 })
  rec.stop()
}

const inSystem = (logPath, needle) =>
  readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((line) => (JSON.parse(line).system ?? []).some((text) => text.includes(needle)))
const sentinelInSystem = (logPath) => inSystem(logPath, sentinel)

await prompt(process.env.WITH_PORT)
await prompt(process.env.WITHOUT_PORT)

const withHit = sentinelInSystem(process.env.WITH_LOG)
const withoutHit = sentinelInSystem(process.env.WITHOUT_LOG)
console.log(`${withHit ? "PASS" : "FAIL"} plugin + project config disabled: AGENTS.md reached the system prompt`)
console.log(`${withoutHit ? "FAIL" : "PASS"} no plugin + project config disabled: OpenCode did not auto-load AGENTS.md (control)`)
// The plugin's reply-style instruction (GUEST-1) comes from the same context hook.
const concise = inSystem(process.env.WITH_LOG, "Lead with the result")
const conciseControl = inSystem(process.env.WITHOUT_LOG, "Lead with the result")
console.log(`${concise ? "PASS" : "FAIL"} plugin: the concise-reply instruction reached the system prompt`)
console.log(`${conciseControl ? "FAIL" : "PASS"} no plugin: no concise-reply instruction (control)`)
process.exit(withHit && !withoutHit && concise && !conciseControl ? 0 : 1)
