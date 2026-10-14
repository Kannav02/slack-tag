import { createServer } from "node:http"
import { appendFileSync } from "node:fs"

// Scripted OpenAI-compatible model for recording a realistic multi-step run.
// Each stage is chosen by how many tool results the conversation already has:
//   0: reasoning + a sentence + read README.md
//   1: a sentence + grep and a read of a missing file (two tools in one step)
//   3: a shell command, which the spike config makes ask for approval
//   4: the final answer
// Tool arguments are filled from each tool's own JSON schema, so the recording shows real input fields.

const port = Number(process.env.MOCK_PORT ?? 4010)
const log = process.env.MOCK_LOG

function toolArgs(tool, values) {
  const props = Object.keys(tool.function.parameters?.properties ?? {})
  const args = {}
  for (const prop of props) {
    for (const [pattern, value] of values) if (pattern.test(prop) && !(prop in args)) args[prop] = value
  }
  if (props.includes("description")) args.description = "recording step"
  return args
}

function plan(body) {
  const messages = body.messages ?? []
  const lastUser = messages.findLastIndex((m) => m.role === "user")
  const results = messages.slice(lastUser).filter((m) => m.role === "tool").length
  const tools = new Map((body.tools ?? []).map((t) => [t.function?.name, t]))
  const call = (name, values) => (tools.has(name) ? [{ name, args: toolArgs(tools.get(name), values) }] : [])
  const dir = process.env.PROJECT_DIR ?? "."
  if (results === 0)
    return {
      reasoning: "The user wants a look around. Start with the readme.",
      text: "Let me check the readme first.",
      tools: call("read", [[/path/i, `${dir}/README.md`]]),
    }
  if (results === 1)
    return {
      text: "Two more checks.",
      tools: [...call("grep", [[/pattern/i, "spike"], [/path/i, dir]]), ...call("read", [[/path/i, `${dir}/missing.md`]])],
    }
  if (results === 3) return { tools: [...call("shell", [[/command/i, "ls"]]), ...call("bash", [[/command/i, "ls"]])].slice(0, 1) }
  return { text: "Done. The project has one readme and nothing else to report." }
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

const pause = () => new Promise((r) => setTimeout(r, 40))

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
    if (log)
      appendFileSync(
        log,
        JSON.stringify({ stream: body.stream, tools: body.tools?.map((t) => ({ name: t.function?.name, params: Object.keys(t.function?.parameters?.properties ?? {}) })), step }) + "\n",
      )
    const id = `mock-${Date.now()}`
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write(chunk(id, { role: "assistant", content: "" }))
    if (step.reasoning)
      for (const word of step.reasoning.split(/(?<= )/)) {
        res.write(chunk(id, { reasoning_content: word }))
        await pause()
      }
    if (step.text)
      for (const word of step.text.split(/(?<= )/)) {
        res.write(chunk(id, { content: word }))
        await pause()
      }
    const tools = step.tools ?? []
    tools.forEach((tool, index) => {
      const args = JSON.stringify(tool.args)
      const half = Math.ceil(args.length / 2)
      res.write(chunk(id, { tool_calls: [{ index, id: `call_${index}_${id}`, type: "function", function: { name: tool.name, arguments: "" } }] }))
      res.write(chunk(id, { tool_calls: [{ index, function: { arguments: args.slice(0, half) } }] }))
      res.write(chunk(id, { tool_calls: [{ index, function: { arguments: args.slice(half) } }] }))
    })
    res.write(chunk(id, {}, tools.length ? "tool_calls" : "stop"))
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
    res.end("data: [DONE]\n\n")
  })
}).listen(port, "127.0.0.1", () => console.log(`progress model on :${port}`))
