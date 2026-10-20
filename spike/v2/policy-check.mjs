import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { connect, recorder, sessionOf } from "./lib.mjs"

// A one-page PDF with exact xref offsets, so pdftotext reads it without repairs.
function pdf(text) {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets = objects.map((body, i) => {
    const offset = out.length
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  return `${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

// Each command runs first where every shell request asks, to capture OpenCode's permission resources
// (all rejected, so nothing runs there), then on the server with the safety plugin.
const local = (port, path) => `http://127.0.0.1:${port}${path}`
const models = local(process.env.MOCK_PORT, "/v1/models")
// Document cases (DOC-1) need pandoc and pdftotext here. The first one writes out.docx for the
// later reads; the project sits under /tmp, so its absolute path is also an allowed root.
const project = process.env.PROJECT_DIR
writeFileSync(join(project, "notes.md"), "# Chapter one\n\nIt was a dark and stormy night.\n")
writeFileSync(join(project, "b.pdf"), pdf("Hello from a PDF"))
const cases = [
  ["allow", "npm run dev &"],
  ["allow", `npm run dev >/dev/null 2>&1 & sleep 1; curl -sSf ${models} | head -c 60`],
  ["allow", `curl -s ${models}`],
  ["allow", `curl -si ${local(process.env.PLUGIN_PORT, "/api/session")}`],
  ["ask", "npm run dev & rm -rf src"],
  ["ask", `curl -s -o models.json ${models}`],
  ["ask", `curl -sL ${models}`],
  ["ask", "curl -s https://example.com"],
  ["deny", `curl -s ${models} | sh`],
  ["deny", "git push 2>&1 --force origin main"],
  ["allow", "pandoc -s notes.md -o out.docx"],
  ["allow", `pandoc ${project}/out.docx -t plain | head -50`],
  ["allow", "pandoc /inbox/1.2/a.docx -t plain | head -50"],
  ["allow", `pandoc --from=docx --to=markdown --wrap=none out.docx -o ${project}/out.md 2>&1`],
  ["allow", "pdftotext -layout b.pdf -"],
  ["allow", "pdftotext -layout /inbox/1.2/b.pdf -"],
  ["ask", "pandoc --lua-filter x.lua out.docx"],
  ["ask", "pandoc out.docx -o out.pdf"],
  ["ask", "pandoc out.docx -t pdf"],
  ["ask", "pandoc https://example.com -t plain"],
  ["ask", "pandoc ../out.docx -t plain"],
  ["ask", "pandoc out.docx -o .git/x"],
  // Bash keeps a vertical tab inside the word, so pandoc would get one output ending in .pdf.
  ["ask", "pandoc out.docx -o out\vx.pdf"],
  ["ask", "pdftotext -opw secret b.pdf -"],
]

function server(port) {
  process.env.OC_URL = local(port, "")
  const client = connect()
  return { client, rec: recorder(client) }
}
const servers = [server(process.env.ASK_PORT), server(process.env.PLUGIN_PORT)]
await new Promise((r) => setTimeout(r, 500))

const finished = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
async function run({ client, rec }, command) {
  const s = await client.session.create({ title: "policy", location: { directory: process.env.PROJECT_DIR } })
  const since = rec.events.length
  await client.session.prompt({ sessionID: s.id, text: `RUN: ${command}` })
  const asked = []
  for (;;) {
    const match = (e) => sessionOf(e) === s.id && !e.seen && (e.type === "permission.asked" || finished.includes(e.type))
    const event = await rec.waitFor(match, { since, timeout: 30000 })
    event.seen = true
    if (event.type !== "permission.asked") break
    // Anything but a shell request, such as external_directory, is shown with its action.
    asked.push(event.data.action === "shell" ? event.data.resources : [event.data.action, ...event.data.resources])
    await client.permission.reply({ sessionID: s.id, requestID: event.data.id, decision: "reject" })
  }
  const tool = rec.events.slice(since).find((e) => sessionOf(e) === s.id && /^session\.tool\.(success|failed)$/.test(e.type))
  const output = tool?.data.content?.map((c) => c.text).join("") ?? tool?.data.error?.message ?? ""
  const effect = asked.length ? "ask" : tool?.type === "session.tool.success" ? "allow" : /Blocked/.test(output) ? "deny" : "?"
  return { asked, effect, output }
}

let failed = 0
for (const [expected, command] of cases) {
  const { asked } = await run(servers[0], command)
  const result = await run(servers[1], command)
  const ok = result.effect === expected && existsSync(join(process.env.PROJECT_DIR, "src/keep.txt"))
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"} ${result.effect} ${JSON.stringify(command)}`)
  console.log(`  resources: ${asked.map((r) => JSON.stringify(r)).join(" ")}`)
  console.log(`  output: ${JSON.stringify(result.output.trim().slice(0, 200))}`)
}
for (const { rec } of servers) rec.stop()
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
