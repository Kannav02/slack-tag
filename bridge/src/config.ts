import { readFile } from "node:fs/promises"

export type ChannelConfig = {
  name: string
  projectDir: string
  serverDir: string
  opencodeUrl: string
  model: string
}

export type BridgeConfig = {
  ownerUserId: string
  channels: Record<string, ChannelConfig>
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as BridgeConfig
  if (!raw.ownerUserId || !raw.channels) throw new Error("SLACK_TAG_CONFIG is missing ownerUserId or channels")
  for (const channel of Object.values(raw.channels)) {
    channel.serverDir ??= channel.projectDir
    if (!channel.projectDir || !channel.opencodeUrl || !channel.model) {
      throw new Error(`channel ${channel.name ?? "?"} is missing projectDir, opencodeUrl, or model`)
    }
  }
  return raw
}
