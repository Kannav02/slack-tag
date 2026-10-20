import { Rpc } from "@opencode/plugin/rpc";
import { PLUGIN_VERSION, POLICY_VERSION } from "./policy.ts";

// Attachments slack_attach accepts only with their format's signature: images and Word, ODT, EPUB and
// PDF documents. They cannot be redacted, so the bridge uploads them unchanged and redacts the rest.
export const BINARY = /\.(png|jpe?g|gif|webp|docx|odt|epub|pdf)$/i;

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
