import { askOf, connect, sessionOf } from "./agent.ts"
import { createApprovals } from "./approvals.ts"
import { startPage } from "./page.ts"
import { startSlack } from "./slack.ts"

const baseUrl = process.env.OC_URL ?? "http://127.0.0.1:4096"
const password = process.env.OC_PASSWORD
const projectDir = process.env.PROJECT_DIR
const ownerUserId = process.env.SLACK_OWNER_ID ?? "U_OWNER"
const port = Number(process.env.PORT ?? 4173)

if (!password) throw new Error("OC_PASSWORD is required")
if (!projectDir) throw new Error("PROJECT_DIR is required")

const client = connect(baseUrl, password)
const approvals = createApprovals(client, ownerUserId)
const lines: { html: string }[] = []
let sessionID: string | undefined

async function session() {
  if (sessionID) return { id: sessionID }
  const created = await client.session.create({
    title: "slack-tag",
    location: { directory: projectDir! },
  })
  sessionID = created.id
  return created
}

const controller = new AbortController()
;(async () => {
  for await (const event of client.event.subscribe({ signal: controller.signal })) {
    const ask = askOf(event)
    if (ask) approvals.post(ask)
    if (event.type === "session.text.delta" && sessionOf(event) === sessionID && event.data?.delta) {
      const last = lines.at(-1)
      if (last?.html.startsWith("<em>")) last.html += event.data.delta
      else lines.push({ html: `<em>${event.data.delta}` })
    }
    if (event.type === "session.execution.succeeded" && sessionOf(event) === sessionID) {
      lines.push({ html: "run finished" })
    }
    if (event.type === "session.execution.failed" && sessionOf(event) === sessionID) {
      lines.push({ html: "run failed" })
    }
  }
})().catch((error) => {
  if (!controller.signal.aborted) console.error(error)
})

startSlack(approvals, ownerUserId)
startPage({ port, projectDir, ownerUserId, approvals, client, session, lines })
console.log(`bridge http://127.0.0.1:${port}`)
