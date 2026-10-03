import { dirname, join } from "node:path"
import bolt from "@slack/bolt"
import { connect, pluginReady, subscribe } from "./agent.ts"
import type { SlackFile } from "./attachments.ts"
import { loadConfig } from "./config.ts"
import { openDb } from "./db.ts"
import { createRouter, type Runtime, type SlackApi } from "./turn.ts"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const configPath = required("SLACK_TAG_CONFIG")
const botToken = required("SLACK_BOT_TOKEN")
const appToken = required("SLACK_APP_TOKEN")
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error")
const redact = (text: string) => text.replace(/xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g, "[redacted]")
const redactBlocks = (blocks?: object[]) => blocks?.map((block) =>
  "text" in block && typeof block.text === "string" ? { ...block, text: redact(block.text) } : block,
)

const config = loadConfig(configPath)
const db = openDb(join(dirname(configPath), "slack-tag.sqlite"))
const channels = new Map<string, Runtime>()
const passwords = new Set<string>()
for (const [id, channel] of Object.entries(config.channels)) {
  // Each server has its own password, so one project's agent cannot drive another project's server.
  const password = required(channel.passwordEnv)
  if (passwords.has(password)) throw new Error(`channel ${id} reuses another channel's server password`)
  passwords.add(password)
  const client = connect(channel.opencodeUrl, password)
  const available = await pluginReady(client)
  channels.set(id, { channel, client, available })
  console.log(`channel ${id} (${channel.name}) ${available ? "ready" : "unavailable"}`)
}

const app = new bolt.App({ token: botToken, appToken, socketMode: true, clientOptions: process.env.SLACK_API_URL ? { slackApiUrl: process.env.SLACK_API_URL } : {} })
const slack: SlackApi = {
  async post(channel, thread_ts, text, blocks) {
    const posted = await app.client.chat.postMessage({ channel, thread_ts, text: redact(text), blocks: redactBlocks(blocks) as never })
    if (!posted.ts) throw new Error("Slack did not return a message ts")
    return posted.ts
  },
  async update(channel, ts, text, blocks) {
    await app.client.chat.update({ channel, ts, text: redact(text), blocks: redactBlocks(blocks) as never })
  },
  async ephemeral(channel, user, thread_ts, text) {
    await app.client.chat.postEphemeral({ channel, user, ...(thread_ts === undefined ? {} : { thread_ts }), text })
  },
  download: (url) => fetch(url, { headers: { authorization: `Bearer ${botToken}` } }),
}
const router = createRouter(config, db, slack, channels)
const botId = (await app.client.auth.test()).user_id
const mention = `<@${botId}>`

for (const { client } of channels.values()) subscribe(client, router.onEvent)
await router.recover()
setInterval(() => void router.expire(), 15_000)

app.event("message", async ({ event, body }) => {
  const m = event as { subtype?: string; bot_id?: string; user?: string; text?: string; ts: string; thread_ts?: string; channel: string; files?: SlackFile[] }
  if ((m.subtype && m.subtype !== "file_share") || m.bot_id || !m.user) return
  const text = m.text ?? ""
  await router
    .handle({
      teamId: body.team_id ?? "",
      channelId: m.channel,
      userId: m.user,
      text: text.replaceAll(mention, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
      ts: m.ts,
      ...(m.thread_ts === undefined ? {} : { threadTs: m.thread_ts }),
      mention: text.includes(mention),
      files: m.files ?? [],
    })
    .catch(async (error: unknown) => {
      console.error("message failed:", redact(messageOf(error)))
      await slack.post(m.channel, m.thread_ts ?? m.ts, `The request failed: ${messageOf(error)}`).catch(() => undefined)
    })
})

for (const [actionId, decision] of [["approve", "once"], ["reject", "reject"]] as const) {
  app.action(actionId, async ({ ack, body, action }) => {
    await ack()
    const b = body as { user: { id: string }; channel?: { id: string }; message?: { ts: string; thread_ts?: string } }
    await router
      .click(b.user.id, decision, (action as { value: string }).value, b.channel?.id ?? "", b.message?.thread_ts ?? b.message?.ts)
      .catch((error: unknown) => console.error("click failed:", redact(messageOf(error))))
  })
}

await app.start()
console.log("bridge connected")
