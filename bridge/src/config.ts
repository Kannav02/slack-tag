import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// A channel's server password comes from a bridge.env variable (passwordEnv) for hand-made projects,
// or from the project's own env file (passwordFile) for projects registered from Slack.
export type StoredChannel = {
  name: string;
  projectDir: string;
  serverDir?: string;
  opencodeUrl: string;
  passwordEnv?: string;
  passwordFile?: string;
  model: string;
  serverInboxDir?: string;
  // When true, each new thread runs in its own Git worktree on a jeff/<slug> branch (see docs/project-mapping.md).
  // The server must disable project config (OPENCODE_CONFIG_PROJECT_DISABLE); otherwise worktree creation fails
  // and the thread falls back to the shared /project checkout.
  worktrees?: boolean;
  // Slack users who may approve or reject actions in this channel's threads, besides the owner.
  approvers?: string[];
};
export type Channel = StoredChannel & {
  serverDir: string;
  // Uploads: written by the bridge to inboxDir, read by the agent at serverInboxDir.
  inboxDir: string;
  serverInboxDir: string;
};
// start: "systemd" asks systemd to run deploy/start-project.sh as root (production, see docs/deploy.md);
// "script" (the default) runs it directly as the bridge's user, which then needs Docker access (development).
export type Onboarding = {
  projectsRoot: string;
  model: string;
  firstPort?: number;
  start?: "script" | "systemd";
};
export type Config = {
  ownerUserId: string;
  approvalTimeoutMinutes: number;
  channels: Record<string, Channel>;
  onboarding?: Onboarding;
};

const within = (parent: string, child: string) => !relative(parent, child).startsWith("..");
// Slack user IDs start with U, or W for Enterprise Grid users.
const isUserId = (user: unknown) => typeof user === "string" && /^[UW][A-Z0-9]+$/.test(user);

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Omit<Config, "channels"> & {
    channels: Record<string, StoredChannel>;
  };
  if (!config.ownerUserId || !config.channels)
    throw new Error("config needs ownerUserId and channels");
  if (config.onboarding && (!config.onboarding.projectsRoot || !config.onboarding.model))
    throw new Error("onboarding needs projectsRoot and model");
  if (config.onboarding?.start && !["script", "systemd"].includes(config.onboarding.start))
    throw new Error('onboarding.start must be "script" or "systemd"');
  const channels: Record<string, Channel> = {};
  for (const [id, channel] of Object.entries(config.channels))
    channels[id] = prepareChannel(path, id, channel);
  return { ...config, approvalTimeoutMinutes: config.approvalTimeoutMinutes ?? 30, channels };
}

// Checks a channel from config.json or from Slack registration, and places its upload inbox in the bridge state folder.
export function prepareChannel(configPath: string, id: string, channel: StoredChannel): Channel {
  for (const field of ["name", "projectDir", "opencodeUrl", "model"] as const) {
    if (!channel[field]) throw new Error(`channel ${id} is missing ${field}`);
  }
  if (!channel.passwordEnv === !channel.passwordFile)
    throw new Error(`channel ${id} needs exactly one of passwordEnv or passwordFile`);
  if (!/^[A-Za-z0-9_-]+$/.test(channel.name))
    throw new Error(`channel ${id} name may only use letters, digits, - and _`);
  const { approvers } = channel;
  if (approvers !== undefined && !(Array.isArray(approvers) && approvers.every(isUserId)))
    throw new Error(`channel ${id} approvers must be a list of Slack user IDs such as U0123456789`);
  const stateDir = dirname(resolve(configPath));
  const projectDir = resolve(channel.projectDir);
  if (within(projectDir, stateDir) || within(stateDir, projectDir)) {
    throw new Error(`channel ${id} projectDir must not be /, contain, or sit inside ${stateDir}`);
  }
  const serverDir = channel.serverDir ?? channel.projectDir;
  const inboxDir = join(stateDir, "inbox", channel.name);
  // Containers mount inboxDir read-only at /inbox; a host-run server reads it directly.
  return {
    ...channel,
    serverDir,
    inboxDir,
    serverInboxDir:
      channel.serverInboxDir ?? (serverDir === channel.projectDir ? inboxDir : "/inbox"),
  };
}

export function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

export function passwordOf(id: string, channel: Channel): string {
  const password = channel.passwordEnv
    ? process.env[channel.passwordEnv]
    : parseEnv(readFileSync(channel.passwordFile!, "utf8")).SLACK_TAG_PASSWORD;
  if (!password)
    throw new Error(
      channel.passwordEnv
        ? `${channel.passwordEnv} is required`
        : `channel ${id} has no SLACK_TAG_PASSWORD in ${channel.passwordFile}`,
    );
  return password;
}

// Re-read the file so operator edits survive, then replace it atomically.
export function saveChannel(path: string, id: string, channel: StoredChannel) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { channels: Record<string, StoredChannel> };
  raw.channels[id] = channel;
  writeFileSync(`${path}.tmp`, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
}
