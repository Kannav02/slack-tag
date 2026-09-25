import { readFileSync } from "node:fs"

export type Channel = {
  name: string
  projectDir: string
  serverDir: string
  opencodeUrl: string
  model: string
}

export type Config = {
  ownerUserId: string
  approvalTimeoutMinutes: number
  channels: Record<string, Channel>
}

const channelFields = ["name", "projectDir", "serverDir", "opencodeUrl", "model"] as const

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Config
  if (!raw.ownerUserId) throw new Error("config is missing ownerUserId")
  if (!raw.channels || typeof raw.channels !== "object") throw new Error("config is missing channels")
  for (const [id, channel] of Object.entries(raw.channels)) {
    for (const field of channelFields) {
      if (!channel?.[field]) throw new Error(`channel ${id} is missing ${field}`)
    }
  }
  return raw
}
