import {
  compact,
  interrupt,
  modelOf,
  modelsOf,
  sessionModel,
  switchModel,
  type Client,
} from "./agent.ts";
import type { Channel, Config } from "./config.ts";

export type Command = { name: string; args: string };

// Every command a message can give after the mention. `help` lists this table, so it cannot go stale.
const COMMANDS = [
  { name: "model", usage: "/model [name]", about: "list the models, or switch this thread to one" },
  { name: "stop", usage: "/stop", about: "stop the current run" },
  { name: "compact", usage: "/compact", about: "shorten a long conversation by summarizing it" },
  { name: "init", usage: "/init", about: "write `AGENTS.md`, notes I read in every thread" },
  { name: "review", usage: "/review [what]", about: "review recent changes" },
  { name: "fix", usage: "/fix [problem]", about: "reproduce a problem, fix it and post the proof" },
  { name: "help", usage: "help", about: "show this guide" },
];
// `init`, `review` and the safety plugin's `fix` run as OpenCode server commands; the bridge handles the rest.
export const SERVER_COMMANDS = new Set(["init", "review", "fix"]);
const NAMES = new Set(COMMANDS.map((command) => command.name));
const NO_SESSION = "No session in this thread yet. Mention OpenCode with a request first.";
const LOADING = "OpenCode's model list is still loading. Try `/model` again in a moment.";

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Only known names are commands, so a prompt that starts with a path such as `/etc/hosts` stays a prompt.
// Arguments with !`…` stay a prompt too: a project's own command of the same name would run them on the server.
// A message that is only the word `help` asks for help too; "help me with …" stays a prompt.
export function commandOf(text: string): Command | undefined {
  if (text.trim().toLowerCase() === "help") return { name: "help", args: "" };
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

// What `help` replies and what a newly registered channel gets as its welcome. It reads the thread's model
// but never creates a session or prompts the model. `bot` is the bot's own mention, <@U…>.
export async function guide(
  client: Client,
  config: Config,
  channel: Channel,
  bot: string,
  sessionId?: string,
): Promise<string> {
  const current = sessionId ? await sessionModel(client, sessionId, channel.model) : channel.model;
  const recommended = config.recommendedModels;
  const models = recommended
    ? recommended.map(({ model, note }) => `• \`${model}\`${note ? `: ${escape(note)}` : ""}`)
    : (await modelsOf(client, channel.model)).slice(0, 3).map(({ spec }) => `• \`${spec}\``);
  const label = recommended ? " Recommended:" : " Available models include:";
  // The owner and this channel's approvers, as "<@A>, <@B> or <@C>".
  const approvers = [...new Set([config.ownerUserId, ...(channel.approvers ?? [])])]
    .map((id) => `<@${id}>`)
    .join(", ")
    .replace(/, ([^,]+)$/, " or $1");
  return [
    `Hi, I'm ${bot}, this channel's AI teammate. Here's how to work with me.`,
    "",
    `*Asking:* start a message with ${bot}. Each thread is one conversation: to continue it, reply in the thread and start with ${bot} again. I ignore messages that don't start with ${bot}, so people can also talk in the thread.`,
    "",
    `*Models:* ${sessionId ? "this thread uses" : "new threads use"} \`${current}\`.${models.length ? label : ""}`,
    ...models,
    "To switch a thread to another model, send `/model` and its name.",
    "",
    `*Commands*, after ${bot}:`,
    ...COMMANDS.map(({ usage, about }) => `• \`${usage}\`: ${about}`),
    "",
    "*How I show my work:*",
    "• A progress card shows my steps while I work.",
    "• I post files, screenshots and logs to the thread, including Word and PDF documents.",
    "• With `/fix`, I also post a log of the commands I ran, recorded automatically, not written by me.",
    "• When the project is connected to GitHub, I finish a task with a pull request link.",
    "",
    `*Approvals and stopping:* risky steps wait until ${approvers} approves them. To stop a run, press Stop on the progress card or send \`/stop\`.`,
  ].join("\n");
}
