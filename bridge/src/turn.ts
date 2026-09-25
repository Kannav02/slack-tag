import type { Channel, Config } from "./config.ts"
import type { Db } from "./db.ts"
import type { Client } from "./agent.ts"
import { createSession, prompt } from "./agent.ts"
import type { SlackApi } from "./slack.ts"

const LIMIT = 3500
const EDIT_MS = 1000

export type Incoming = {
  teamId: string
  channelId: string
  userId: string
  text: string
  ts: string
  threadTs?: string
  mention: boolean
}

type Live = {
  sessionId: string
  teamId: string
  channelId: string
  threadTs: string
  text: string
  parts: string[]
  lastEdit: number
  timer?: ReturnType<typeof setTimeout>
  busy: boolean
  pendingNext: boolean
  retryAt?: number
  failure?: string
}

export type ChannelRuntime = {
  channel: Channel
  client: Client
  available: boolean
}

export function createRouter(config: Config, db: Db, slack: SlackApi, channels: Map<string, ChannelRuntime>) {
  const live = new Map<string, Live>()

  function sessionOf(event: { data?: Record<string, unknown> }) {
    const id = event.data?.sessionID
    return typeof id === "string" ? id : undefined
  }

  async function flush(run: Live, force: boolean) {
    if (!run.text) return
    const now = Date.now()
    if (!force && now - run.lastEdit < EDIT_MS) {
      if (!run.timer) {
        run.timer = setTimeout(() => {
          run.timer = undefined
          void flush(run, true)
        }, EDIT_MS)
      }
      return
    }
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = undefined
    }
    const chunkCount = Math.max(1, Math.ceil(run.text.length / LIMIT))
    while (run.parts.length < chunkCount) {
      const index = run.parts.length
      const slice = run.text.slice(index * LIMIT, (index + 1) * LIMIT)
      const ts = await slack.post(run.channelId, run.threadTs, slice)
      db.insertReply(ts, run.sessionId, run.channelId)
      run.parts.push(ts)
    }
    const last = run.parts.length - 1
    const slice = run.text.slice(last * LIMIT, (last + 1) * LIMIT)
    await slack.update(run.channelId, run.parts[last], slice)
    run.lastEdit = Date.now()
  }

  async function finish(run: Live, state: "done" | "failed", extra?: string) {
    if (run.timer) clearTimeout(run.timer)
    if (extra) run.text = run.text ? `${run.text}\n\n${extra}` : extra
    if (!run.text) run.text = state === "done" ? "The run finished." : "The run failed."
    await flush(run, true)
    for (const ts of run.parts) db.setReplyState(ts, state)
    run.parts = []
    run.text = ""
    run.lastEdit = 0
  }

  let chain = Promise.resolve()

  async function apply(event: { type: string; data?: Record<string, unknown> }) {
    const sessionId = sessionOf(event)
    if (!sessionId) return
    const run = live.get(sessionId)
    if (!run) return

    if (event.type === "session.retry.scheduled" && typeof event.data?.at === "number") {
      run.retryAt = event.data.at
      return
    }
    if (event.type === "session.inbox.delivered" && run.pendingNext && (run.text || run.parts.length)) {
      await finish(run, "done")
      run.pendingNext = false
      run.busy = true
      return
    }
    if (event.type === "session.text.delta" && typeof event.data?.delta === "string") {
      run.busy = true
      run.text += event.data.delta
      await flush(run, false)
      return
    }
    if (event.type === "session.execution.succeeded") {
      await finish(run, "done")
      run.busy = false
      run.pendingNext = false
      return
    }
    if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
      const error = event.data?.error as { message?: string; status?: number } | undefined
      const interrupted = event.type === "session.execution.interrupted"
      let message = interrupted ? "The run was interrupted." : `The run failed: ${error?.message ?? "the agent could not complete the request."}`
      if (error?.status === 429) {
        const when = run.retryAt ? new Date(run.retryAt).toISOString() : "later"
        message = `The provider rate limit was hit. Retry after ${when}.`
      }
      await finish(run, "failed", message)
      run.busy = false
      run.pendingNext = false
    }
  }

  function onEvent(event: { type: string; data?: Record<string, unknown> }) {
    chain = chain.then(() => apply(event)).catch((error: unknown) => {
      console.error("event handling failed:", error instanceof Error ? error.message : "error")
    })
  }

  async function replyInThread(threadTs: string, channelId: string, text: string) {
    const ts = await slack.post(channelId, threadTs, text)
    return ts
  }

  async function handle(message: Incoming) {
    if (message.userId !== config.ownerUserId) {
      await slack.ephemeral(message.channelId, message.userId, "Only the owner can talk to OpenCode here.")
      return
    }

    const runtime = channels.get(message.channelId)
    const threadTs = message.threadTs ?? message.ts
    if (!runtime) {
      if (message.mention) await replyInThread(threadTs, message.channelId, "This channel is not mapped to a project.")
      return
    }
    if (!runtime.available) {
      if (message.mention || message.threadTs) {
        await replyInThread(threadTs, message.channelId, "The project environment is unavailable.")
      }
      return
    }

    const existing = db.thread(message.teamId, message.channelId, threadTs)
    if (!existing && !message.mention) return

    let sessionId = existing?.session_id
    if (!sessionId) {
      sessionId = await createSession(runtime.client, runtime.channel.serverDir, runtime.channel.model)
      db.insertThread({
        team_id: message.teamId,
        channel_id: message.channelId,
        thread_ts: threadTs,
        session_id: sessionId,
      })
    }

    let run = live.get(sessionId)
    if (!run) {
      run = {
        sessionId,
        teamId: message.teamId,
        channelId: message.channelId,
        threadTs,
        text: "",
        parts: [],
        lastEdit: 0,
        busy: false,
        pendingNext: false,
      }
      live.set(sessionId, run)
    }

    const text = message.text.replace(/<@[A-Z0-9]+>/g, "").trim()
    if (run.busy) {
      run.pendingNext = true
      await prompt(runtime.client, sessionId, text, "queue")
      return
    }
    run.busy = true
    await prompt(runtime.client, sessionId, text)
  }

  return { handle, onEvent }
}
