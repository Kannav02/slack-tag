import { existsSync } from "node:fs";
import { Plugin } from "@opencode/plugin";
import { safeDecide, stripSecrets } from "./src/policy.ts";
import { definition, status } from "./src/rpc.ts";

const AGENT_SHELL = "/usr/local/bin/agent-shell";

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
  },
});
