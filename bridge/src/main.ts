import { connect } from "./agent.ts"
import { loadConfig } from "./config.ts"
import { openDb } from "./db.ts"
import { startSlack } from "./slack.ts"

const configPath = process.env.SLACK_TAG_CONFIG
const botToken = process.env.SLACK_BOT_TOKEN
const appToken = process.env.SLACK_APP_TOKEN
const password = process.env.OPENCODE_SERVER_PASSWORD
if (!configPath || !botToken || !appToken || !password) {
  throw new Error("SLACK_TAG_CONFIG, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and OPENCODE_SERVER_PASSWORD are required")
}

const config = await loadConfig(configPath)
const db = openDb(process.env.SLACK_TAG_DB ?? "slack-tag.sqlite")
const first = Object.values(config.channels)[0]
if (!first) throw new Error("no channels configured")
const client = connect(first.opencodeUrl, password)
const app = startSlack({ botToken, appToken, db, client, config })
await app.start()
console.log("slack-tag bridge is connected")
