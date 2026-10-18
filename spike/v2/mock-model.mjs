import { createServer } from "node:http"
import { appendFileSync } from "node:fs"

// Scripted OpenAI-compatible model. A user message containing `RUN: <command>`
// makes the model call the shell tool with that command; once the tool result
// arrives it answers with plain text. Anything else gets a plain text answer.
// Several RUN lines run one per step, in order, before the text answer.

const port = Number(process.env.MOCK_PORT ?? 4010)
const log = process.env.MOCK_LOG

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("")
  return ""
}

function plan(body) {
  const messages = body.messages ?? []
  const last = messages.at(-1)
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  const runs = [...textOf(lastUser?.content).matchAll(/RUN: (.+)/g)].map((m) => m[1].trim())
  const done = messages.slice(messages.indexOf(lastUser)).filter((m) => m.role === "tool").length
  if (last?.role === "tool" && done >= runs.length) return { text: `Command finished: ${textOf(last.content).slice(0, 200)}` }

  // `ATTACH: <json>` calls the safety plugin's slack_attach tool with those arguments.
  const attach = textOf(lastUser?.content).match(/ATTACH: (.+)/)
  if (attach) return { tool: { name: "slack_attach", args: JSON.parse(attach[1]) } }
  const shell = (body.tools ?? []).find((t) => ["shell", "bash"].includes(t.function?.name))
  if (runs[done] && shell) {
    const props = Object.keys(shell.function.parameters?.properties ?? {})
    const args = { command: runs[done] }
    if (props.includes("description")) args.description = "spike command"
    return { tool: { name: shell.function.name, args } }
  }
  return { text: "Hello from the mock model." }
}

function chunk(id, delta, finish = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

createServer((req, res) => {
  let raw = ""
  req.on("data", (d) => (raw += d))
  req.on("end", async () => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ data: [{ id: "mock", object: "model" }] }))
    }
    const body = raw ? JSON.parse(raw) : {}
    const step = plan(body)
    const user = textOf(body.messages?.findLast((m) => m.role === "user")?.content)
    const system = (body.messages ?? []).filter((m) => m.role === "system").map((m) => textOf(m.content))
    if (log) appendFileSync(log, JSON.stringify({ url: req.url, headers: req.headers, tools: body.tools?.map((t) => t.function?.name), user, system, step }) + "\n")

    const id = `mock-${Date.now()}`
    if (!body.stream) {
      const message = step.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${id}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }
        : { role: "assistant", content: step.text }
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({
        id,
        object: "chat.completion",
        model: "mock",
        choices: [{ index: 0, message, finish_reason: step.tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    if (step.tool) {
      res.write(chunk(id, { role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: step.tool.name, arguments: "" } }] }))
      res.write(chunk(id, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.tool.args) } }] }))
      res.write(chunk(id, {}, "tool_calls"))
    } else {
      res.write(chunk(id, { role: "assistant", content: "" }))
      for (const word of step.text.split(/(?<= )/)) {
        res.write(chunk(id, { content: word }))
        await new Promise((r) => setTimeout(r, 100))
      }
      res.write(chunk(id, {}, "stop"))
    }
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
    res.end("data: [DONE]\n\n")
  })
}).listen(port, "127.0.0.1", () => console.log(`mock model on :${port}`))
