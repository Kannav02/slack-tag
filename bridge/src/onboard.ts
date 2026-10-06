import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect, pluginReady } from "./agent.ts";
import {
  parseEnv,
  prepareChannel,
  saveChannel,
  type Config,
  type StoredChannel,
} from "./config.ts";
import type { Runtime, SlackApi } from "./turn.ts";

const exec = promisify(execFile);
const deploy = fileURLToPath(new URL("../../deploy/", import.meta.url));
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The only repository form registration clones; deploy/start-project.sh checks it again before cloning.
const REPO =
  /^git@github\.com:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git$/;
const READY_MS = 120_000;
// Ports above 1024 that fetch refuses to connect to ("bad port"), so the bridge could never reach a server there.
const FETCH_BLOCKED = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);
// The start script gets only what it needs from the bridge's environment: never the Slack tokens or other channels' passwords.
const PASSED =
  /^(PATH|HOME|USER|LANG|LC_\w+|TMPDIR|XDG_RUNTIME_DIR|DOCKER_\w+|SLACK_TAG_(RUNTIME|IMAGE|GIT_KEY|GIT_KNOWN_HOSTS)|PROXY_ENV_FILE)$/;

const section = (text: string) => [{ type: "section", text: { type: "mrkdwn", text } }];
const portOf = (url: string) => Number(new URL(url).port);
// Slack sends git@github.com as a mailto link (<mailto:git@github.com|git@github.com>) and other links in <>.
const unlink = (text: string) =>
  text.replace(/<[^|>]*\|([^>]*)>/g, "$1").replace(/<([^>]*)>/g, "$1");
const messageOf = (error: unknown) => {
  const e = error as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || "unknown error").slice(-500);
};

// The lowest network number no other registered project uses; project.yaml turns it into subnet and bridge name.
function netFor(others: Record<string, string>[]) {
  const used = new Set(others.map((env) => Number(env.SLACK_TAG_NET)));
  for (let net = 1; net <= 254; net++) if (!used.has(net)) return net;
  throw new Error("all 254 project networks are in use");
}

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer().once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

export function createOnboarding(
  config: Config,
  configPath: string,
  slack: SlackApi,
  channels: Map<string, Runtime>,
  add: (id: string, runtime: Runtime, password: string) => void,
) {
  const stateDir = join(dirname(configPath), "projects");
  let chain = Promise.resolve();

  const used = () => new Set(Object.values(config.channels).map((channel) => channel.projectDir));

  async function folders(root: string): Promise<string[]> {
    const taken = used();
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && FOLDER.test(e.name) && !taken.has(join(root, e.name)))
      .map((e) => e.name)
      .sort();
  }

  // `register` offers the existing folders; `register <GitHub SSH URL>` clones the repository instead.
  async function offer(channelId: string, threadTs: string, request: string) {
    const onboarding = config.onboarding;
    if (!onboarding)
      return void (await slack.post(
        channelId,
        threadTs,
        "This channel is not mapped to a project, and project registration is not configured.",
      ));
    const url = unlink(request).trim().split(/\s+/).slice(1).join(" ");
    if (url) return clone(channelId, threadTs, url);
    const names = await folders(await realpath(onboarding.projectsRoot));
    if (!names.length)
      return void (await slack.post(
        channelId,
        threadTs,
        `There are no unregistered folders in \`${onboarding.projectsRoot}\`.`,
      ));
    const text = `Choose the folder in \`${onboarding.projectsRoot}\` to connect to this channel.`;
    const select = {
      type: "static_select",
      action_id: "register_folder",
      placeholder: { type: "plain_text", text: "Project folder" },
      options: names
        .slice(0, 100)
        .map((name) => ({ text: { type: "plain_text", text: name }, value: name })),
    };
    await slack.post(channelId, threadTs, text, [
      ...section(text),
      { type: "actions", elements: [select] },
    ]);
  }

  async function clone(channelId: string, threadTs: string, url: string) {
    const folder = REPO.exec(url)?.[1];
    if (!folder)
      return void (await slack.post(
        channelId,
        threadTs,
        `\`${url}\` is not a GitHub SSH URL. Use \`git@github.com:<owner>/<repo>.git\`.`,
      ));
    const messageTs = await slack.post(channelId, threadTs, `Registering \`${folder}\`…`);
    chain = chain
      .then(() => register(channelId, messageTs, folder, url))
      .catch((error: unknown) => console.error("register failed:", messageOf(error)));
    return chain;
  }

  // Each step is safe to repeat, so choosing the folder again after a failure resumes the setup.
  // With a repository URL, the start script clones it into the folder, which must not exist yet.
  async function register(channelId: string, messageTs: string, folder: string, repo?: string) {
    const lines: string[] = [];
    const show = (line: string) => {
      lines.push(line);
      return slack.update(channelId, messageTs, lines.join("\n"), section(lines.join("\n")));
    };
    const existing = config.channels[channelId];
    if (existing) return show(`This channel is already connected to \`${existing.name}\`.`);
    const root = await realpath(config.onboarding!.projectsRoot);
    const projectDir = join(root, folder);
    const entry = FOLDER.test(folder) ? await lstat(projectDir).catch(() => undefined) : undefined;
    const name = folder.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    // A folder cloned by an earlier attempt resumes; any other existing folder is never overwritten.
    const cloned =
      repo &&
      (await readFile(join(stateDir, `${name}.env`), "utf8").then(parseEnv, () => undefined))
        ?.SLACK_TAG_REPO === repo;
    if (repo && entry && !cloned)
      return show(
        `\`${folder}\` already exists in \`${config.onboarding!.projectsRoot}\`. Mention me with \`register\` to choose it instead.`,
      );
    if (!repo && !entry?.isDirectory())
      return show(`\`${folder}\` is not a folder in \`${config.onboarding!.projectsRoot}\`.`);
    if (used().has(projectDir))
      return show(`\`${folder}\` is already connected to another channel.`);
    if (name.length > 40)
      return show(`\`${folder}\` is too long for a project name (40 characters at most).`);
    let step = "Starting the project";
    try {
      await show(`Registering \`${folder}\`${repo ? ` from \`${repo}\`` : ""}…`);
      const stored: StoredChannel = {
        name,
        projectDir,
        serverDir: "/project",
        opencodeUrl: "",
        passwordFile: join(stateDir, `${name}.env`),
        model: config.onboarding!.model,
      };
      const { port, password } = await envFor(name, projectDir, repo);
      stored.opencodeUrl = `http://127.0.0.1:${port}`;
      const channel = prepareChannel(configPath, channelId, stored);
      // Create the inbox before Docker would create the mount point as root.
      await mkdir(channel.inboxDir, { recursive: true, mode: 0o755 });
      if (config.onboarding!.start === "systemd") {
        await exec("systemctl", [
          "start",
          "--no-ask-password",
          `slack-tag-project@${name}.service`,
        ]);
      } else {
        const env = {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => PASSED.test(key))),
          SLACK_TAG_STATE_DIR: dirname(configPath),
          SLACK_TAG_PROJECTS_ROOT: root,
        };
        await exec("sh", [join(deploy, "start-project.sh"), name], { env });
      }
      await show(
        `✅ ${repo ? "Cloned, folder" : "Folder"} prepared and container \`slack-tag-${name}\` started on port ${port}`,
      );

      step = "Waiting for OpenCode";
      const client = connect(channel.opencodeUrl, password);
      const deadline = Date.now() + READY_MS;
      while (!(await pluginReady(client))) {
        if (Date.now() > deadline)
          throw new Error("the server did not answer with the safety plugin in time");
        await delay(1000);
      }
      await show("✅ OpenCode answered with the safety plugin");

      step = "Saving the channel";
      saveChannel(configPath, channelId, stored);
      config.channels[channelId] = channel;
      add(channelId, { channel, client, available: true }, password);
      await show("✅ Connected. Mention me in this channel to start.");
    } catch (error) {
      await show(
        `❌ ${step} failed: ${messageOf(error)}\nMention me with \`register\` to try again.`,
      );
    }
  }

  // Reuse the port, network and password from an earlier attempt, so a retry starts the same container.
  async function envFor(name: string, projectDir: string, repo?: string) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const file = join(stateDir, `${name}.env`);
    const others: Record<string, string>[] = [];
    for (const other of await readdir(stateDir)) {
      if (other.endsWith(".env") && join(stateDir, other) !== file)
        others.push(parseEnv(await readFile(join(stateDir, other), "utf8")));
    }
    const known = await readFile(file, "utf8").then(parseEnv, () => undefined);
    if (known) {
      if (known.SLACK_TAG_PROJECT !== projectDir)
        throw new Error(`${file} belongs to ${known.SLACK_TAG_PROJECT}`);
      // Env files written before projects had their own network get one now.
      if (!known.SLACK_TAG_NET) await appendFile(file, `SLACK_TAG_NET=${netFor(others)}\n`);
      return { port: Number(known.SLACK_TAG_PORT), password: known.SLACK_TAG_PASSWORD! };
    }
    const taken = new Set(
      Object.values(config.channels).map((channel) => portOf(channel.opencodeUrl)),
    );
    for (const other of others) taken.add(Number(other.SLACK_TAG_PORT));
    let port = config.onboarding!.firstPort ?? 4102;
    while (taken.has(port) || FETCH_BLOCKED.has(port) || !(await free(port))) port++;
    const password = randomBytes(24).toString("hex");
    await writeFile(
      file,
      `SLACK_TAG_PROJECT=${projectDir}\nSLACK_TAG_PORT=${port}\nSLACK_TAG_PASSWORD=${password}\nSLACK_TAG_NET=${netFor(others)}\n${repo ? `SLACK_TAG_REPO=${repo}\n` : ""}`,
      { mode: 0o600 },
    );
    return { port, password };
  }

  async function choose(userId: string, channelId: string, messageTs: string, folder: string) {
    if (userId !== config.ownerUserId)
      return slack.ephemeral(channelId, userId, undefined, "Only the owner can register projects.");
    if (!config.onboarding) return;
    chain = chain
      .then(() => register(channelId, messageTs, folder))
      .catch((error: unknown) => console.error("register failed:", messageOf(error)));
    return chain;
  }

  return { offer, choose };
}
