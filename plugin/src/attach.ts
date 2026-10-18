import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "@opencode/plugin";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_MS = 10 * 60_000;
const TYPES = /^(png|jpe?g|gif|webp|txt|log|md|json|csv|diff|patch)$/;
const IMAGE = /^(png|jpe?g|gif|webp)$/;
// An image must start with its format's signature, compared as hex; text must hold no NUL byte.
const SIGNATURE =
  /^(png:89504e470d0a1a0a|jpe?g:ffd8ff|gif:474946383[79]61|webp:52494646.{8}57454250)/;
// Runs as the agent's own user. The real path must equal the requested one, so no symlink is on the way,
// and only a regular file is read, up to one byte past the limit. The server cannot signal the agent's
// user, so the reader times itself out.
const READ = `[ "$(realpath -e -- "$1")" = "$1" ] && [ -f "$1" ] && exec timeout 10 head -c ${MAX_BYTES + 1} -- "$1"`;
const run = promisify(execFile);

type Attachment = { sessionID: string; name: string; data: Buffer; caption?: string; at: number };
// Accepted files wait until the bridge fetches them once; at most 8, for at most 10 minutes.
const pending = new Map<string, Attachment>();

export function take({ sessionID, id }: { sessionID: string; id: string }) {
  const file = pending.get(id);
  if (file?.sessionID !== sessionID || Date.now() - file.at > KEEP_MS) return {};
  pending.delete(id);
  return { name: file.name, data: file.data.toString("base64"), caption: file.caption ?? "" };
}

async function accept(shell: string, roots: string[], path: string) {
  const ext = posix.extname(path).slice(1).toLowerCase();
  if (!TYPES.test(ext))
    throw new Error("Refused: only png, jpg, gif, webp, txt, log, md, json, csv, diff and patch.");
  if (!roots.some((root) => path.startsWith(`${root}/`)))
    throw new Error(`Refused: only files in ${roots.join(", ")} can be attached.`);
  // A bare environment, so even the reader's own /proc/self/environ holds no secret.
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin" };
  const options = { encoding: "buffer", env, timeout: 15_000, maxBuffer: 2 * MAX_BYTES } as const;
  const { stdout } = await run(shell, ["-c", READ, "slack_attach", path], options).catch(() => {
    throw new Error("Refused: not a readable regular file, or a symlink is on its path.");
  });
  if (!stdout.length || stdout.length > MAX_BYTES)
    throw new Error("Refused: the file is empty or larger than 10 MB.");
  const hex = stdout.subarray(0, 12).toString("hex");
  if (IMAGE.test(ext) ? !SIGNATURE.test(`${ext}:${hex}`) : stdout.includes(0))
    throw new Error(`Refused: the content is not ${ext}.`);
  return stdout;
}

// slack_attach reads with the same shell and user as the agent's own commands, so it can never reach a
// file the agent could not read itself. The bridge fetches each accepted file once over the plugin RPC.
export async function attach(ctx: Plugin.Context, shell: string) {
  await ctx.tool.transform((tools) => {
    // Each session folder (location) has its own plugin instance.
    const directory = posix.resolve(ctx.location.directory);
    tools.add({
      name: "slack_attach",
      description:
        "Post a file to this Slack thread so people can see it, such as a screenshot, log or test output: " +
        "png, jpg, gif, webp, txt, log, md, json, csv, diff or patch, up to 10 MB, in the project or /tmp.",
      options: { codemode: false },
      input: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, caption: { type: "string", maxLength: 2000 } },
        required: ["path"],
      },
      execute: async (input, { sessionID }) => {
        const { path, caption } = input as { path: string; caption?: string };
        const full = posix.resolve(directory, path);
        const data = await accept(shell, [directory, "/project", "/tmp"], full);
        for (const [id, old] of pending)
          if (pending.size >= 8 || Date.now() - old.at > KEEP_MS) pending.delete(id);
        const [id, name] = [randomUUID(), posix.basename(full)];
        pending.set(id, { sessionID, name, data, at: Date.now(), ...(caption && { caption }) });
        return { content: `${name} will be posted to the thread.`, metadata: { slackAttach: id } };
      },
    });
  });
}
