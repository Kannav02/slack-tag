import { readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

export type Channel = {
  name: string; projectDir: string; serverDir: string; opencodeUrl: string; passwordEnv: string; model: string
  // Uploads: written by the bridge to inboxDir, read by the agent at serverInboxDir.
  inboxDir: string; serverInboxDir: string
}
export type Config = { ownerUserId: string; approvalTimeoutMinutes: number; channels: Record<string, Channel> }

const within = (parent: string, child: string) => !relative(parent, child).startsWith("..")

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config
  if (!config.ownerUserId || !config.channels) throw new Error("config needs ownerUserId and channels")
  config.approvalTimeoutMinutes ??= 30
  const stateDir = dirname(resolve(path))
  for (const [id, channel] of Object.entries(config.channels)) {
    channel.serverDir ??= channel.projectDir
    for (const field of ["name", "projectDir", "opencodeUrl", "passwordEnv", "model"] as const) {
      if (!channel[field]) throw new Error(`channel ${id} is missing ${field}`)
    }
    if (!/^[A-Za-z0-9_-]+$/.test(channel.name)) throw new Error(`channel ${id} name may only use letters, digits, - and _`)
    const projectDir = resolve(channel.projectDir)
    if (within(projectDir, stateDir) || within(stateDir, projectDir)) {
      throw new Error(`channel ${id} projectDir must not be /, contain, or sit inside ${stateDir}`)
    }
    channel.inboxDir = join(stateDir, "inbox", channel.name)
    // Containers mount inboxDir read-only at /inbox; a host-run server reads it directly.
    channel.serverInboxDir ??= channel.serverDir === channel.projectDir ? channel.inboxDir : "/inbox"
  }
  return config
}
