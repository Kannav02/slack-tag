import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { text } from "node:stream/consumers"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const KEY = "go-key-test-only"

function portOf(server: Server) {
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return address.port
}

// Start the real proxy process against a fake OpenCode Go upstream and observe both sides.
test("key proxy swaps in the Go key, streams replies, and only forwards to its upstream", { timeout: 20_000 }, async (t) => {
  const received: { url: string | undefined; headers: IncomingHttpHeaders; body: string }[] = []
  const upstream = createServer((req, res) => {
    text(req)
      .then((body) => {
        received.push({ url: req.url, headers: req.headers, body })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write("data: one\n\n")
        setTimeout(() => res.end("data: two\n\n"), 50)
      })
      .catch(() => res.destroy())
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const upstreamUrl = `http://127.0.0.1:${portOf(upstream)}/zen/go/v1`

  let logs = ""
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "proxy/key-proxy.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH, OPENCODE_API_KEY: KEY, UPSTREAM_URL: upstreamUrl, PORT: "0", HOST: "127.0.0.1" },
  })
  child.stdout.on("data", (chunk: Buffer) => (logs += chunk.toString()))
  child.stderr.on("data", (chunk: Buffer) => (logs += chunk.toString()))
  t.after(() => {
    child.kill()
    upstream.close()
  })
  const deadline = Date.now() + 10_000
  while (!/listening on \d+/.test(logs) && Date.now() < deadline) await delay(50)
  const port = /listening on (\d+)/.exec(logs)?.[1]
  assert.ok(port, logs)
  const proxy = `http://127.0.0.1:${port}`

  const body = JSON.stringify({ model: "kimi-k2.7-code", stream: true })
  const reply = await fetch(`${proxy}/v1/chat/completions?x=1`, {
    method: "POST",
    headers: { authorization: "Bearer unused", "content-type": "application/json" },
    body,
  })
  assert.equal(reply.status, 200)
  assert.equal(await reply.text(), "data: one\n\ndata: two\n\n")
  assert.equal(received[0]?.url, "/zen/go/v1/chat/completions?x=1")
  assert.equal(received[0]?.headers.authorization, `Bearer ${KEY}`)
  assert.equal(received[0]?.body, body)

  await fetch(`${proxy}/v1/messages`, { method: "POST", headers: { "x-api-key": "unused" }, body: "{}" }).then((r) => r.text())
  assert.equal(received[1]?.headers["x-api-key"], KEY)
  assert.equal(received[1]?.headers.authorization, undefined)

  for (const path of ["/admin", "/v1/../admin", "/v2/chat"]) {
    const refused = await fetch(proxy + path, { method: "POST", body: "{}" })
    assert.equal(refused.status, 404, path)
  }
  assert.equal(received.length, 2, "refused paths never reach the upstream")

  upstream.close()
  upstream.closeAllConnections()
  const down = await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(down.status, 502)
  assert.ok(!(await down.text()).includes(KEY))
  assert.ok(!logs.includes(KEY), "the key never appears in proxy logs")
})
