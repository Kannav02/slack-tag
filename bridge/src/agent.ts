import { OpenCode, type OpenCodeEvent } from "@opencode/client"
import { POLICY_VERSION } from "../../plugin/src/policy.ts"
import { definition } from "../../plugin/src/rpc.ts"

const handledEvents = [
  "permission.asked",
  "session.retry.scheduled",
  "session.inbox.delivered",
  "session.text.delta",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const
const handled = new Set<string>(handledEvents)

export type AgentEvent = Extract<OpenCodeEvent, { type: (typeof handledEvents)[number] }>
export type Permission = { id: string; sessionID: string; action: string; resources: readonly string[] }
export type Client = ReturnType<typeof connect>

export function connect(baseUrl: string, password: string) {
  return OpenCode.make({
    baseUrl,
    headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
  })
}

export async function pluginReady(client: Client): Promise<boolean> {
  try {
    const status = (await client.rpc(definition).status({})) as { pluginVersion?: string; policyVersion?: number }
    return Boolean(status.pluginVersion) && status.policyVersion === POLICY_VERSION
  } catch {
    return false
  }
}

function modelOf(spec: string) {
  const slash = spec.indexOf("/")
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1) }
}

export async function createSession(client: Client, directory: string, model: string): Promise<string> {
  return (await client.session.create({ title: "slack", location: { directory }, model: modelOf(model) })).id
}

export async function inputsOf(client: Client, model: string): Promise<readonly string[]> {
  const { providerID, id } = modelOf(model)
  const found = (await client.model.list()).data.find((m) => m.providerID === providerID && m.id === id)
  return found?.capabilities.input ?? []
}

export async function prompt(client: Client, sessionID: string, text: string, files: { uri: string; name: string }[]) {
  await client.session.prompt({ sessionID, text, files, delivery: "queue" })
}

const isHandled = (event: OpenCodeEvent): event is AgentEvent => handled.has(event.type)

async function stream(client: Client, onEvent: (event: AgentEvent) => void) {
  for (;;) {
    try {
      for await (const event of client.event.subscribe()) if (isHandled(event)) onEvent(event)
    } catch (error) {
      console.error("event stream failed:", error instanceof Error ? error.message : "error")
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

export function subscribe(client: Client, onEvent: (event: AgentEvent) => void) {
  stream(client, onEvent).catch((error: unknown) => console.error("event stream stopped:", error instanceof Error ? error.message : "error"))
}

export async function pending(client: Client, sessionID: string): Promise<readonly Permission[]> {
  return client.permission.list({ sessionID })
}

export async function decide(client: Client, sessionID: string, requestID: string, decision: "once" | "reject") {
  await client.permission.reply({ sessionID, requestID, decision })
}
