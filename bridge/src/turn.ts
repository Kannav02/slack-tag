import type { DatabaseSync } from "node:sqlite"
import type { ChannelConfig } from "./config.ts"
import { findThread, insertThread } from "./db.ts"
import { createSession, inputCapabilities, promptSession, type AgentClient } from "./agent.ts"
import { decideFile, excludeInbox, storeFile, type IncomingFile, type StoredFile } from "./attachments.ts"

export type TurnInput = {
  teamId: string
  channelId: string
  threadTs: string
  userId: string
  text: string
  files: IncomingFile[]
  mentioned: boolean
}

export type TurnOutcome =
  | { action: "ignore" }
  | { action: "reply"; text: string; ran: false }
  | { action: "reply"; text: string; ran: true }

export async function handleTurn(opts: {
  db: DatabaseSync
  client: AgentClient
  ownerUserId: string
  channel: ChannelConfig | undefined
  token: string
  input: TurnInput
}): Promise<TurnOutcome> {
  const { input } = opts
  if (input.userId !== opts.ownerUserId) return { action: "ignore" }
  if (!opts.channel) {
    return { action: "reply", ran: false, text: "This channel is not mapped to a project." }
  }
  const existing = findThread(opts.db, input.teamId, input.channelId, input.threadTs)
  if (!existing && !input.mentioned && input.files.length === 0) return { action: "ignore" }
  if (!existing && !input.mentioned) return { action: "ignore" }

  const caps = input.files.length > 0 ? await inputCapabilities(opts.client, opts.channel.model) : []
  const rejected: string[] = []
  const accepted: Array<{ file: IncomingFile; kind: StoredFile["kind"] }> = []
  for (const file of input.files) {
    const decision = decideFile(file, caps, opts.channel.model)
    if (!decision.ok) rejected.push(decision.reply)
    else accepted.push({ file, kind: decision.kind })
  }
  if (rejected.length > 0) return { action: "reply", ran: false, text: rejected.join("\n") }

  const stored: StoredFile[] = []
  if (accepted.length > 0) {
    await excludeInbox(opts.channel.projectDir)
    for (const item of accepted) {
      stored.push(await storeFile({
        projectDir: opts.channel.projectDir,
        serverDir: opts.channel.serverDir,
        threadTs: input.threadTs,
        file: item.file,
        kind: item.kind,
        token: opts.token,
      }))
    }
  }

  let sessionId = existing?.session_id
  if (!sessionId) {
    sessionId = await createSession(opts.client, opts.channel.serverDir, opts.channel.model)
    insertThread(opts.db, {
      team_id: input.teamId,
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      session_id: sessionId,
    })
  }
  const text = input.text.trim() || "The owner sent the attached files."
  const reply = await promptSession(opts.client, sessionId, text, stored.map((file) => ({ uri: file.uri, name: file.name })))
  return { action: "reply", ran: true, text: reply }
}
