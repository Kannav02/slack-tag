import { execFileSync } from "node:child_process"
import { symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { connect, recorder, sessionOf } from "./lib.mjs"

// A minimal valid PDF: one page reading "Chapter 1", after the binary comment line PDF writers add.
function chapterPdf() {
  const text = "BT /F1 24 Tf 20 40 Td (Chapter 1) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
  const offsets = objects.map((body, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const start = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

// The scripted model calls slack_attach once per case; accepted files are fetched over the plugin RPC as the bridge does.
const project = process.env.PROJECT_DIR
const client = connect()
const rec = recorder(client)
const rpc = client.rpc({ id: "slack-tag", methods: { attachment: {} }, events: {} })
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")])
// Real Word, ODT and EPUB files (ZIP archives full of NUL and non-UTF-8 bytes) from pandoc, which must be installed.
const input = "# Chapter 1\n\nIt was a dark and stormy night.\n"
const pandoc = (ext) => execFileSync("pandoc", ["-t", ext, "-o", "-", "--metadata", "title=Chapter 1"], { input })
const docs = Object.fromEntries(["docx", "odt", "epub"].map((ext) => [`chapter.${ext}`, pandoc(ext)]))
const pdf = chapterPdf()
const files = { "shot.png": png, "notes.log": "all good\n", "fake.png": "text", "big.log": Buffer.alloc(10485761, 97), "run.sh": "id",
  ...docs, "chapter.pdf": pdf, "text.pdf": "notes, not a pdf\n", "big.docx": Buffer.concat([docs["chapter.docx"], Buffer.alloc(10485761)]) }
for (const [name, data] of Object.entries(files)) writeFileSync(join(project, name), data)
writeFileSync(join(project, "../home/server.txt"), "server only")
symlinkSync("/proc/self/environ", join(project, "environ.txt")) // the server's own environment
symlinkSync(join(project, "../home"), join(project, "home")) // the server's HOME, holding its config and data
await new Promise((r) => setTimeout(r, 500)) // let the event subscription start

const cases = [["shot.png", png], [join(project, "notes.log"), "all good\n"], ...Object.entries(docs), ["chapter.pdf", pdf], ["environ.txt"], ["home/server.txt"], [process.env.OUTSIDE], ["big.log"], ["fake.png"], ["text.pdf"], ["big.docx"], ["run.sh"]]
let failed = 0
for (const [path, expected] of cases) {
  const session = await client.session.create({ title: "attach", location: { directory: project } })
  const since = rec.events.length
  await client.session.prompt({ sessionID: session.id, text: `ATTACH: ${JSON.stringify({ path, caption: "look" })}` })
  const event = await rec.waitFor((e) => /^session\.tool\.(success|failed)$/.test(e.type) && sessionOf(e) === session.id, { since })
  const id = event.data.metadata?.slackAttach
  const fetch = (sessionID) => rpc.attachment({ sessionID, id }, { location: event.location })
  // Another session gets nothing, the attaching session gets the file once.
  const [other, file, again] = id ? [await fetch("ses_other"), await fetch(session.id), await fetch(session.id)] : []
  const ok = expected
    ? file?.data === Buffer.from(expected).toString("base64") && file.caption === "look" && !other?.data && !again?.data
    : event.type === "session.tool.failed" && !id
  failed += ok ? 0 : 1
  console.log(`${ok ? "PASS" : "FAIL"} ${expected ? "accepted" : "refused"} ${path}: ${event.data.error?.message ?? event.data.content?.[0]?.text}`)
}
const leaked = JSON.stringify(rec.events).includes(process.env.OC_PASSWORD)
console.log(`${leaked ? "FAIL" : "PASS"} the server password appears in no event`)
rec.stop()
process.exit(failed || leaked ? 1 : 0)
