import {
  command,
  createSession,
  decide,
  inputsOf,
  pending,
  pluginReady,
  prompt,
  sessionModel,
  type AgentEvent,
  type Client,
  type Permission,
} from "./agent.ts";
import { refusal, store, type SlackFile } from "./attachments.ts";
import { commandOf, control, SERVER_COMMANDS } from "./commands.ts";
import type { Channel, Config } from "./config.ts";
import type { Approval, Db } from "./db.ts";
import {
  cardText,
  describeStep,
  openStep,
  setStep,
  startProgress,
  type Progress,
} from "./progress.ts";

const LIMIT = 3500;
const EDIT_MS = 1000;

export type SlackApi = {
  post: (channel: string, threadTs: string, text: string, blocks?: object[]) => Promise<string>;
  update: (channel: string, ts: string, text: string, blocks?: object[]) => Promise<void>;
  remove: (channel: string, ts: string) => Promise<void>;
  react: (channel: string, ts: string, name: string, on: boolean) => Promise<void>;
  ephemeral: (
    channel: string,
    user: string,
    threadTs: string | undefined,
    text: string,
  ) => Promise<void>;
  download: (url: string) => Promise<Response>;
};

export type Incoming = {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  mention: boolean;
  files: SlackFile[];
};

export type Runtime = { channel: Channel; client: Client; available: boolean };

type Run = {
  sessionId: string;
  channelId: string;
  threadTs: string;
  text: string;
  parts: string[];
  lastEdit: number;
  timer?: NodeJS.Timeout | undefined;
  retryAt?: number;
  // The progress card for the current execution, and the Slack message that started it.
  progress?: Progress | undefined;
  card?: string | undefined;
  cardEdit: number;
  cardTimer?: NodeJS.Timeout | undefined;
  trigger?: string | undefined;
};

// One prompt waiting for its turn. A project runs one prompt at a time so threads never edit files concurrently.
// command is set for OpenCode server commands such as /review; text is then the command's arguments.
type Job = {
  client: Client;
  sessionId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  text: string;
  files: { uri: string; name: string }[];
  command?: string;
};
type Queue = { running?: { sessionId: string; startedAt: number } | undefined; jobs: Job[] };
type Outcome = "done" | "failed" | "interrupted";
const TOOL_EVENTS = new Set([
  "permission.replied",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
] as const);
type ToolEvent = Extract<AgentEvent, { type: typeof TOOL_EVENTS extends Set<infer T> ? T : never }>;
const isToolEvent = (event: AgentEvent): event is ToolEvent =>
  (TOOL_EVENTS as Set<string>).has(event.type);

// A started prompt may not show as active yet; only treat a missing session as finished after this long.
const STALE_MS = 60_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : "error");
const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function blocks(summary: string, value?: string) {
  const section = { type: "section", text: { type: "mrkdwn", text: summary } };
  if (!value) return [section];
  const button = (action_id: string, text: string, style: string) => ({
    type: "button",
    action_id,
    style,
    value,
    text: { type: "plain_text", text },
  });
  return [
    section,
    {
      type: "actions",
      elements: [button("approve", "Approve", "primary"), button("reject", "Reject", "danger")],
    },
  ];
}

// Button values come back from Slack, so read them as untrusted JSON.
function buttonValue(value: string): { sessionId: string; requestId: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sessionId" in parsed) ||
    !("requestId" in parsed)
  )
    return undefined;
  const { sessionId, requestId } = parsed;
  return typeof sessionId === "string" && typeof requestId === "string"
    ? { sessionId, requestId }
    : undefined;
}

export function createRouter(
  config: Config,
  db: Db,
  slack: SlackApi,
  channels: Map<string, Runtime>,
  offer: (channelId: string, threadTs: string) => Promise<void>,
) {
  const runs = new Map<string, Run>();
  const queues = new Map<string, Queue>();
  // The Slack message each session's next execution answers, until its execution starts.
  const triggers = new Map<string, string>();
  let chain = Promise.resolve();
  // Run bridge tasks one at a time; a failed task is logged and never stops the chain.
  const later = (task: () => Promise<unknown>) => {
    chain = chain
      .then(async () => void (await task()))
      .catch((error: unknown) => console.error("bridge task failed:", errorText(error)));
  };
  const serial = (task: () => Promise<unknown>) => {
    later(task);
    return chain;
  };

  function runOf(sessionId: string): Run | undefined {
    if (runs.has(sessionId)) return runs.get(sessionId);
    const thread = db.threadBySession(sessionId);
    if (!thread) return;
    const run = {
      sessionId,
      channelId: thread.channel_id,
      threadTs: thread.thread_ts,
      text: "",
      parts: [],
      lastEdit: 0,
      cardEdit: 0,
    };
    runs.set(sessionId, run);
    return run;
  }

  async function flush(run: Run, force = false) {
    if (!run.text) return;
    if (!force && Date.now() - run.lastEdit < EDIT_MS) {
      run.timer ??= setTimeout(() => {
        run.timer = undefined;
        later(() => flush(run, true));
      }, EDIT_MS);
      return;
    }
    clearTimeout(run.timer);
    run.timer = undefined;
    const part = (i: number) => run.text.slice(i * LIMIT, (i + 1) * LIMIT);
    const markdown = (text: string) => [{ type: "markdown", text }];
    if (run.parts.length) {
      const text = part(run.parts.length - 1);
      await slack.update(run.channelId, run.parts.at(-1)!, text, markdown(text));
    }
    while (run.parts.length < Math.ceil(run.text.length / LIMIT)) {
      const text = part(run.parts.length);
      const ts = await slack.post(run.channelId, run.threadTs, text, markdown(text));
      db.addReply(ts, run.sessionId, run.channelId);
      run.parts.push(ts);
    }
    run.lastEdit = Date.now();
  }

  async function finish(run: Run, state: "done" | "failed", note?: string) {
    if (note) run.text = run.text ? `${run.text}\n\n${note}` : note;
    run.text ||= "The run finished.";
    await flush(run, true);
    for (const ts of run.parts) db.setReply(ts, state);
    Object.assign(run, { text: "", parts: [], lastEdit: 0 });
  }

  // The card is posted when an execution starts, so it stays above the answer messages.
  async function startCard(run: Run) {
    run.progress = startProgress();
    run.trigger = triggers.get(run.sessionId);
    triggers.delete(run.sessionId);
    const text = cardText(run.progress);
    run.card = await slack.post(run.channelId, run.threadTs, text, blocks(text));
    db.addReply(run.card, run.sessionId, run.channelId);
    run.cardEdit = Date.now();
  }

  async function paint(run: Run, force = false) {
    if (!run.progress || !run.card) return;
    if (!force && Date.now() - run.cardEdit < EDIT_MS) {
      run.cardTimer ??= setTimeout(() => {
        run.cardTimer = undefined;
        later(() => paint(run, true));
      }, EDIT_MS);
      return;
    }
    clearTimeout(run.cardTimer);
    run.cardTimer = undefined;
    const text = cardText(run.progress);
    await slack.update(run.channelId, run.card, text, blocks(text));
    run.cardEdit = Date.now();
  }

  // A run that used no tools needs no card, so it is deleted; otherwise it becomes a summary.
  async function endCard(run: Run, outcome: Outcome) {
    const { progress, card, trigger } = run;
    clearTimeout(run.cardTimer);
    Object.assign(run, {
      progress: undefined,
      card: undefined,
      cardTimer: undefined,
      trigger: undefined,
    });
    if (trigger) {
      const react = (name: string, on: boolean) =>
        slack.react(run.channelId, trigger, name, on).catch(() => undefined);
      await react("eyes", false);
      await react(outcome === "done" ? "white_check_mark" : "x", true);
    }
    if (!progress || !card) return;
    db.setReply(card, outcome === "done" ? "done" : "failed");
    if (!progress.steps.length) return slack.remove(run.channelId, card);
    const text = cardText(progress, outcome);
    await slack.update(run.channelId, card, text, blocks(text));
  }

  const queueOf = (projectDir: string) => {
    if (!queues.has(projectDir)) queues.set(projectDir, { jobs: [] });
    return queues.get(projectDir)!;
  };

  async function pump(queue: Queue) {
    while (!queue.running && queue.jobs.length) {
      const job = queue.jobs.shift()!;
      queue.running = { sessionId: job.sessionId, startedAt: Date.now() };
      triggers.set(job.sessionId, job.messageTs);
      slack.react(job.channelId, job.messageTs, "eyes", true).catch(() => undefined);
      try {
        if (job.command) await command(job.client, job.sessionId, job.command, job.text, job.files);
        else await prompt(job.client, job.sessionId, job.text, job.files);
      } catch (error) {
        queue.running = undefined;
        triggers.delete(job.sessionId);
        await slack.react(job.channelId, job.messageTs, "eyes", false).catch(() => undefined);
        await slack
          .post(
            job.channelId,
            job.threadTs,
            `The request failed: ${error instanceof Error ? error.message : "unknown error"}`,
          )
          .catch(() => undefined);
      }
    }
  }

  function release(sessionId: string) {
    for (const queue of queues.values()) {
      if (queue.running?.sessionId !== sessionId) continue;
      queue.running = undefined;
      pump(queue).catch((error: unknown) => console.error("queue failed:", errorText(error)));
    }
  }

  async function enqueue(projectDir: string, job: Job) {
    const queue = queueOf(projectDir);
    queue.jobs.push(job);
    const ahead = queue.jobs.length - 1 + (queue.running ? 1 : 0);
    if (ahead)
      await slack.post(
        job.channelId,
        job.threadTs,
        `Queued: ${ahead} ahead of this message in this project.`,
      );
    await pump(queue);
  }

  // Recovers from a lost completion event, such as an event stream drop or an OpenCode restart.
  async function unstick() {
    for (const [projectDir, queue] of queues) {
      const running = queue.running;
      if (!running || Date.now() - running.startedAt < STALE_MS) continue;
      const runtime = [...channels.values()].find((r) => r.channel.projectDir === projectDir);
      const active = runtime && (await runtime.client.session.active().catch(() => undefined));
      if (active && !(running.sessionId in active) && queue.running === running)
        release(running.sessionId);
    }
  }

  // Subagent sessions are not mapped; their requests go to the nearest mapped ancestor's thread.
  async function threadOf(client: Client, sessionId: string) {
    for (let id: string | undefined = sessionId, depth = 0; id && depth < 5; depth++) {
      const thread = db.threadBySession(id);
      if (thread) return thread;
      id = (await client.session.get({ sessionID: id }).catch(() => undefined))?.parentID;
    }
  }

  async function ask(request: Permission, client: Client) {
    const known = db.approval(request.id);
    if (known?.message_ts) return;
    const thread = known
      ? { channel_id: known.channel_id, thread_ts: known.thread_ts }
      : await threadOf(client, request.sessionID);
    // Nobody can approve a request without a thread, so it is refused rather than left waiting.
    if (!thread)
      return decide(client, request.sessionID, request.id, "reject").catch(() => undefined);
    const summary = `*Approval needed:* ${escape(request.action)}\n\`\`\`${escape(request.resources.join("\n"))}\`\`\``;
    if (!known) {
      db.addApproval({
        request_id: request.id,
        session_id: request.sessionID,
        channel_id: thread.channel_id,
        thread_ts: thread.thread_ts,
        summary,
        asked_at: Date.now(),
      });
    }
    const value = JSON.stringify({ sessionId: request.sessionID, requestId: request.id });
    db.setApprovalMessage(
      request.id,
      await slack.post(thread.channel_id, thread.thread_ts, summary, blocks(summary, value)),
    );
  }

  async function settle(row: Approval, note: string) {
    const text = `${row.summary}\n*${note}*`;
    if (row.message_ts) await slack.update(row.channel_id, row.message_ts, text, blocks(text));
  }

  async function sweep(client: Client, sessionId: string, note: string) {
    const live = new Set((await pending(client, sessionId)).map((request) => request.id));
    for (const row of db.pendingApprovals(sessionId)) {
      if (!live.has(row.request_id) && db.claim(row.request_id, "rejected"))
        await settle(row, note);
    }
  }

  // The step behind an approval request shows as waiting until the request is answered.
  async function waiting(run: Run | undefined, tool: string | undefined) {
    if (!run?.progress || !tool) return;
    setStep(run.progress, tool, "wait");
    await paint(run);
  }

  async function end(run: Run, outcome: Outcome, note?: string) {
    await finish(run, outcome === "done" ? "done" : "failed", note);
    await endCard(run, outcome);
  }

  // Tool and approval events only change the progress card.
  function track(run: Run, event: ToolEvent) {
    const progress = run.progress;
    if (!progress) return;
    switch (event.type) {
      case "permission.replied":
        setStep(progress, undefined, "run");
        break;
      case "session.tool.input.started":
        openStep(progress, event.data.id, event.data.name);
        break;
      case "session.tool.called":
        describeStep(
          progress,
          event.data.id,
          event.data.input,
          channels.get(run.channelId)?.channel.serverDir ?? "/",
        );
        break;
      case "session.tool.success":
      case "session.tool.failed":
        setStep(progress, event.data.id, event.type === "session.tool.success" ? "done" : "fail");
    }
    return paint(run);
  }

  async function apply(event: AgentEvent, client: Client) {
    const run = runOf(event.data.sessionID);
    if (event.type === "permission.asked") {
      await waiting(run, event.data.source?.id).catch((error: unknown) =>
        console.error("progress update failed:", errorText(error)),
      );
      return ask(event.data, client);
    }
    // Succeeded, failed or interrupted: the project's next queued prompt may start.
    if (event.type.startsWith("session.execution.") && event.type !== "session.execution.started")
      release(event.data.sessionID);
    if (!run) return;
    if (isToolEvent(event)) return track(run, event);
    switch (event.type) {
      case "session.execution.started":
        return startCard(run);
      // Separate text blocks, such as a note before tool calls and the final answer, get a paragraph break.
      case "session.text.started":
        if (run.text) run.text = `${run.text.trimEnd()}\n\n`;
        return;
      case "session.retry.scheduled":
        run.retryAt = event.data.at;
        return;
      case "session.inbox.delivered":
        if (run.text) await finish(run, "done");
        return;
      case "session.text.delta":
        run.text += event.data.delta;
        return flush(run);
      case "session.execution.succeeded":
        return end(run, "done");
      case "session.execution.failed":
        return end(
          run,
          "failed",
          event.data.error.status === 429
            ? `The provider rate limit was hit. Retry after ${run.retryAt ? new Date(run.retryAt).toISOString() : "later"}.`
            : `The run failed: ${event.data.error.message || "the agent could not complete the request."}`,
        );
      case "session.execution.interrupted":
        return end(run, "interrupted", "The run was interrupted.");
    }
  }

  async function handle(m: Incoming) {
    const threadTs = m.threadTs ?? m.ts;
    const thread = m.threadTs ? db.thread(m.teamId, m.channelId, m.threadTs) : undefined;
    if (!m.mention && !thread) return;
    const say = (text: string) => slack.post(m.channelId, threadTs, text);
    // main.ts already dropped other workspaces, so any member of a mapped channel may talk to its project.
    const runtime = channels.get(m.channelId);
    if (!runtime) {
      if (m.userId !== config.ownerUserId)
        return slack.ephemeral(
          m.channelId,
          m.userId,
          threadTs,
          "This channel is not mapped to a project. Only the owner can register one.",
        );
      if (m.text.trim().toLowerCase() === "register") return offer(m.channelId, threadTs);
      return say(
        "This channel is not mapped to a project. Mention me with `register` to connect a project folder.",
      );
    }
    runtime.available ||= await pluginReady(runtime.client);
    if (!runtime.available) return say("The project environment is unavailable.");

    const { client, channel } = runtime;
    const start = async (model: string) => {
      const id = await createSession(client, channel.serverDir, model);
      db.addThread({
        team_id: m.teamId,
        channel_id: m.channelId,
        thread_ts: threadTs,
        session_id: id,
      });
      return id;
    };
    const cmd = commandOf(m.text);
    if (cmd && !SERVER_COMMANDS.has(cmd.name))
      return say(await control(client, channel, cmd, thread?.session_id, start));

    // The thread's session may have switched models, so check attachments against the model it uses now.
    const model =
      m.files.length && thread
        ? await sessionModel(client, thread.session_id, channel.model)
        : channel.model;
    const inputs = m.files.length ? await inputsOf(client, model) : [];
    const refused = m.files.map((file) => refusal(file, inputs, model)).filter(Boolean);
    if (refused.length) return say(refused.join("\n"));
    const files = [];
    for (const file of m.files) files.push(await store(channel, threadTs, file, slack.download));

    const sessionId = thread?.session_id ?? (await start(channel.model));
    // Several people can share a thread, so the agent sees who sent each prompt. Command arguments stay as typed.
    const text = cmd ? cmd.args : `<@${m.userId}>: ${m.text.trim() || "sent the attached files."}`;
    await enqueue(channel.projectDir, {
      client,
      sessionId,
      channelId: m.channelId,
      threadTs,
      messageTs: m.ts,
      text,
      files,
      ...(cmd ? { command: cmd.name } : {}),
    });
  }

  async function click(
    userId: string,
    decision: "once" | "reject",
    value: string,
    channelId: string,
    threadTs?: string,
  ) {
    const refuse = (text: string) => slack.ephemeral(channelId, userId, threadTs, text);
    // Approvers count only in their channel; the thread check below binds the request to it.
    const approvers = config.channels[channelId]?.approvers ?? [];
    if (userId !== config.ownerUserId && !approvers.includes(userId))
      return refuse("Only the owner or this channel's approvers can approve or reject actions.");
    const button = buttonValue(value);
    if (!button) return console.error("click ignored: malformed button value");
    const { sessionId, requestId } = button;
    const row = db.approval(requestId);
    // The button must sit in the thread where the bridge asked.
    if (row && (row.channel_id !== channelId || row.thread_ts !== threadTs))
      return refuse("This button does not belong to this thread.");
    if (
      !row ||
      row.session_id !== sessionId ||
      !db.claim(requestId, decision === "once" ? "approved" : "rejected")
    ) {
      return refuse("This request was already decided.");
    }
    const { client } = channels.get(row.channel_id)!;
    try {
      await decide(client, sessionId, requestId, decision);
    } catch {
      db.reopen(requestId);
      return refuse("OpenCode did not accept the decision. Try again.");
    }
    await serial(async () => {
      await settle(
        row,
        decision === "once" ? `Approved once by <@${userId}>` : `Rejected by <@${userId}>`,
      );
      if (decision === "reject")
        await sweep(client, sessionId, "Rejected together with another request");
    });
  }

  async function expire() {
    const cutoff = Date.now() - config.approvalTimeoutMinutes * 60_000;
    for (const row of db.pendingApprovals()) {
      if (row.asked_at > cutoff || !db.claim(row.request_id, "expired")) continue;
      const { client } = channels.get(row.channel_id)!;
      await decide(client, row.session_id, row.request_id, "reject").catch(() => undefined);
      await settle(row, "Rejected because nobody answered in time");
      await sweep(client, row.session_id, "Rejected together with another request").catch(
        () => undefined,
      );
    }
  }

  async function recover() {
    for (const reply of db.streamingReplies()) {
      await slack.update(
        reply.channel_id,
        reply.message_ts,
        "The bridge restarted during the run.",
      );
      db.setReply(reply.message_ts, "failed");
    }
    for (const [channelId, { client, available }] of channels) {
      if (!available) continue;
      for (const thread of db.threads(channelId)) {
        const live = await pending(client, thread.session_id).catch(() => undefined);
        if (!live) continue;
        const ids = new Set(live.map((request) => request.id));
        for (const row of db.pendingApprovals(thread.session_id)) {
          if (!ids.has(row.request_id) && db.claim(row.request_id, "expired"))
            await settle(row, "No longer pending after a restart");
        }
        for (const request of live) await ask(request, client);
      }
    }
  }

  return {
    handle,
    click,
    onEvent: (event: AgentEvent, client: Client) => later(() => apply(event, client)),
    expire: () =>
      serial(async () => {
        await expire();
        await unstick();
      }),
    recover: () => serial(recover),
  };
}
