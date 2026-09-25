import { OpenCode } from "@opencode/client"

export type AgentClient = ReturnType<typeof OpenCode.make>

export function connect(url: string, password: string): AgentClient {
  return OpenCode.make({
    baseUrl: url,
    headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
  })
}

export async function inputCapabilities(client: AgentClient, model: string): Promise<string[]> {
  const [providerID, ...rest] = model.split("/")
  const id = rest.join("/")
  const listed = await client.model.list()
  const match = listed.data.find((item) => item.providerID === providerID && item.id === id)
  if (!match) throw new Error(`model ${model} is not available`)
  return match.capabilities.input
}

export async function createSession(client: AgentClient, directory: string, model: string): Promise<string> {
  const [providerID, ...rest] = model.split("/")
  const session = await client.session.create({
    title: "slack",
    location: { directory },
    model: { providerID, id: rest.join("/") },
  })
  return session.id
}

export async function promptSession(
  client: AgentClient,
  sessionID: string,
  text: string,
  files: Array<{ uri: string; name: string }>,
): Promise<string> {
  const finished = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
  let reply = ""
  let end = ""
  const controller = new AbortController()
  const subscription = (async () => {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      const data = event.data as { sessionID?: string; delta?: string; text?: string; error?: { message?: string } }
      if (data?.sessionID !== sessionID) continue
      if (event.type === "session.text.delta") reply += data.delta ?? data.text ?? ""
      if (finished.has(event.type)) {
        end = event.type
        if (event.type !== "session.execution.succeeded") {
          reply = data.error?.message ? `The run failed: ${data.error.message}` : "The run failed."
        }
        controller.abort()
      }
    }
  })()
  await new Promise((resolve) => setTimeout(resolve, 300))
  await client.session.prompt({
    sessionID,
    text,
    files: files.map((file) => ({ uri: file.uri, name: file.name })),
    delivery: "queue",
  })
  const deadline = Date.now() + 180_000
  while (!end && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
  controller.abort()
  await subscription.catch(() => undefined)
  if (!end) throw new Error("the agent did not finish")
  return reply.trim()
}
