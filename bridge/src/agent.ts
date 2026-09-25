import { OpenCode } from "@opencode/client"

export type Ask = {
  sessionID: string
  requestID: string
  action: string
  command: string
}

type Event = {
  type: string
  data?: {
    id?: string
    sessionID?: string
    action?: string
    resources?: string[]
    text?: string
    delta?: string
  }
}

export function sessionOf(event: Event): string | undefined {
  return event.data?.sessionID
}

export function askOf(event: Event): Ask | undefined {
  if (event.type !== "permission.asked" || !event.data?.sessionID || !event.data.id) return
  const action = event.data.action ?? "action"
  const resources = event.data.resources ?? []
  const command = action === "shell" ? (resources[0] ?? action) : [action, ...resources].filter(Boolean).join(" ")
  return { sessionID: event.data.sessionID, requestID: event.data.id, action, command }
}

export function connect(baseUrl: string, password: string) {
  return OpenCode.make({
    baseUrl,
    headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
  })
}

export async function replyOnceOrReject(
  client: ReturnType<typeof connect>,
  ask: { sessionID: string; requestID: string },
  decision: "once" | "reject",
) {
  await client.permission.reply({
    sessionID: ask.sessionID,
    requestID: ask.requestID,
    decision,
    ...(decision === "reject" ? { message: "rejected in Slack" } : {}),
  })
}
