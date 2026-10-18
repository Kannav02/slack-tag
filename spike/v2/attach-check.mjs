import { symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { connect, recorder, sessionOf } from "./lib.mjs"

// The scripted model calls slack_attach once per case; accepted files are fetched over the plugin RPC as the bridge does.
const project = process.env.PROJECT_DIR
const client = connect()
const rec = recorder(client)
const rpc = client.rpc({ id: "slack-tag", methods: { attachment: {} }, events: {} })
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")])
const files = { "shot.png": png, "notes.log": "all good\n", "fake.png": "text", "big.log": Buffer.alloc(10485761, 97), "run.sh": "id" }
for (const [name, data] of Object.entries(files)) writeFileSync(join(project, name), data)
writeFileSync(join(project, "../home/server.txt"), "server only")
symlinkSync("/proc/self/environ", join(project, "environ.txt")) // the server's own environment
symlinkSync(join(project, "../home"), join(project, "home")) // the server's HOME, holding its config and data
await new Promise((r) => setTimeout(r, 500)) // let the event subscription start

const cases = [["shot.png", png], [join(project, "notes.log"), "all good\n"], ["environ.txt"], ["home/server.txt"], [process.env.OUTSIDE], ["big.log"], ["fake.png"], ["run.sh"]]
let failed = 0
for (const [path, expected] of cases) {
  const session = await client.session.create({ title: "attach", location: { directory: project } })
  const since = rec.events.length
  await client.session.prompt({ sessionID: session.id, text: `ATTACH: ${JSON.stringify({ path, caption: "look" })}` })
  const event = await rec.waitFor((e) => /^session\.tool\.(success|failed)$/.test(e.type) && sessionOf(e) === session.id, { since })
  const id = event.data.metadata?.slackAttach
  const fetch = (sessionID) => rpc.attachment({ sessionID, id }, { location: event.location })
  // Another session gets nothing, the attaching session gets the file once.
  const [other, file, again] = id ? [await fetch("ses_other"), await fetch(session.id), await fetch(session.id)] : []
  const ok = expected
    ? file?.data === Buffer.from(expected).toString("base64") && file.caption === "look" && !other?.data && !again?.data
    : event.type === "session.tool.failed" && !id
  failed += ok ? 0 : 1
  console.log(`${ok ? "PASS" : "FAIL"} ${expected ? "accepted" : "refused"} ${path}: ${event.data.error?.message ?? event.data.content?.[0]?.text}`)
}
const leaked = JSON.stringify(rec.events).includes(process.env.OC_PASSWORD)
console.log(`${leaked ? "FAIL" : "PASS"} the server password appears in no event`)
rec.stop()
process.exit(failed || leaked ? 1 : 0)
