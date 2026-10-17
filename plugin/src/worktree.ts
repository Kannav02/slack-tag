import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// OpenCode loads config and plugins from a session's location directory (verified against 2.0.15),
// so a worktree is only safe when project config is disabled server-wide. The server reads the same
// env; mirror its check and refuse otherwise, so the bridge never runs a thread in an unsafe worktree.
const parse = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
export const projectConfigDisabled = () =>
  parse(process.env.OPENCODE_CONFIG_PROJECT_DISABLE) ||
  parse(process.env.OPENCODE_DISABLE_PROJECT_CONFIG);

// The slug comes from the bridge (trusted), but is used in a branch name and a path: validate defensively.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Runs in the server process (node, uid 1000), which may write the project's .git and the worktree base;
// the bridge (a sandboxed host user) cannot. A new worktree shares the main repo's read-only .git/config
// and hooks via its commondir, and git does not enable per-worktree config.
export async function createWorktree(slug: string): Promise<{ directory: string }> {
  if (!projectConfigDisabled())
    throw new Error("worktrees need OPENCODE_CONFIG_PROJECT_DISABLE on the server");
  const base = process.env.SLACK_TAG_WORKTREE_DIR;
  if (!base || !existsSync(base))
    throw new Error("SLACK_TAG_WORKTREE_DIR is not a usable directory");
  if (!SLUG.test(slug) || slug.includes("..")) throw new Error(`invalid worktree slug: ${slug}`);
  const root = process.cwd();
  const directory = join(base, slug);
  const branch = `jeff/${slug}`;
  if (existsSync(directory)) return { directory };
  const git = (args: string[]) => run("git", ["-C", root, ...args]);
  try {
    await git(["worktree", "add", "-b", branch, "--", directory, "HEAD"]);
  } catch {
    // The branch may already exist from an earlier worktree; attach a fresh checkout to it.
    await git(["worktree", "add", "--", directory, branch]);
  }
  return { directory };
}
