import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { connect, pluginReady } from "./agent.ts"
import { saveChannel, type Channel, type Config } from "./config.ts"
import type { Runtime, SlackApi } from "./turn.ts"

const exec = promisify(execFile)
const deploy = fileURLToPath(new URL("../../deploy/", import.meta.url))
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const READY_MS = 120_000
// Compose would let these shell variables override the project's env file, and Docker never needs the Slack tokens.
const WITHHELD = /^(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|OPENCODE_SERVER_PASSWORD|SLACK_TAG_(PASSWORD|PORT|PROJECT))$/

const section = (text: string) => [{ type: "section", text: { type: "mrkdwn", text } }]
const portOf = (url: string) => Number(new URL(url).port)
const messageOf = (error: unknown) => {
  const e = error as { stderr?: string; message?: string }
  return (e.stderr?.trim() || e.message || "unknown error").slice(-500)
}

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer().once("error", () => resolve(false))
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
  })

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
}

export function createOnboarding(config: Config, configPath: string, slack: SlackApi, channels: Map<string, Runtime>, add: (id: string, runtime: Runtime) => void) {
  const stateDir = join(dirname(configPath), "projects")
  let chain = Promise.resolve()

  const used = () => new Set(Object.values(config.channels).map((channel) => channel.projectDir))

  async function folders(root: string): Promise<string[]> {
    const taken = used()
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && FOLDER.test(e.name) && !taken.has(join(root, e.name))).map((e) => e.name).sort()
  }

  async function offer(channelId: string, threadTs: string) {
    const onboarding = config.onboarding
    if (!onboarding) return void (await slack.post(channelId, threadTs, "This channel is not mapped to a project, and project registration is not configured."))
    const names = await folders(await realpath(onboarding.projectsRoot))
    if (!names.length) return void (await slack.post(channelId, threadTs, `There are no unregistered folders in \`${onboarding.projectsRoot}\`.`))
    const text = `Choose the folder in \`${onboarding.projectsRoot}\` to connect to this channel.`
    const select = {
      type: "static_select",
      action_id: "register_folder",
      placeholder: { type: "plain_text", text: "Project folder" },
      options: names.slice(0, 100).map((name) => ({ text: { type: "plain_text", text: name }, value: name })),
    }
    await slack.post(channelId, threadTs, text, [...section(text), { type: "actions", elements: [select] }])
  }

  // Each step is safe to repeat, so choosing the folder again after a failure resumes the setup.
  async function register(channelId: string, messageTs: string, folder: string) {
    const lines: string[] = []
    const show = (line: string) => {
      lines.push(line)
      return slack.update(channelId, messageTs, lines.join("\n"), section(lines.join("\n")))
    }
    const existing = config.channels[channelId]
    if (existing) return show(`This channel is already connected to \`${existing.name}\`.`)
    const root = await realpath(config.onboarding!.projectsRoot)
    const projectDir = join(root, folder)
    const entry = FOLDER.test(folder) ? await lstat(projectDir).catch(() => undefined) : undefined
    if (!entry?.isDirectory()) return show(`\`${folder}\` is not a folder in \`${config.onboarding!.projectsRoot}\`.`)
    if (used().has(projectDir)) return show(`\`${folder}\` is already connected to another channel.`)

    const name = folder.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
    let step = "Preparing the folder"
    try {
      await show(`Registering \`${folder}\`…`)
      await exec("sh", [join(deploy, "prepare-project.sh"), projectDir])
      await show("✅ Folder prepared")

      step = "Starting the container"
      const { port, password } = await envFor(name, projectDir)
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !WITHHELD.test(key)))
      const file = join(stateDir, `${name}.env`)
      await exec("docker", ["compose", "-p", `slack-tag-${name}`, "-f", join(deploy, "project.yaml"), "--env-file", file, "up", "-d"], { env })
      await show(`✅ Container \`slack-tag-${name}\` started on port ${port}`)

      step = "Waiting for OpenCode"
      const opencodeUrl = `http://127.0.0.1:${port}`
      const client = connect(opencodeUrl, password)
      const deadline = Date.now() + READY_MS
      while (!(await pluginReady(client))) {
        if (Date.now() > deadline) throw new Error("the server did not answer with the safety plugin in time")
        await delay(1000)
      }
      await show("✅ OpenCode answered with the safety plugin")

      step = "Saving the channel"
      const channel: Channel = { name, projectDir, serverDir: "/project", opencodeUrl, model: config.onboarding!.model, password }
      saveChannel(configPath, channelId, channel)
      config.channels[channelId] = channel
      add(channelId, { channel, client, available: true })
      await show("✅ Connected. Mention me in this channel to start.")
    } catch (error) {
      await show(`❌ ${step} failed: ${messageOf(error)}\nMention me with \`register\` to try again.`)
    }
  }

  // Reuse the port and password from an earlier attempt, so a retry starts the same container.
  async function envFor(name: string, projectDir: string) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const file = join(stateDir, `${name}.env`)
    const known = await readFile(file, "utf8").then(parseEnv, () => undefined)
    if (known) {
      if (known.SLACK_TAG_PROJECT !== projectDir) throw new Error(`${file} belongs to ${known.SLACK_TAG_PROJECT}`)
      return { port: Number(known.SLACK_TAG_PORT), password: known.SLACK_TAG_PASSWORD! }
    }
    const taken = new Set(Object.values(config.channels).map((channel) => portOf(channel.opencodeUrl)))
    for (const other of await readdir(stateDir)) {
      if (other.endsWith(".env")) taken.add(Number(parseEnv(await readFile(join(stateDir, other), "utf8")).SLACK_TAG_PORT))
    }
    let port = config.onboarding!.firstPort ?? 4102
    while (taken.has(port) || !(await free(port))) port++
    const password = randomBytes(24).toString("hex")
    await writeFile(file, `SLACK_TAG_PROJECT=${projectDir}\nSLACK_TAG_PORT=${port}\nSLACK_TAG_PASSWORD=${password}\n`, { mode: 0o600 })
    return { port, password }
  }

  async function choose(userId: string, channelId: string, messageTs: string, folder: string) {
    if (userId !== config.ownerUserId) return slack.ephemeral(channelId, userId, undefined, "Only the owner can register projects.")
    if (!config.onboarding) return
    chain = chain.then(() => register(channelId, messageTs, folder)).catch((error: unknown) => console.error("register failed:", messageOf(error)))
    return chain
  }

  return { offer, choose }
}
