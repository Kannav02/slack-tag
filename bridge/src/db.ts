import { DatabaseSync } from "node:sqlite"

export type ThreadRow = {
  team_id: string
  channel_id: string
  thread_ts: string
  session_id: string
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    create table if not exists threads (
      team_id text not null,
      channel_id text not null,
      thread_ts text not null,
      session_id text not null,
      created_at text not null default (datetime('now')),
      primary key (team_id, channel_id, thread_ts)
    )
  `)
  return db
}

export function findThread(db: DatabaseSync, teamId: string, channelId: string, threadTs: string): ThreadRow | undefined {
  return db.prepare(
    "select team_id, channel_id, thread_ts, session_id from threads where team_id = ? and channel_id = ? and thread_ts = ?",
  ).get(teamId, channelId, threadTs) as ThreadRow | undefined
}

export function insertThread(db: DatabaseSync, row: ThreadRow): void {
  db.prepare(
    "insert into threads (team_id, channel_id, thread_ts, session_id) values (?, ?, ?, ?)",
  ).run(row.team_id, row.channel_id, row.thread_ts, row.session_id)
}
