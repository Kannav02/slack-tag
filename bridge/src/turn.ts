import { createSession, decide, inputsOf, pending, pluginReady, prompt, type AgentEvent, type Client, type Permission } from "./agent.ts"
import { refusal, store, type SlackFile } from "./attachments.ts"
import type { Channel, Config } from "./config.ts"
import type { Approval, Db } from "./db.ts"

const LIMIT = 3500
const EDIT_MS = 1000

export type SlackApi = {
  post(channel: string, threadTs: string, text: string, blocks?: object[]): Promise<string>
  update(channel: string, ts: string, text: string, blocks?: object[]): Promise<void>
  ephemeral(channel: string, user: string, threadTs: string | undefined, text: string): Promise<void>
  download(url: string): Promise<Response>
}

export type Incoming = {
  teamId: string
  channelId: string
  userId: string
  text: string
  ts: string
  threadTs?: string
  mention: boolean
  files: SlackFile[]
}

export type Runtime = { channel: Channel; client: Client; available: boolean }

type Run = { sessionId: string; channelId: string; threadTs: string; text: string; parts: string[]; lastEdit: number; timer?: NodeJS.Timeout | undefined; retryAt?: number }

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function blocks(summary: string, value?: string) {
  const section = { type: "section", text: { type: "mrkdwn", text: summary } }
  if (!value) return [section]
  const button = (action_id: string, text: string, style: string) => ({ type: "button", action_id, style, value, text: { type: "plain_text", text } })
  return [section, { type: "actions", elements: [button("approve", "Approve", "primary"), button("reject", "Reject", "danger")] }]
}

export function createRouter(config: Config, db: Db, slack: SlackApi, channels: Map<string, Runtime>) {
  const runs = new Map<string, Run>()
  let chain = Promise.resolve()
  const serial = (task: () => Promise<unknown>) => {
    chain = chain.then(async () => void (await task())).catch((error: unknown) => console.error("bridge task failed:", error instanceof Error ? error.message : "error"))
    return chain
  }

  function runOf(sessionId: string): Run | undefined {
    if (runs.has(sessionId)) return runs.get(sessionId)
    const thread = db.threadBySession(sessionId)
    if (!thread) return
    const run = { sessionId, channelId: thread.channel_id, threadTs: thread.thread_ts, text: "", parts: [], lastEdit: 0 }
    runs.set(sessionId, run)
    return run
  }

  async function flush(run: Run, force = false) {
    if (!run.text) return
    if (!force && Date.now() - run.lastEdit < EDIT_MS) {
      run.timer ??= setTimeout(() => {
        run.timer = undefined
        void serial(() => flush(run, true))
      }, EDIT_MS)
      return
    }
    clearTimeout(run.timer)
    run.timer = undefined
    const part = (i: number) => run.text.slice(i * LIMIT, (i + 1) * LIMIT)
    const markdown = (text: string) => [{ type: "markdown", text }]
    if (run.parts.length) {
      const text = part(run.parts.length - 1)
      await slack.update(run.channelId, run.parts.at(-1)!, text, markdown(text))
    }
    while (run.parts.length < Math.ceil(run.text.length / LIMIT)) {
      const text = part(run.parts.length)
      const ts = await slack.post(run.channelId, run.threadTs, text, markdown(text))
      db.addReply(ts, run.sessionId, run.channelId)
      run.parts.push(ts)
    }
    run.lastEdit = Date.now()
  }

  async function finish(run: Run, state: "done" | "failed", note?: string) {
    if (note) run.text = run.text ? `${run.text}\n\n${note}` : note
    run.text ||= "The run finished."
    await flush(run, true)
    for (const ts of run.parts) db.setReply(ts, state)
    Object.assign(run, { text: "", parts: [], lastEdit: 0 })
  }

  // Subagent sessions are not mapped; their requests go to the nearest mapped ancestor's thread.
  async function threadOf(client: Client, sessionId: string) {
    for (let id: string | undefined = sessionId, depth = 0; id && depth < 5; depth++) {
      const thread = db.threadBySession(id)
      if (thread) return thread
      id = (await client.session.get({ sessionID: id }).catch(() => undefined))?.parentID
    }
  }

  async function ask(request: Permission, client: Client) {
    const known = db.approval(request.id)
    if (known?.message_ts) return
    const thread = known ? { channel_id: known.channel_id, thread_ts: known.thread_ts } : await threadOf(client, request.sessionID)
    // Nobody can approve a request without a thread, so it is refused rather than left waiting.
    if (!thread) return decide(client, request.sessionID, request.id, "reject").catch(() => undefined)
    const summary = `*Approval needed:* ${escape(request.action)}\n\`\`\`${escape(request.resources.join("\n"))}\`\`\``
    if (!known) {
      db.addApproval({ request_id: request.id, session_id: request.sessionID, channel_id: thread.channel_id, thread_ts: thread.thread_ts, summary, asked_at: Date.now() })
    }
    const value = JSON.stringify({ sessionId: request.sessionID, requestId: request.id })
    db.setApprovalMessage(request.id, await slack.post(thread.channel_id, thread.thread_ts, summary, blocks(summary, value)))
  }

  async function settle(row: Approval, note: string) {
    const text = `${row.summary}\n*${note}*`
    if (row.message_ts) await slack.update(row.channel_id, row.message_ts, text, blocks(text))
  }

  async function sweep(client: Client, sessionId: string, note: string) {
    const live = new Set((await pending(client, sessionId)).map((request) => request.id))
    for (const row of db.pendingApprovals(sessionId)) {
      if (!live.has(row.request_id) && db.claim(row.request_id, "rejected")) await settle(row, note)
    }
  }

  async function apply(event: AgentEvent, client: Client) {
    const data = event.data ?? {}
    if (event.type === "permission.asked") return ask(data as Permission, client)
    const run = typeof data.sessionID === "string" ? runOf(data.sessionID) : undefined
    if (!run) return
    switch (event.type) {
      case "session.retry.scheduled":
        run.retryAt = data.at
        return
      case "session.inbox.delivered":
        if (run.text) await finish(run, "done")
        return
      case "session.text.delta":
        run.text += data.delta ?? ""
        return flush(run)
      case "session.execution.succeeded":
        return finish(run, "done")
      case "session.execution.failed":
        return finish(
          run,
          "failed",
          data.error?.status === 429
            ? `The provider rate limit was hit. Retry after ${run.retryAt ? new Date(run.retryAt).toISOString() : "later"}.`
            : `The run failed: ${data.error?.message ?? "the agent could not complete the request."}`,
        )
      case "session.execution.interrupted":
        return finish(run, "failed", "The run was interrupted.")
    }
  }

  async function handle(m: Incoming) {
    const threadTs = m.threadTs ?? m.ts
    const thread = m.threadTs ? db.thread(m.teamId, m.channelId, m.threadTs) : undefined
    if (!m.mention && !thread) return
    const say = (text: string) => slack.post(m.channelId, threadTs, text)
    if (m.userId !== config.ownerUserId) return slack.ephemeral(m.channelId, m.userId, threadTs, "Only the owner can talk to OpenCode here.")
    const runtime = channels.get(m.channelId)
    if (!runtime) return say("This channel is not mapped to a project.")
    runtime.available ||= await pluginReady(runtime.client)
    if (!runtime.available) return say("The project environment is unavailable.")

    const { client, channel } = runtime
    const inputs = m.files.length ? await inputsOf(client, channel.model) : []
    const refused = m.files.map((file) => refusal(file, inputs, channel.model)).filter(Boolean)
    if (refused.length) return say(refused.join("\n"))
    const files = []
    for (const file of m.files) files.push(await store(channel, threadTs, file, slack.download))

    let sessionId = thread?.session_id
    if (!sessionId) {
      sessionId = await createSession(client, channel.serverDir, channel.model)
      db.addThread({ team_id: m.teamId, channel_id: m.channelId, thread_ts: threadTs, session_id: sessionId })
    }
    await prompt(client, sessionId, m.text.trim() || "The owner sent the attached files.", files)
  }

  async function click(userId: string, decision: "once" | "reject", value: string, channelId: string, threadTs?: string) {
    const refuse = (text: string) => slack.ephemeral(channelId, userId, threadTs, text)
    if (userId !== config.ownerUserId) return refuse("Only the owner can approve or reject actions.")
    let parsed: { sessionId?: unknown; requestId?: unknown }
    try {
      parsed = JSON.parse(value)
    } catch {
      return console.error("click ignored: malformed button value")
    }
    const { sessionId, requestId } = parsed ?? {}
    if (typeof sessionId !== "string" || typeof requestId !== "string") return console.error("click ignored: malformed button value")
    const row = db.approval(requestId)
    // The button must sit in the thread where the bridge asked.
    if (row && (row.channel_id !== channelId || row.thread_ts !== threadTs)) return refuse("This button does not belong to this thread.")
    if (!row || row.session_id !== sessionId || !db.claim(requestId, decision === "once" ? "approved" : "rejected")) {
      return refuse("This request was already decided.")
    }
    const { client } = channels.get(row.channel_id)!
    try {
      await decide(client, sessionId, requestId, decision)
    } catch {
      db.reopen(requestId)
      return refuse("OpenCode did not accept the decision. Try again.")
    }
    await serial(async () => {
      await settle(row, decision === "once" ? `Approved once by <@${userId}>` : `Rejected by <@${userId}>`)
      if (decision === "reject") await sweep(client, sessionId, "Rejected together with another request")
    })
  }

  async function expire() {
    const cutoff = Date.now() - config.approvalTimeoutMinutes * 60_000
    for (const row of db.pendingApprovals()) {
      if (row.asked_at > cutoff || !db.claim(row.request_id, "expired")) continue
      const { client } = channels.get(row.channel_id)!
      await decide(client, row.session_id, row.request_id, "reject").catch(() => undefined)
      await settle(row, "Rejected because nobody answered in time")
      await sweep(client, row.session_id, "Rejected together with another request").catch(() => undefined)
    }
  }

  async function recover() {
    for (const reply of db.streamingReplies()) {
      await slack.update(reply.channel_id, reply.message_ts, "The bridge restarted during the run.")
      db.setReply(reply.message_ts, "failed")
    }
    for (const [channelId, { client, available }] of channels) {
      if (!available) continue
      for (const thread of db.threads(channelId)) {
        const live = await pending(client, thread.session_id).catch(() => undefined)
        if (!live) continue
        const ids = new Set(live.map((request) => request.id))
        for (const row of db.pendingApprovals(thread.session_id)) {
          if (!ids.has(row.request_id) && db.claim(row.request_id, "expired")) await settle(row, "No longer pending after a restart")
        }
        for (const request of live) await ask(request, client)
      }
    }
  }

  return {
    handle,
    click,
    onEvent: (event: AgentEvent, client: Client) => void serial(() => apply(event, client)),
    expire: () => serial(expire),
    recover: () => serial(recover),
  }
}
