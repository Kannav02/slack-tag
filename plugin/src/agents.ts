import { posix } from "node:path";
import { readAsAgent } from "./attach.ts";
import { projectConfigDisabled } from "./worktree.ts";

// A per-thread worktree server runs with project config disabled (#53), which also turns off
// OpenCode's own loading of AGENTS.md, so worktree threads lose the project's instructions. Keep the
// cap small: AGENTS.md is guidance, not a document.
const MAX_BYTES = 32 * 1024;

// Reads the session directory's AGENTS.md as the agent user, through the same guarded path as
// slack_attach: a symlink or a planted path cannot reach a server-only file (#51, #58, #60). Returns
// the text, or undefined when project config is on (OpenCode already loads it, so injecting would
// double it), when the file is missing or unreadable, or when it is not text or larger than the cap.
export async function readAgentsMd(
  shell: string,
  directory: string | undefined,
): Promise<string | undefined> {
  if (!directory || !projectConfigDisabled()) return undefined;
  const path = posix.join(posix.resolve(directory), "AGENTS.md");
  const data = await readAsAgent(shell, path, MAX_BYTES).catch(() => undefined);
  if (!data?.length || data.length > MAX_BYTES || data.includes(0)) return undefined;
  const text = data.toString("utf8").trim();
  return text || undefined;
}
