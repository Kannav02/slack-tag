import { DatabaseSync } from "node:sqlite"

export type ThreadRow = {
  team_id: string
  channel_id: string
  thread_ts: string
  session_id: string
}

export type ReplyRow = {
  message_ts: string
  channel_id: string
}

export function openDb(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS threads (
      team_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, channel_id, thread_ts)
    );
    CREATE TABLE IF NOT EXISTS replies (
      message_ts TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      state TEXT NOT NULL
    );
  `)

  return {
    thread(teamId: string, channelId: string, threadTs: string): ThreadRow | undefined {
      return db.prepare(
        "SELECT team_id, channel_id, thread_ts, session_id FROM threads WHERE team_id = ? AND channel_id = ? AND thread_ts = ?",
      ).get(teamId, channelId, threadTs) as ThreadRow | undefined
    },
    insertThread(row: ThreadRow) {
      db.prepare(
        "INSERT INTO threads (team_id, channel_id, thread_ts, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(row.team_id, row.channel_id, row.thread_ts, row.session_id, new Date().toISOString())
    },
    insertReply(messageTs: string, sessionId: string, channelId: string) {
      db.prepare(
        "INSERT INTO replies (message_ts, session_id, channel_id, state) VALUES (?, ?, ?, 'streaming')",
      ).run(messageTs, sessionId, channelId)
    },
    setReplyState(messageTs: string, state: "done" | "failed") {
      db.prepare("UPDATE replies SET state = ? WHERE message_ts = ?").run(state, messageTs)
    },
    streamingReplies(): ReplyRow[] {
      return db.prepare(
        "SELECT message_ts, channel_id FROM replies WHERE state = 'streaming'",
      ).all() as unknown as ReplyRow[]
    },
  }
}

export type Db = ReturnType<typeof openDb>
