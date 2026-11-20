import { definition } from "../../plugin/src/rpc.ts";
import type { AgentEvent, Client } from "./agent.ts";
import type { SlackApi } from "./turn.ts";

export type OutgoingFile = { name: string; data: Buffer; caption?: string };
export type ToolSuccess = Extract<AgentEvent, { type: "session.tool.success" }>;

// Uploads a file to a Slack thread; SlackApi.upload redacts the caption and text files, not images or
// documents. A failure is logged and noted in the thread, never thrown, so the run carries on. Returns
// whether it was posted.
export async function sendFile(
  slack: SlackApi,
  channelId: string,
  threadTs: string,
  file: OutgoingFile | Promise<OutgoingFile>,
): Promise<boolean> {
  try {
    await slack.upload(channelId, threadTs, await file);
    return true;
  } catch (error) {
    console.error("file upload failed:", error instanceof Error ? error.message : error);
    const note = "A file could not be attached. The details are in the bridge log.";
    await slack.post(channelId, threadTs, note).catch(() => undefined);
    return false;
  }
}

// Fetches a file slack_attach accepted from the plugin instance of the session's folder (location).
export async function attachment(client: Client, event: ToolSuccess, id: string) {
  const input = { sessionID: event.data.sessionID, id };
  const location = event.location ? { location: event.location } : {};
  const file = await client.rpc(definition).attachment(input, location);
  const { name, data, caption = "" } = file as Record<string, unknown>;
  if (typeof name !== "string" || typeof data !== "string" || typeof caption !== "string")
    throw new Error("the attachment expired or was already sent");
  return { name, data: Buffer.from(data, "base64"), caption };
}
