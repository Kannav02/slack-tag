// Checks the per-project queue against real OpenCode 2.0.15 and the safety plugin, with a scripted
// model (spike/v2/mock-model.mjs) and the fake Slack. Thread A runs a slow shell command, thread B a
// fast one sent right after; with the queue, B waits and notes.txt ends up "A" then "B".
// Usage: node demo/queue-check.mjs   (KEEP_OPEN=1 leaves everything running to inspect http://127.0.0.1:3000)
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const work = mkdtempSync(join(tmpdir(), "slack-tag-queue-"))
const project = join(work, "project")
const password = `queue-${process.pid}`
const slackUrl = "http://127.0.0.1:3000"
const opencodeUrl = "http://127.0.0.1:4096"
const children = []
const quit = () => children.forEach((c) => c.kill())
process.on("exit", quit)

function start(name, cmd, args, options) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...options })
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`))
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`))
  children.push(child)
}
async function until(what, check, ms = 60_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await delay(250)) {
    const value = await check().catch(() => undefined)
    if (value) return value
  }
  throw new Error(`timed out waiting for ${what}`)
}

mkdirSync(project, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: project })
mkdirSync(join(work, "xdg/opencode"), { recursive: true })
symlinkSync(join(root, "plugin"), join(work, "xdg/plugin"))
const config = JSON.parse(readFileSync(join(root, "deploy/opencode.global.jsonc"), "utf8"))
config.providers = JSON.parse(readFileSync(join(root, "spike/v2/opencode.global.jsonc"), "utf8")).providers
writeFileSync(join(work, "xdg/opencode/opencode.jsonc"), JSON.stringify(config))
writeFileSync(join(work, "config.json"), JSON.stringify({
  ownerUserId: "UOWNER",
  channels: { CDEMO: { name: "demo", projectDir: project, opencodeUrl, model: "mock/mock" } },
}))

const xdg = { HOME: join(work, "home"), XDG_CONFIG_HOME: join(work, "xdg"), XDG_DATA_HOME: join(work, "home/share"), XDG_STATE_HOME: join(work, "home/state"), XDG_CACHE_HOME: join(work, "home/cache") }
start("model", process.execPath, [join(root, "spike/v2/mock-model.mjs")])
start("opencode", "npx", ["--yes", "-p", "@opencode/cli@2.0.15", "opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096"],
  { cwd: project, env: { ...process.env, ...xdg, OPENCODE_SERVER_PASSWORD: password } })
const auth = { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
await until("OpenCode", () => fetch(`${opencodeUrl}/api/model`, { headers: auth }).then((r) => r.ok), 180_000)
start("slack", process.execPath, [join(root, "demo/fake-slack.mjs")], { env: { ...process.env, DEMO_PROJECT: project } })
start("bridge", process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", "src/main.ts"], {
  cwd: join(root, "bridge"),
  env: { ...process.env, SLACK_API_URL: `${slackUrl}/api/`, SLACK_BOT_TOKEN: "xoxb-demo", SLACK_APP_TOKEN: "xapp-demo", SLACK_TAG_CONFIG: join(work, "config.json"), OPENCODE_SERVER_PASSWORD: password },
})
const state = () => fetch(`${slackUrl}/ui/state`).then((r) => r.json())
await until("bridge connection", async () => (await state()).connected)

const post = (text) => fetch(`${slackUrl}/ui/message`, { method: "POST", body: JSON.stringify({ user: "UOWNER", channel: "CDEMO", text }) })
const thread = (messages, text) => messages.find((m) => m.text.includes(text))?.ts
const replies = (messages, ts) => messages.filter((m) => m.thread_ts === ts && m.user === "UBOT").map((m) => m.text)
await post("@OpenCode RUN: sleep 8 && echo A >> notes.txt")
await delay(1000)
await post("@OpenCode RUN: echo B >> notes.txt")

const done = await until("both replies", async () => {
  const { messages } = await state()
  const a = thread(messages, "echo A"), b = thread(messages, "echo B")
  const finished = (ts) => replies(messages, ts).some((t) => t.includes("Command finished"))
  return a && b && finished(a) && finished(b) && { a: replies(messages, a), b: replies(messages, b) }
}, 120_000)
const notes = readFileSync(join(project, "notes.txt"), "utf8")
console.log("thread A replies:", done.a)
console.log("thread B replies:", done.b)
console.log("notes.txt:", JSON.stringify(notes))
assert.match(done.b[0], /^Queued: 1 ahead/)
assert.equal(notes, "A\nB\n")
console.log("PASS: thread B waited for thread A; both edits landed in order.")
if (process.env.KEEP_OPEN) {
  console.log(`Still running. Open ${slackUrl}; press Ctrl+C to stop.`)
  await new Promise(() => {})
}
quit()
