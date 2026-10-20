import { dirname, join } from "node:path";
import bolt from "@slack/bolt";
import { BINARY } from "../../plugin/src/rpc.ts";
import { connect, pluginReady, subscribe } from "./agent.ts";
import type { SlackFile } from "./attachments.ts";
import { loadConfig, passwordOf } from "./config.ts";
import { openDb } from "./db.ts";
import { createOnboarding } from "./onboard.ts";
import { createRouter, type Runtime, type SlackApi } from "./turn.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const configPath = required("SLACK_TAG_CONFIG");
const botToken = required("SLACK_BOT_TOKEN");
const appToken = required("SLACK_APP_TOKEN");
// Only this origin receives the bot token. SLACK_FILES_URL exists for the simulated Slack in tests.
const filesOrigin = new URL(process.env.SLACK_FILES_URL ?? "https://files.slack.com").origin;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error");
const secrets: string[] = [];
const redact = (text: string) =>
  secrets.reduce(
    (out, secret) => out.replaceAll(secret, "[redacted]"),
    text.replace(/xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g, "[redacted]"),
  );
// Agent output must not notify a whole channel or workspace.
const quiet = (text: string) =>
  text
    .replace(/<!(channel|here|everyone)(\|[^>]*)?>/g, "@\u200b$1")
    .replace(/@(channel|here|everyone)\b/g, "@\u200b$1");
const clean = (text: string) => quiet(redact(text));
const cleanBlocks = (value: unknown, key?: string): unknown =>
  typeof value === "string"
    ? key === "text"
      ? clean(value)
      : value
    : Array.isArray(value)
      ? value.map((item) => cleanBlocks(item))
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanBlocks(v, k)]))
        : value;

async function download(url: string): Promise<Response> {
  for (let hops = 0; hops < 3; hops++) {
    if (new URL(url).origin !== filesOrigin)
      throw new Error(`refused to download from ${new URL(url).host}`);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${botToken}` },
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    url = new URL(location, url).href;
  }
  throw new Error("too many redirects");
}

const config = loadConfig(configPath);
const db = openDb(join(dirname(configPath), "slack-tag.sqlite"));
const channels = new Map<string, Runtime>();
const passwords = new Set<string>();
for (const [id, channel] of Object.entries(config.channels)) {
  // Each server has its own password, so one project's agent cannot drive another project's server.
  const password = passwordOf(id, channel);
  if (passwords.has(password))
    throw new Error(`channel ${id} reuses another channel's server password`);
  passwords.add(password);
  secrets.push(password);
  const client = connect(channel.opencodeUrl, password);
  const available = await pluginReady(client);
  channels.set(id, { channel, client, available });
  console.log(`channel ${id} (${channel.name}) ${available ? "ready" : "unavailable"}`);
}

const app = new bolt.App({
  token: botToken,
  appToken,
  socketMode: true,
  clientOptions: process.env.SLACK_API_URL ? { slackApiUrl: process.env.SLACK_API_URL } : {},
});
const slack: SlackApi = {
  async post(channel, thread_ts, text, blocks) {
    const posted = await app.client.chat.postMessage({
      channel,
      thread_ts,
      text: clean(text),
      blocks: cleanBlocks(blocks) as never,
    });
    if (!posted.ts) throw new Error("Slack did not return a message ts");
    return posted.ts;
  },
  async update(channel, ts, text, blocks) {
    await app.client.chat.update({
      channel,
      ts,
      text: clean(text),
      blocks: cleanBlocks(blocks) as never,
    });
  },
  async remove(channel, ts) {
    await app.client.chat.delete({ channel, ts });
  },
  async react(channel, timestamp, name, on) {
    if (on) await app.client.reactions.add({ channel, timestamp, name });
    else await app.client.reactions.remove({ channel, timestamp, name });
  },
  async ephemeral(channel, user, thread_ts, text) {
    await app.client.chat.postEphemeral({
      channel,
      user,
      ...(thread_ts === undefined ? {} : { thread_ts }),
      text: clean(text),
    });
  },
  download,
  // Slack's external upload flow. Text files get the same redaction as posts. Images and documents
  // cannot be redacted, and decoding them as text would corrupt them, so their bytes go unchanged.
  async upload(channel_id, thread_ts, { name, data, caption }) {
    const filename = name.replace(/[^\w.-]/g, "_");
    await app.client.files.uploadV2({
      channel_id,
      thread_ts,
      filename,
      file: BINARY.test(filename) ? data : Buffer.from(redact(data.toString("utf8"))),
      ...(caption ? { initial_comment: clean(caption) } : {}),
    });
  },
};
const onboarding = createOnboarding(
  config,
  configPath,
  slack,
  channels,
  (id, runtime, password) => {
    secrets.push(password);
    channels.set(id, runtime);
    subscribe(runtime.client, (event) => router.onEvent(event, runtime.client));
    console.log(`channel ${id} (${runtime.channel.name}) registered`);
  },
);
const router = createRouter(config, db, slack, channels, onboarding.offer);
const auth = await app.client.auth.test();
const botId = auth.user_id;
// The app could be installed elsewhere; only this workspace may drive it.
const teamId = auth.team_id;
const mention = `<@${botId}>`;

for (const { client } of channels.values())
  subscribe(client, (event) => router.onEvent(event, client));
await router.recover();
setInterval(() => void router.expire(), 15_000);

app.event("message", async ({ event, body }) => {
  const m = event as {
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    ts: string;
    thread_ts?: string;
    channel: string;
    files?: SlackFile[];
  };
  if (body.team_id !== teamId || (m.subtype && m.subtype !== "file_share") || m.bot_id || !m.user)
    return;
  const text = m.text ?? "";
  await router
    .handle({
      teamId,
      channelId: m.channel,
      userId: m.user,
      text: text
        .replaceAll(mention, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
      ts: m.ts,
      ...(m.thread_ts === undefined ? {} : { threadTs: m.thread_ts }),
      mention: text.includes(mention),
      files: m.files ?? [],
    })
    .catch(async (error: unknown) => {
      console.error("message failed:", redact(messageOf(error)));
      await slack
        .post(
          m.channel,
          m.thread_ts ?? m.ts,
          "The request failed. The details are in the bridge log.",
        )
        .catch(() => undefined);
    });
});

for (const [actionId, decision] of [
  ["approve", "once"],
  ["reject", "reject"],
] as const) {
  app.action(actionId, async ({ ack, body, action }) => {
    await ack();
    const b = body as {
      team?: { id: string };
      user: { id: string };
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
    };
    if (b.team?.id !== teamId) return;
    await router
      .click(
        b.user.id,
        decision,
        (action as { value: string }).value,
        b.channel?.id ?? "",
        b.message?.thread_ts ?? b.message?.ts,
      )
      .catch((error: unknown) => console.error("click failed:", redact(messageOf(error))));
  });
}

app.action("register_folder", async ({ ack, body, action }) => {
  await ack();
  const b = body as {
    team?: { id: string };
    user: { id: string };
    channel?: { id: string };
    message?: { ts: string };
  };
  if (b.team?.id !== teamId) return;
  const folder = (action as { selected_option?: { value: string } }).selected_option?.value ?? "";
  await onboarding
    .choose(b.user.id, b.channel?.id ?? "", b.message?.ts ?? "", folder)
    .catch((error: unknown) => console.error("register failed:", redact(messageOf(error))));
});

await app.start();
console.log("bridge connected");
