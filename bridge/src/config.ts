import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs"

export type Channel = { name: string; projectDir: string; serverDir: string; opencodeUrl: string; model: string; password?: string }
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
  }
  return config
}

// Re-read the file so operator edits survive, then replace it atomically. It can hold project passwords.
export function saveChannel(path: string, id: string, channel: Channel) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { channels: Record<string, Channel> }
  raw.channels[id] = channel
  writeFileSync(`${path}.tmp`, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 })
  chmodSync(`${path}.tmp`, 0o600)
  renameSync(`${path}.tmp`, path)
}
