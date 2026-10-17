import {
  compact,
  interrupt,
  modelOf,
  modelsOf,
  sessionModel,
  switchModel,
  type Client,
} from "./agent.ts";
import type { Channel } from "./config.ts";

export type Command = { name: string; args: string };

// `init`, `review` and the safety plugin's `fix` run as OpenCode server commands; the bridge handles the rest.
export const SERVER_COMMANDS = new Set(["init", "review", "fix"]);
const NAMES = new Set([...SERVER_COMMANDS, "model", "stop", "compact"]);
const NO_SESSION = "No session in this thread yet. Mention OpenCode with a request first.";
const LOADING = "OpenCode's model list is still loading. Try `/model` again in a moment.";

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Only known names are commands, so a prompt that starts with a path such as `/etc/hosts` stays a prompt.
// Arguments with !`…` stay a prompt too: a project's own command of the same name would run them on the server.
export function commandOf(text: string): Command | undefined {
  const match = text.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/);
  if (!match || !NAMES.has(match[1]!) || match[2]?.includes("!`")) return;
  return { name: match[1]!, args: (match[2] ?? "").trim() };
}

// Runs a bridge command and returns the reply to post. `start` creates the thread's session with a model.
export async function control(
  client: Client,
  channel: Channel,
  { name, args }: Command,
  sessionId: string | undefined,
  start: (model: string) => Promise<string>,
): Promise<string> {
  if (name === "model") return model(client, channel, args, sessionId, start);
  if (!sessionId) return NO_SESSION;
  if (name === "stop")
    return (await interrupt(client, sessionId))
      ? "Stopped the current run."
      : "Nothing is running in this thread.";
  await compact(client, sessionId);
  return "Compaction requested. It runs at the next step boundary.";
}

async function model(
  client: Client,
  channel: Channel,
  args: string,
  sessionId: string | undefined,
  start: (model: string) => Promise<string>,
) {
  const current = sessionId ? await sessionModel(client, sessionId, channel.model) : channel.model;
  const options = await modelsOf(client, channel.model);
  if (!options.length) return `*Current model:* \`${current}\`\n${LOADING}`;
  const list = [
    `*Current model:* \`${current}\``,
    "*Available models:*",
    ...options.map(
      (o) =>
        `• \`${o.spec}\`${o.inputs.includes("image") ? " (images)" : ""}${o.spec === current ? " (current)" : ""}`,
    ),
    "Switch with `/model <name>`.",
  ].join("\n");
  if (!args) return list;
  const chosen = args.includes("/") ? args : `${modelOf(channel.model).providerID}/${args}`;
  if (!options.some((o) => o.spec === chosen))
    return `\`${escape(chosen)}\` is not available.\n${list}`;
  if (sessionId) await switchModel(client, sessionId, chosen);
  else await start(chosen);
  return `Model set to \`${chosen}\` for this thread.`;
}
