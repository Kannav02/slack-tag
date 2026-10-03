import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs"

// A channel's server password comes from a bridge.env variable (passwordEnv) for hand-made projects,
// or from the project's own env file (passwordFile) for projects registered from Slack.
export type Channel = { name: string; projectDir: string; serverDir: string; opencodeUrl: string; passwordEnv?: string; passwordFile?: string; model: string }
export type Onboarding = { projectsRoot: string; model: string; firstPort?: number }
export type Config = { ownerUserId: string; approvalTimeoutMinutes: number; channels: Record<string, Channel>; onboarding?: Onboarding }

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config
  if (!config.ownerUserId || !config.channels) throw new Error("config needs ownerUserId and channels")
  if (config.onboarding && (!config.onboarding.projectsRoot || !config.onboarding.model)) throw new Error("onboarding needs projectsRoot and model")
  config.approvalTimeoutMinutes ??= 30
  for (const [id, channel] of Object.entries(config.channels)) {
    channel.serverDir ??= channel.projectDir
    for (const field of ["name", "projectDir", "opencodeUrl", "model"] as const) {
      if (!channel[field]) throw new Error(`channel ${id} is missing ${field}`)
    }
    if (!channel.passwordEnv === !channel.passwordFile) throw new Error(`channel ${id} needs exactly one of passwordEnv or passwordFile`)
  }
  return config
}

export function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
}

export function passwordOf(id: string, channel: Channel): string {
  const password = channel.passwordEnv
    ? process.env[channel.passwordEnv]
    : parseEnv(readFileSync(channel.passwordFile!, "utf8")).SLACK_TAG_PASSWORD
  if (!password) throw new Error(channel.passwordEnv ? `${channel.passwordEnv} is required` : `channel ${id} has no SLACK_TAG_PASSWORD in ${channel.passwordFile}`)
  return password
}

// Re-read the file so operator edits survive, then replace it atomically.
export function saveChannel(path: string, id: string, channel: Channel) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { channels: Record<string, Channel> }
  raw.channels[id] = channel
  writeFileSync(`${path}.tmp`, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 })
  chmodSync(`${path}.tmp`, 0o600)
  renameSync(`${path}.tmp`, path)
}
