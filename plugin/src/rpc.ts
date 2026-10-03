import { Rpc } from "@opencode/plugin/rpc";
import { PLUGIN_VERSION, POLICY_VERSION } from "./policy.ts";

export const definition = Rpc.define({
  id: "slack-tag",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          pluginVersion: { type: "string" },
          policyVersion: { type: "number" },
        },
        required: ["pluginVersion", "policyVersion"],
      },
    },
  },
  events: {},
});

export function status() {
  return { pluginVersion: PLUGIN_VERSION, policyVersion: POLICY_VERSION };
}
