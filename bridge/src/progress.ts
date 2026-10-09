import { posix } from "node:path";

// What the agent is doing during one run, built from OpenCode tool events and shown on the Slack progress card.
export type Step = {
  id: string;
  tool: string;
  target?: string | undefined;
  state: "run" | "done" | "fail" | "wait";
};
export type Progress = { startedAt: number; steps: Step[] };

const SHOWN = 8;
// Running and finished wording per OpenCode 2.0.15 tool name. Tool input never reaches Slack except a file path.
const VERBS: Record<string, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  write: ["Writing", "Wrote"],
  grep: ["Searching the code", "Searched the code"],
  glob: ["Searching the code", "Searched the code"],
  shell: ["Running a command", "Ran a command"],
  subagent: ["Delegating a task", "Delegated a task"],
  webfetch: ["Fetching a web page", "Fetched a web page"],
  websearch: ["Searching the web", "Searched the web"],
};
const FILE_TOOLS = new Set(["read", "edit", "write"]);
const ICONS = { run: "◌", done: "✓", fail: "✗", wait: "⏸" };

// A path inside the project is shown relative to it; anything else is not shown at all.
function targetOf(tool: string, input: Record<string, unknown>, root: string) {
  if (!FILE_TOOLS.has(tool) || typeof input.path !== "string") return undefined;
  const rel = posix.relative(root, posix.resolve(root, input.path));
  if (!rel || rel.startsWith("..") || posix.isAbsolute(rel)) return "a file outside the project";
  const clean = rel.replace(/[`<>&*_~|]/g, "");
  return clean.length > 80 ? `…${clean.slice(-79)}` : clean;
}

export const startProgress = (): Progress => ({ startedAt: Date.now(), steps: [] });

export function openStep(progress: Progress, id: string, tool: string) {
  if (!progress.steps.some((step) => step.id === id))
    progress.steps.push({ id, tool, state: "run" });
}

export function describeStep(
  progress: Progress,
  id: string,
  input: Record<string, unknown>,
  root: string,
) {
  const step = progress.steps.find((s) => s.id === id);
  if (step) step.target = targetOf(step.tool, input, root);
}

export function setStep(progress: Progress, id: string | undefined, state: Step["state"]) {
  for (const step of progress.steps)
    if (id === undefined ? step.state === "wait" : step.id === id) step.state = state;
}

function line(step: Step) {
  const name = step.tool.replace(/[^\w.-]/g, "");
  const [running, done] = VERBS[step.tool] ?? [`Using ${name}`, `Used ${name}`];
  const verb = step.state === "run" || step.state === "wait" ? running : done;
  return `${ICONS[step.state]} ${verb}${step.target ? ` \`${step.target}\`` : ""}`;
}

function elapsed(progress: Progress) {
  const seconds = Math.round((Date.now() - progress.startedAt) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The card's text: a header, then the latest steps. outcome is set once the run has ended.
export function cardText(progress: Progress, outcome?: "done" | "failed" | "interrupted") {
  const { steps } = progress;
  const count = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const header = outcome
    ? `*${{ done: "✓ Done", failed: "✗ Failed", interrupted: "Stopped" }[outcome]}* · ${count} · ${elapsed(progress)}`
    : steps.some((step) => step.state === "wait")
      ? "*Waiting for approval…*"
      : "*Working…*";
  const hidden = steps.length - SHOWN;
  const lines = steps.slice(-SHOWN).map(line);
  if (hidden > 0) lines.unshift(`+${hidden} earlier step${hidden === 1 ? "" : "s"}`);
  return [header, ...lines].join("\n");
}
