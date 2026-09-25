import { connect, recorder } from "./lib.mjs"

const client = connect()
const rec = recorder(client)
await new Promise((r) => setTimeout(r, 500))

const session = await client.session.create({ title: "dump", location: { directory: process.env.PROJECT_DIR } })
console.log("session:", JSON.stringify(session))
await client.session.prompt({ sessionID: session.id, text: process.argv[2] ?? "hello" })
await new Promise((r) => setTimeout(r, Number(process.env.WAIT_MS ?? 4000)))

for (const e of rec.events) console.log(JSON.stringify(e).slice(0, 400))
rec.stop()
process.exit(0)
