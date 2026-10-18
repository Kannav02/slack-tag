import type { AgentEvent } from "./agent.ts";
import type { SlackApi } from "./turn.ts";
import { sendFile } from "./upload.ts";

const MAX_CALLS = 200;
const MAX_CHARS = 2000;
const INTRO =
  "Shell commands of this /fix run, recorded by the bridge from OpenCode's tool events, not from " +
  "the model's reply. Each shows its result and the end of its output.";

type Call = { command?: string; result?: string; output?: string };
type FixRun = { channelId: string; threadTs: string; calls: Map<string, Call>; dropped: number };

const head = (text: string) => (text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text);
const tail = (text: string) => (text.length > MAX_CHARS ? `…${text.slice(-MAX_CHARS)}` : text);
const outputOf = (content: readonly { type: string; text?: string }[] = []) =>
  tail(content.map((part) => part.text?.trimEnd() ?? "").join("\n"));

// OpenCode 2.0.15 reports a non-zero exit as a successful shell call with metadata.exit, and a
// blocked or declined command as a failed call.
function resultOf({ exit, timeout, status }: Record<string, unknown> = {}) {
  if (timeout === true) return "timed out";
  if (typeof exit === "number") return `exit ${exit}`;
  return typeof status === "string" ? status : "finished";
}

// Fills in one shell call from its later tool events.
function update(call: Call, event: AgentEvent) {
  if (event.type === "session.tool.called") {
    const { command } = event.data.input as { command?: unknown };
    if (typeof command === "string") call.command = head(command);
  } else if (event.type === "session.tool.success") {
    call.result = resultOf(event.data.metadata);
    call.output = outputOf(event.data.content);
  } else if (event.type === "session.tool.failed") {
    call.result = `failed: ${event.data.error.message}`;
    call.output = outputOf(event.data.content);
  }
}

// The log's text, or undefined when no shell command ran.
function logOf({ calls, dropped }: FixRun) {
  const ran = [...calls.values()].filter((call) => call.command !== undefined);
  if (!ran.length) return;
  const entries = ran.map(({ command, result = "no result before the run ended", output }) =>
    [`$ ${command}`, `[${result}]`, output].filter(Boolean).join("\n"),
  );
  const note = dropped ? [`(Earlier commands not shown: ${dropped}.)`] : [];
  return `${[INTRO, ...note, ...entries].join("\n\n")}\n`;
}

// Records the shell calls of a /fix run's own session in memory until its execution settles, then
// uploads them to the thread, so the reply can be checked against what actually ran.
export function createFixLog(slack: SlackApi) {
  const runs = new Map<string, FixRun>();

  function add(run: FixRun, id: string) {
    run.calls.set(id, {});
    if (run.calls.size <= MAX_CALLS) return;
    run.calls.delete(run.calls.keys().next().value!);
    run.dropped++;
  }

  return {
    start(sessionId: string, channelId: string, threadTs: string) {
      runs.set(sessionId, { channelId, threadTs, calls: new Map(), dropped: 0 });
    },
    drop: (sessionId: string) => runs.delete(sessionId),
    // A settled run leaves the map before its upload, so the session's next /fix can start.
    async see(event: AgentEvent) {
      const run = runs.get(event.data.sessionID);
      if (!run) return;
      if (event.type === "session.tool.input.started" && event.data.name === "shell")
        return add(run, event.data.id);
      const call = "id" in event.data ? run.calls.get(event.data.id) : undefined;
      if (call) return update(call, event);
      if (!/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) return;
      runs.delete(event.data.sessionID);
      const log = logOf(run);
      const file = { name: "fix-commands.log", caption: "Commands Jeff ran for /fix" };
      if (log)
        await sendFile(slack, run.channelId, run.threadTs, { ...file, data: Buffer.from(log) });
    },
  };
}
