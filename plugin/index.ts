import { existsSync } from "node:fs";
import { Plugin } from "@opencode/plugin";
import { safeDecide, stripSecrets } from "./src/policy.ts";
import { definition, status } from "./src/rpc.ts";

const AGENT_SHELL = "/usr/local/bin/agent-shell";
const MULTIPLAYER =
  "You are in a multiplayer session in a shared Slack thread. Several people may send messages, " +
  "and each message starts with its sender's Slack mention, such as <@U123>:. Keep track of who " +
  "asked for what, address people by their mention when it helps, and do not assume that one " +
  "person agrees with another's request.";
const SCREENSHOT =
  "To show a web app you started, screenshot it with `playwright screenshot [--full-page] " +
  "[--viewport-size=W,H] [--wait-for-selector=S] [--wait-for-timeout=MS] [--timeout=MS] " +
  "http://localhost:PORT/path /tmp/name.png`. Use the installed playwright, not npx: this form runs " +
  "without approval. Keep screenshots in /tmp so they are not committed.";

export default Plugin.define({
  id: "slack-tag",
  async setup(ctx) {
    await ctx.rpc.register(definition, {
      status: async () => status(),
    });
    await ctx.permission.hook("evaluate", (input) => {
      const decision = safeDecide(input.action, input.resources);
      input.effect = decision.effect;
      if (decision.message) input.message = decision.message;
    });
    // In the container image, agent shells run as a separate user that cannot read the server's secrets.
    const agentShell = existsSync(AGENT_SHELL);
    await ctx.shell.hook("create.before", (input) => {
      stripSecrets(input.env);
      if (agentShell) input.shell = AGENT_SHELL;
    });
    // Slack threads are shared: tell the model several people may write, each message tagged by the bridge.
    await ctx.session.hook("context", (input) => {
      input.system.push({ type: "text", text: MULTIPLAYER });
      input.system.push({ type: "text", text: SCREENSHOT });
    });
  },
});
