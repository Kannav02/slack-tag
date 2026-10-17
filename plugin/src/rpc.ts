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
    // Creates a per-thread Git worktree on a jeff/<slug> branch and returns its directory.
    worktree: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: { directory: { type: "string" } },
        required: ["directory"],
      },
    },
  },
  events: {},
});

export function status() {
  return { pluginVersion: PLUGIN_VERSION, policyVersion: POLICY_VERSION };
}
