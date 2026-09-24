import { connect } from "./lib.mjs"

const client = connect()
const listed = await client.session.list()
const session = (listed.data ?? listed).find((s) => s.title === "approve")
if (!session) {
  console.log("FAIL session survives a server restart: session missing")
  process.exit(1)
}
const history = JSON.stringify(await client.message.list({ sessionID: session.id }))
const ok = history.includes("touch approved.txt") && history.includes("Command finished")
console.log(`${ok ? "PASS" : "FAIL"} session survives a server restart with its history`)
process.exit(ok ? 0 : 1)
