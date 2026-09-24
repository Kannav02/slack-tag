import { OpenCode } from "@opencode/client"

export function connect() {
  const password = process.env.OC_PASSWORD
  if (!password) throw new Error("OC_PASSWORD is required")
  return OpenCode.make({
    baseUrl: process.env.OC_URL ?? "http://127.0.0.1:4096",
    headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
  })
}

// Buffers every event so tests can wait for ones that already arrived.
export function recorder(client) {
  const events = []
  const waiters = []
  const controller = new AbortController()
  ;(async () => {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      events.push(event)
      for (const w of [...waiters]) {
        if (w.match(event)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(event)
        }
      }
    }
  })().catch((e) => {
    if (!controller.signal.aborted) console.error("event stream failed:", e)
  })

  return {
    events,
    stop: () => controller.abort(),
    waitFor(match, { timeout = 15000, since = 0 } = {}) {
      const found = events.slice(since).find(match)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const w = { match, resolve }
        waiters.push(w)
        setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error("timed out waiting for event"))
        }, timeout)
      })
    },
  }
}

export const sessionOf = (event) => event?.data?.sessionID ?? event?.properties?.sessionID ?? event?.sessionID
