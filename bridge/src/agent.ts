import { setTimeout as sleep } from "node:timers/promises";
import { OpenCode, type OpenCodeEvent } from "@opencode/client";
import { POLICY_VERSION } from "../../plugin/src/policy.ts";
import { definition } from "../../plugin/src/rpc.ts";

const handledEvents = [
  "permission.asked",
  "permission.replied",
  "session.retry.scheduled",
  "session.inbox.delivered",
  "session.text.started",
  "session.text.delta",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;
const handled = new Set<string>(handledEvents);

export type AgentEvent = Extract<OpenCodeEvent, { type: (typeof handledEvents)[number] }>;
export type Permission = {
  id: string;
  sessionID: string;
  action: string;
  resources: readonly string[];
};
export type Client = ReturnType<typeof connect>;

export function connect(baseUrl: string, password: string) {
  return OpenCode.make({
    baseUrl,
    headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
  });
}

export async function pluginReady(client: Client): Promise<boolean> {
  try {
    const status = (await client.rpc(definition).status({})) as {
      pluginVersion?: string;
      policyVersion?: number;
    };
    return Boolean(status.pluginVersion) && status.policyVersion === POLICY_VERSION;
  } catch {
    return false;
  }
}

export function modelOf(spec: string) {
  const slash = spec.indexOf("/");
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

const specOf = (ref: { providerID: string; id: string }) => `${ref.providerID}/${ref.id}`;

export async function createSession(
  client: Client,
  directory: string,
  model: string,
): Promise<string> {
  return (
    await client.session.create({ title: "slack", location: { directory }, model: modelOf(model) })
  ).id;
}

// OpenCode loads its model catalog in the background and lists no models until it finishes,
// so an empty list is retried for a few seconds before it is believed.
async function catalog(client: Client) {
  for (let attempt = 1; ; attempt++) {
    const { data } = await client.model.list();
    if (data.length || attempt === 10) return data;
    await sleep(500);
  }
}

export async function inputsOf(client: Client, model: string): Promise<readonly string[]> {
  const { providerID, id } = modelOf(model);
  const found = (await catalog(client)).find((m) => m.providerID === providerID && m.id === id);
  return found?.capabilities.input ?? [];
}

// Enabled models from the same provider as `model`, so the list only offers models the configured key can call.
export async function modelsOf(
  client: Client,
  model: string,
): Promise<{ spec: string; inputs: readonly string[] }[]> {
  const { providerID } = modelOf(model);
  return (await catalog(client))
    .filter((m) => m.providerID === providerID && m.enabled)
    .map((m) => ({ spec: specOf(m), inputs: m.capabilities.input }));
}

export async function sessionModel(
  client: Client,
  sessionID: string,
  fallback: string,
): Promise<string> {
  const { model } = await client.session.get({ sessionID });
  return model ? specOf(model) : fallback;
}

export async function switchModel(client: Client, sessionID: string, model: string) {
  await client.session.switchModel({ sessionID, model: modelOf(model) });
}

export async function prompt(
  client: Client,
  sessionID: string,
  text: string,
  files: { uri: string; name: string }[],
) {
  await client.session.prompt({ sessionID, text, files, delivery: "queue" });
}

export async function command(
  client: Client,
  sessionID: string,
  name: string,
  text: string,
  files: { uri: string; name: string }[],
) {
  await client.session.command({ sessionID, name, text, files, delivery: "queue" });
}

export async function interrupt(client: Client, sessionID: string): Promise<boolean> {
  return (await client.session.interrupt({ sessionID })).interrupted;
}

export async function compact(client: Client, sessionID: string) {
  await client.session.compact({ sessionID });
}

const isHandled = (event: OpenCodeEvent): event is AgentEvent => handled.has(event.type);

async function stream(client: Client, onEvent: (event: AgentEvent) => void) {
  for (;;) {
    try {
      for await (const event of client.event.subscribe()) if (isHandled(event)) onEvent(event);
    } catch (error) {
      console.error("event stream failed:", error instanceof Error ? error.message : "error");
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

export function subscribe(client: Client, onEvent: (event: AgentEvent) => void) {
  stream(client, onEvent).catch((error: unknown) =>
    console.error("event stream stopped:", error instanceof Error ? error.message : "error"),
  );
}

export async function pending(client: Client, sessionID: string): Promise<readonly Permission[]> {
  return client.permission.list({ sessionID });
}

export async function decide(
  client: Client,
  sessionID: string,
  requestID: string,
  decision: "once" | "reject",
) {
  await client.permission.reply({ sessionID, requestID, decision });
}
