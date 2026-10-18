import { DatabaseSync } from "node:sqlite";

export type Thread = {
  team_id: string;
  channel_id: string;
  thread_ts: string;
  session_id: string;
  // The session's working directory. NULL for threads mapped before per-thread worktrees; those keep /project.
  directory?: string | null;
};
export type Reply = { message_ts: string; channel_id: string };
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";
export type Approval = {
  request_id: string;
  session_id: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string | null;
  summary: string;
  state: ApprovalState;
  asked_at: number;
};

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS threads (
      team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL,
      session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, channel_id, thread_ts)
    );
  `);
  // Added with per-thread worktrees; older databases keep their rows with a NULL directory (the /project checkout).
  try {
    db.exec("ALTER TABLE threads ADD COLUMN directory TEXT");
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS replies (
      message_ts TEXT PRIMARY KEY, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL,
      message_ts TEXT, summary TEXT NOT NULL, state TEXT NOT NULL, asked_at INTEGER NOT NULL, decided_at INTEGER
    );
  `);
  const get = <T>(sql: string, ...args: (string | number)[]) =>
    db.prepare(sql).get(...args) as T | undefined;
  const all = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as T[];
  const run = (sql: string, ...args: (string | number | null)[]) =>
    db.prepare(sql).run(...args).changes > 0;

  return {
    thread: (teamId: string, channelId: string, threadTs: string) =>
      get<Thread>(
        "SELECT * FROM threads WHERE team_id = ? AND channel_id = ? AND thread_ts = ?",
        teamId,
        channelId,
        threadTs,
      ),
    threadBySession: (sessionId: string) =>
      get<Thread>("SELECT * FROM threads WHERE session_id = ?", sessionId),
    threads: (channelId: string) =>
      all<Thread>("SELECT * FROM threads WHERE channel_id = ?", channelId),
    addThread: (t: Thread) =>
      run(
        "INSERT INTO threads (team_id, channel_id, thread_ts, session_id, created_at, directory) VALUES (?, ?, ?, ?, ?, ?)",
        t.team_id,
        t.channel_id,
        t.thread_ts,
        t.session_id,
        new Date().toISOString(),
        t.directory ?? null,
      ),

    addReply: (messageTs: string, sessionId: string, channelId: string) =>
      run("INSERT INTO replies VALUES (?, ?, ?, 'streaming')", messageTs, sessionId, channelId),
    setReply: (messageTs: string, state: "done" | "failed") =>
      run("UPDATE replies SET state = ? WHERE message_ts = ?", state, messageTs),
    streamingReplies: () =>
      all<Reply>("SELECT message_ts, channel_id FROM replies WHERE state = 'streaming'"),

    approval: (requestId: string) =>
      get<Approval>("SELECT * FROM approvals WHERE request_id = ?", requestId),
    pendingApprovals: (sessionId?: string) =>
      sessionId
        ? all<Approval>(
            "SELECT * FROM approvals WHERE state = 'pending' AND session_id = ?",
            sessionId,
          )
        : all<Approval>("SELECT * FROM approvals WHERE state = 'pending'"),
    addApproval: (a: Omit<Approval, "message_ts" | "state">) =>
      run(
        "INSERT OR IGNORE INTO approvals (request_id, session_id, channel_id, thread_ts, summary, state, asked_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        a.request_id,
        a.session_id,
        a.channel_id,
        a.thread_ts,
        a.summary,
        a.asked_at,
      ),
    setApprovalMessage: (requestId: string, messageTs: string) =>
      run("UPDATE approvals SET message_ts = ? WHERE request_id = ?", messageTs, requestId),
    claim: (requestId: string, state: Exclude<ApprovalState, "pending">) =>
      run(
        "UPDATE approvals SET state = ?, decided_at = ? WHERE request_id = ? AND state = 'pending'",
        state,
        Date.now(),
        requestId,
      ),
    reopen: (requestId: string) =>
      run(
        "UPDATE approvals SET state = 'pending', decided_at = NULL WHERE request_id = ?",
        requestId,
      ),
  };
}

export type Db = ReturnType<typeof openDb>;
