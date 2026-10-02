import { readFileSync } from "node:fs"

export type Channel = { name: string; projectDir: string; serverDir: string; opencodeUrl: string; passwordEnv: string; model: string }
export type Config = { ownerUserId: string; approvalTimeoutMinutes: number; channels: Record<string, Channel> }

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config
  if (!config.ownerUserId || !config.channels) throw new Error("config needs ownerUserId and channels")
  config.approvalTimeoutMinutes ??= 30
  for (const [id, channel] of Object.entries(config.channels)) {
    channel.serverDir ??= channel.projectDir
    for (const field of ["name", "projectDir", "opencodeUrl", "passwordEnv", "model"] as const) {
      if (!channel[field]) throw new Error(`channel ${id} is missing ${field}`)
    }
  }
  return config
}
