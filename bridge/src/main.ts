import { dirname, join } from "node:path"
import { App } from "@slack/bolt"
import { loadConfig } from "./config.ts"
import { openDb } from "./db.ts"
import { connect, pluginReady, subscribe } from "./agent.ts"
import { slackApi } from "./slack.ts"
import { createRouter, type ChannelRuntime } from "./turn.ts"

const configPath = process.env.SLACK_TAG_CONFIG
const password = process.env.OPENCODE_SERVER_PASSWORD
const botToken = process.env.SLACK_BOT_TOKEN
const appToken = process.env.SLACK_APP_TOKEN

if (!configPath) throw new Error("SLACK_TAG_CONFIG is required")
if (!password) throw new Error("OPENCODE_SERVER_PASSWORD is required")
if (!botToken) throw new Error("SLACK_BOT_TOKEN is required")
if (!appToken) throw new Error("SLACK_APP_TOKEN is required")

const config = loadConfig(configPath)
const db = openDb(join(dirname(configPath), "slack-tag.sqlite"))
const channels = new Map<string, ChannelRuntime>()

for (const [id, channel] of Object.entries(config.channels)) {
  const client = connect(channel.opencodeUrl, password)
  const available = await pluginReady(client)
  channels.set(id, { channel, client, available })
  console.log(available ? `channel ${id} (${channel.name}) ready` : `channel ${id} (${channel.name}) unavailable`)
}

const app = new App({ token: botToken, appToken, socketMode: true })
const slack = slackApi(app.client)
const router = createRouter(config, db, slack, channels)

for (const runtime of channels.values()) {
  subscribe(runtime.client, (event) => {
    void router.onEvent(event)
  })
}

for (const reply of db.streamingReplies()) {
  await slack.update(reply.channel_id, reply.message_ts, "The bridge restarted during the run.")
  db.setReplyState(reply.message_ts, "failed")
}

app.event("app_mention", async ({ event, body }) => {
  await router.handle({
    teamId: body.team_id ?? "",
    channelId: event.channel,
    userId: event.user ?? "",
    text: event.text ?? "",
    ts: event.ts,
    threadTs: event.thread_ts,
    mention: true,
  })
})

app.event("message", async ({ event, body }) => {
  if (event.subtype || event.bot_id) return
  const text = "text" in event ? event.text ?? "" : ""
  if (text.includes("<@")) return
  if (!("thread_ts" in event) || !event.thread_ts) return
  await router.handle({
    teamId: body.team_id ?? "",
    channelId: event.channel,
    userId: "user" in event ? event.user ?? "" : "",
    text,
    ts: event.ts,
    threadTs: event.thread_ts,
    mention: false,
  })
})

await app.start()
console.log("bridge connected")
