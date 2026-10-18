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
    // A file slack_attach accepted, by the ID in its tool metadata, as base64. Empty once fetched or
    // expired, and for any other session.
    attachment: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { sessionID: { type: "string" }, id: { type: "string" } },
        required: ["sessionID", "id"],
      },
      output: { type: "object", additionalProperties: { type: "string" } },
    },
  },
  events: {},
});

export function status() {
  return { pluginVersion: PLUGIN_VERSION, policyVersion: POLICY_VERSION };
}
