import type { Ask } from "./agent.ts"
import { replyOnceOrReject, type connect } from "./agent.ts"

export type Decision = "once" | "reject"

export type Prompt = Ask & {
  state: "pending" | "approved" | "rejected"
  note?: string
}

type Client = ReturnType<typeof connect>

export function createApprovals(client: Client, ownerUserId: string) {
  const prompts: Prompt[] = []
  const listeners = new Set<() => void>()

  function notify() {
    for (const listener of listeners) listener()
  }

  return {
    prompts,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    post(ask: Ask) {
      if (prompts.some((prompt) => prompt.requestID === ask.requestID)) return
      prompts.push({ ...ask, state: "pending" })
      notify()
    },
    async decide(input: { userId: string; requestID: string; decision: Decision }) {
      const prompt = prompts.find((item) => item.requestID === input.requestID)
      if (!prompt || prompt.state !== "pending") {
        return { ok: false as const, reply: "already decided" }
      }
      if (input.userId !== ownerUserId) {
        return { ok: false as const, reply: "only the owner can approve" }
      }
      if (input.decision !== "once" && input.decision !== "reject") {
        return { ok: false as const, reply: "unsupported decision" }
      }
      await replyOnceOrReject(client, prompt, input.decision)
      prompt.state = input.decision === "once" ? "approved" : "rejected"
      prompt.note = input.decision === "once" ? "Approved once" : "Rejected"
      notify()
      return { ok: true as const, reply: prompt.note }
    },
  }
}
