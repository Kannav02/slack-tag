import { OpenCode } from "@opencode/client"
import { POLICY_VERSION } from "../../plugin/src/policy.ts"
import { definition } from "../../plugin/src/rpc.ts"

export type AgentEvent = { type: string; data?: Record<string, unknown> }

export function connect(url: string, password: string) {
  return OpenCode.make({
    baseUrl: url,
    headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
  })
}

export type Client = ReturnType<typeof connect>

export async function pluginReady(client: Client): Promise<boolean> {
  try {
    const status = await client.rpc(definition).status({})
    return Boolean(status.pluginVersion) && status.policyVersion === POLICY_VERSION
  } catch {
    return false
  }
}

export function modelOf(spec: string) {
  const slash = spec.indexOf("/")
  if (slash <= 0) throw new Error(`model must look like provider/model, got ${spec}`)
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1) }
}

export async function createSession(client: Client, directory: string, model: string) {
  const session = await client.session.create({
    title: "slack",
    location: { directory },
    model: modelOf(model),
  })
  return session.id
}

export async function prompt(client: Client, sessionID: string, text: string, delivery?: "queue") {
  await client.session.prompt({ sessionID, text, ...(delivery ? { delivery } : {}) })
}

export function subscribe(client: Client, onEvent: (event: AgentEvent) => void) {
  const controller = new AbortController()
  ;(async () => {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      onEvent(event as AgentEvent)
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) console.error("event stream failed:", error instanceof Error ? error.message : "error")
  })
  return () => controller.abort()
}

export async function listPending(client: Client, sessionID: string) {
  return client.permission.list({ sessionID })
}

export async function replyPermission(client: Client, sessionID: string, requestID: string, decision: "once" | "reject") {
  await client.permission.reply({ sessionID, requestID, decision })
}
