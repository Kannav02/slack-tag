import { existsSync } from "node:fs";
import { Plugin } from "@opencode/plugin";
import { readAgentsMd } from "./src/agents.ts";
import { attach, take } from "./src/attach.ts";
import { fix } from "./src/fix.ts";
import { fastForwardPulls, safeDecide, stripSecrets } from "./src/policy.ts";
import { pullRequestTool } from "./src/pull-request.ts";
import { definition, status } from "./src/rpc.ts";
import { createWorktree } from "./src/worktree.ts";

const AGENT_SHELL = "/usr/local/bin/agent-shell";
const MULTIPLAYER =
  "You are in a multiplayer session in a shared Slack thread. Several people may send messages, " +
  "and each message starts with its sender's Slack mention, such as <@U123>:. Keep track of who " +
  "asked for what, address people by their mention when it helps, and do not assume that one " +
  "person agrees with another's request.";
// Several people read every reply, and some of them are not technical: lead with the result, keep it short.
const CONCISE =
  "Keep replies short and plain. Lead with the result or the answer, then only the details people " +
  "need. Do not narrate each step or paste long output unless asked; post a long log or file to the " +
  "thread with slack_attach instead. Technical terms, commands, paths and code are fine where they " +
  "are the precise words. When someone asks you to remember a preference for this project, add it " +
  "to the project's AGENTS.md so later threads follow it.";
const SCREENSHOT =
  "To show a web app you started, screenshot it with `playwright screenshot [--full-page] " +
  "[--viewport-size=W,H] [--wait-for-selector=S] [--wait-for-timeout=MS] [--timeout=MS] " +
  "http://localhost:PORT/path /tmp/name.png`. Use the installed playwright, not npx: this form runs " +
  "without approval. Keep screenshots in /tmp so they are not committed.";
// Only projects with the Git proxy can open pull requests, so only they get this instruction.
const PULL_REQUESTS =
  "Work on a jeff/<slug> branch and never commit to the default branch. At the end of any task " +
  "that changes files, commit, push the branch, call open_pull_request and share the pull request link.";

export default Plugin.define({
  id: "slack-tag",
  async setup(ctx) {
    await ctx.rpc.register(definition, {
      status: async () => status(),
      worktree: async (input) => createWorktree((input as { slug: string }).slug),
      attachment: async (input) => take(input as { sessionID: string; id: string }),
    });
    // Plugin tools never reach the permission hook, so opening a pull request asks no one.
    await ctx.tool.transform((tools) => tools.add(pullRequestTool(ctx.session)));
    await ctx.permission.hook("evaluate", (input) => {
      const decision = safeDecide(input.action, input.resources, input.metadata?.path);
      input.effect = decision.effect;
      if (decision.message) input.message = decision.message;
    });
    // In the container image, agent shells run as a separate user that cannot read the server's secrets.
    const agentShell = existsSync(AGENT_SHELL);
    const shell = agentShell ? AGENT_SHELL : "/bin/sh";
    await ctx.shell.hook("create.before", (input) => {
      stripSecrets(input.env);
      fastForwardPulls(input.env);
      if (agentShell) input.shell = AGENT_SHELL;
    });
    await attach(ctx, shell);
    await fix(ctx);
    // A worktree server has project config disabled, so OpenCode no longer auto-loads AGENTS.md (#57).
    // Read it once at startup, before any agent turn can edit its own worktree copy, and add it below.
    const agents = await readAgentsMd(shell, ctx.location?.directory);
    // Slack threads are shared: tell the model several people may write, each message tagged by the bridge.
    await ctx.session.hook("context", (input) => {
      input.system.push({ type: "text", text: MULTIPLAYER });
      input.system.push({ type: "text", text: CONCISE });
      input.system.push({ type: "text", text: SCREENSHOT });
      if (process.env.GIT_PROXY_URL) input.system.push({ type: "text", text: PULL_REQUESTS });
      if (agents) input.system.push({ type: "text", text: agents });
    });
  },
});
