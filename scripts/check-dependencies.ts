import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- Bolt resolves from bridge/, not the root package.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { connect } from "../bridge/src/agent.ts";
import plugin from "../plugin/index.ts";

// Setup check only: no Slack connection, provider call, or project agent starts.
const bridgeRequire = createRequire(new URL("../bridge/package.json", import.meta.url));
const bolt: unknown = bridgeRequire("@slack/bolt");
assert.ok(typeof bolt === "object" && bolt !== null && "App" in bolt && "SocketModeReceiver" in bolt);
const { App, SocketModeReceiver } = bolt;
assert.ok(plugin);
assert.equal(process.versions.node.split(".")[0], "24", "Use Node 24");
assert.equal(typeof App, "function");
assert.equal(typeof SocketModeReceiver, "function");
const client = connect("http://127.0.0.1:1", "setup-check");
assert.equal(typeof client.session.create, "function");
assert.equal(typeof client.session.prompt, "function");
assert.equal(typeof client.permission.reply, "function");
assert.equal(typeof client.event.subscribe, "function");

const db = new DatabaseSync(":memory:");
try {
  db.exec("CREATE TABLE setup_check (value TEXT NOT NULL)");
  db.prepare("INSERT INTO setup_check VALUES (?)").run("sqlite-ready");
  assert.equal(db.prepare("SELECT value FROM setup_check").get()?.value, "sqlite-ready");
} finally {
  db.close();
}
console.log("Dependency check passed: Node, deployed Bolt/client/plugin imports, and SQLite.");
