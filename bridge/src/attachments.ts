import { createWriteStream } from "node:fs"
import { lstat, mkdir, readdir, rm } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { pathToFileURL } from "node:url"

export type SlackFile = { name?: string; mimetype?: string; size?: number; url_private?: string }

const MAX_BYTES = 20 * 1024 * 1024
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp"])
const VIDEO = new Set(["mp4", "webm", "mov"])
const TEXT = new Set(
  "txt md markdown json csv log ts tsx js mjs cjs py go rs yml yaml toml xml html css sh".split(" "),
)

const leaf = (name = "") => basename(name.replaceAll("\\", "/"))

function kindOf(file: SlackFile): "image" | "video" | "text" | undefined {
  const name = leaf(file.name)
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  const mime = (file.mimetype ?? "").toLowerCase()
  if (mime.startsWith("image/") || IMAGE.has(ext)) return "image"
  if (mime.startsWith("video/") || VIDEO.has(ext)) return "video"
  if (mime.startsWith("text/") || mime === "application/json" || TEXT.has(ext)) return "text"
}

export function refusal(file: SlackFile, inputs: readonly string[], model: string): string | undefined {
  const label = leaf(file.name) || "attachment"
  if (!file.url_private || !(Number(file.size) >= 0)) return `${label} could not be read from Slack, so it was not sent.`
  if (file.size! > MAX_BYTES) return `${label} is larger than 20 MB, so it was not sent.`
  const kind = kindOf(file)
  if (!kind) return `${label} is not a supported attachment. This model accepts ${inputs.join(", ") || "nothing"}.`
  if (!inputs.includes(kind)) return `${model} cannot read ${kind === "image" ? "images" : `${kind} files`}.`
}

function freeName(name: string, taken: string[]): string {
  const base = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file"
  const dot = base.lastIndexOf(".")
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""]
  let candidate = base
  for (let n = 2; taken.includes(candidate); n++) candidate = `${stem}-${n}${ext}`
  return candidate
}

// The inbox belongs to the bridge and is read-only in the container, but still never follow a symlink into it.
async function realDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o755 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("attachment inbox is not a plain directory")
}

export async function store(
  dirs: { inboxDir: string; serverInboxDir: string },
  threadTs: string,
  file: SlackFile,
  download: (url: string) => Promise<Response>,
): Promise<{ uri: string; name: string }> {
  const thread = /^\d+\.\d+$/.test(threadTs) ? threadTs : "thread"
  const inbox = join(dirs.inboxDir, thread)
  await realDir(dirname(dirs.inboxDir))
  await realDir(dirs.inboxDir)
  await realDir(inbox)
  const name = freeName(leaf(file.name), await readdir(inbox))
  const dest = resolve(inbox, name)
  if (!dest.startsWith(inbox + sep)) throw new Error("attachment path escapes the inbox")

  const response = await download(file.url_private!)
  if (!response.ok || !response.body) throw new Error(`attachment download failed (${response.status})`)
  let seen = 0
  const limit = async function* (chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      if ((seen += chunk.length) > MAX_BYTES) throw new Error("attachment is larger than 20 MB")
      yield chunk
    }
  }
  try {
    await pipeline(Readable.from(response.body), limit, createWriteStream(dest, { flags: "wx" }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(dest, { force: true })
    throw error
  }
  return { uri: pathToFileURL(join(dirs.serverInboxDir, thread, name)).href, name }
}
