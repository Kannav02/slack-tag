import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin } from "@opencode/plugin";

const run = promisify(execFile);
const JEFF = /^jeff\/[\w-]+(?:[./][\w-]+)*$/;

// GitHub REST calls go through the project's Git proxy, which alone holds the credential.
async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const reply = await fetch(new URL(path, process.env.GIT_PROXY_URL), init);
  if (!reply.ok) throw new Error(`Git proxy: ${reply.status} ${await reply.text()}`);
  return (await reply.json()) as T;
}

export async function openPullRequest(directory: string, title: string, body: string) {
  if (!process.env.GIT_PROXY_URL) throw new Error("Pull requests are not set up for this project.");
  // Read-only Git in the session's folder: these commands run no hooks, pager or fsmonitor.
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd: directory })).stdout.trim();
  const head = await git("branch", "--show-current");
  if (!JEFF.test(head))
    throw new Error(`Use a jeff/<slug> branch, not ${head || "a detached HEAD"}.`);
  const origin = await git("config", "--get", "remote.origin.url");
  const repository = /([\w-]+)\/[\w.-]+?(?=(?:\.git)?\/?$)/.exec(origin);
  if (!repository) throw new Error(`origin ${origin} is not a GitHub repository.`);
  const repo = `/repos/${repository[0]}`;
  const { default_branch: base } = await github<{ default_branch: string }>(repo);
  if (head === base) throw new Error(`${head} is the default branch; use a jeff/<slug> branch.`);
  const query = new URLSearchParams({ head: `${repository[1]}:${head}`, state: "open" });
  const [open] = await github<{ html_url: string }[]>(`${repo}/pulls?${query}`);
  if (open) return open.html_url;
  const init = { method: "POST", body: JSON.stringify({ title, body, head, base }) };
  return (await github<{ html_url: string }>(`${repo}/pulls`, init)).html_url;
}

export const pullRequestTool = (session: Pick<Plugin.Context["session"], "get">) => ({
  name: "open_pull_request",
  description:
    "Open a GitHub pull request from the current jeff/<slug> branch into the default branch, " +
    "or find the one already open, and return its URL. Commit and push the branch first.",
  // Offered to the model directly, like OpenCode's built-in tools.
  options: { codemode: false },
  input: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title", "body"],
  },
  async execute(input: unknown, context: { readonly sessionID: string }) {
    const { title, body } = input as { title: string; body: string };
    const { location } = await session.get({ sessionID: context.sessionID });
    return { content: await openPullRequest(location.directory, title, body) };
  },
});
