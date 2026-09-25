import bolt from "@slack/bolt"
import type { DatabaseSync } from "node:sqlite"
import type { AgentClient } from "./agent.ts"
import type { BridgeConfig } from "./config.ts"
import type { IncomingFile } from "./attachments.ts"
import { handleTurn } from "./turn.ts"

type SlackFile = {
  name?: string
  title?: string
  mimetype?: string
  size?: number
  url_private?: string
}

type SlackMessage = {
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  ts?: string
  thread_ts?: string
  channel?: string
  files?: SlackFile[]
}

export function startSlack(opts: {
  botToken: string
  appToken: string
  db: DatabaseSync
  client: AgentClient
  config: BridgeConfig
}): bolt.App {
  const app = new bolt.App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
  })
  app.message(async ({ message, client }) => {
    const event = message as SlackMessage
    if (!event.user || event.bot_id || !event.ts || !event.channel) return
    if (event.subtype && event.subtype !== "file_share") return
    const threadTs = event.thread_ts ?? event.ts
    const files = (event.files ?? []).map(toIncoming).filter((file): file is IncomingFile => file !== undefined)
    let outcome
    try {
      outcome = await handleTurn({
        db: opts.db,
        client: opts.client,
        ownerUserId: opts.config.ownerUserId,
        channel: opts.config.channels[event.channel],
        token: opts.botToken,
        input: {
          teamId: "slack",
          channelId: event.channel,
          threadTs,
          userId: event.user,
          text: event.text ?? "",
          files,
          mentioned: /<@[A-Z0-9]+>/.test(event.text ?? ""),
        },
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : "The run failed."
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text })
      return
    }
    if (outcome.action === "ignore") {
      if (event.user !== opts.config.ownerUserId) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: event.user,
          thread_ts: threadTs,
          text: "Only the owner can talk to OpenCode.",
        })
      }
      return
    }
    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: outcome.text })
  })
  return app
}

function toIncoming(file: SlackFile): IncomingFile | undefined {
  if (!file.url_private || file.size == null) return undefined
  return {
    name: file.name || file.title || "file",
    mimetype: file.mimetype,
    size: file.size,
    url: file.url_private,
  }
}
