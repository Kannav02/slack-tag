import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { App, SocketModeReceiver } from "@slack/bolt";
import { OpenCode } from "@opencode/client";

// Setup check only: no Slack connection, provider call, or project agent starts.
assert.equal(Bun.version, "1.4.0", "Use the pinned Bun runtime");
assert.equal(typeof App, "function");
assert.equal(typeof SocketModeReceiver, "function");
const client = OpenCode.make({ baseUrl: "http://127.0.0.1:1" });
assert.equal(typeof client.session.create, "function");
assert.equal(typeof client.session.prompt, "function");
assert.equal(typeof client.permission.reply, "function");
assert.equal(typeof client.event.subscribe, "function");

const db = new Database(":memory:");
try {
  db.run("CREATE TABLE setup_check (value TEXT NOT NULL)");
  db.run("INSERT INTO setup_check VALUES (?)", ["sqlite-ready"]);
  assert.deepEqual(db.query("SELECT value FROM setup_check").get(), { value: "sqlite-ready" });
} finally {
  db.close();
}
console.log("Dependency check passed: Bun, Bolt, OpenCode client imports, and SQLite.");
