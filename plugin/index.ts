import { Plugin } from "@opencode/plugin"
import { safeDecide, stripSecrets } from "./src/policy.ts"
import { definition, status } from "./src/rpc.ts"

export default Plugin.define({
  id: "slack-tag",
  async setup(ctx) {
    await ctx.rpc.register(definition, {
      status: async () => status(),
    })
    await ctx.permission.hook("evaluate", (input) => {
      const decision = safeDecide(input.action, input.resources)
      input.effect = decision.effect
      if (decision.message) input.message = decision.message
    })
    await ctx.shell.hook("create.before", (input) => {
      stripSecrets(input.env)
    })
  },
})
