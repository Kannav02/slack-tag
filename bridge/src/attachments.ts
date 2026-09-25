import { createWriteStream } from "node:fs"
import { access, appendFile, mkdir, readFile, readdir } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { pathToFileURL } from "node:url"

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"])
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "csv", "log", "ts", "tsx", "js", "mjs", "cjs",
  "py", "go", "rs", "yml", "yaml", "toml", "xml", "html", "css", "sh",
])
const VIDEO_EXT = new Set(["mp4", "webm", "mov"])

export type IncomingFile = {
  name: string
  mimetype?: string
  size: number
  url: string
}

export type StoredFile = {
  name: string
  kind: "image" | "text" | "video"
  uri: string
  path: string
}

export type FileDecision =
  | { ok: true; kind: StoredFile["kind"] }
  | { ok: false; reply: string }

export function inboxDir(projectDir: string, threadTs: string): string {
  const safeTs = threadTs.replace(/[^0-9.]/g, "")
  if (!safeTs) throw new Error("thread timestamp is empty")
  return join(projectDir, ".slack-tag", "inbox", safeTs)
}

export function storedName(slackName: string, taken: ReadonlySet<string>): string {
  const leaf = basename(String(slackName).replaceAll("\\", "/"))
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120)
  const base = cleaned.length > 0 ? cleaned : "file"
  if (!taken.has(base)) return base
  const dot = base.lastIndexOf(".")
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ""
  let n = 2
  while (taken.has(`${stem}-${n}${ext}`)) n++
  return `${stem}-${n}${ext}`
}

export function decideFile(file: IncomingFile, input: readonly string[], model: string): FileDecision {
  const label = displayName(file.name)
  if (!Number.isFinite(file.size) || file.size < 0) {
    return { ok: false, reply: `${label} has no size, so it was not sent.` }
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reply: `${label} is larger than 20 MB, so it was not sent.` }
  }
  const kind = kindOf(file)
  if (kind === "unsupported") {
    const accepted = input.length > 0 ? input.join(", ") : "nothing"
    return {
      ok: false,
      reply: `${label} is not a supported attachment. This model accepts ${accepted}.`,
    }
  }
  if (!input.includes(kind)) {
    if (kind === "image") return { ok: false, reply: `${model} cannot read images.` }
    return { ok: false, reply: `${model} cannot read ${kind} files.` }
  }
  return { ok: true, kind }
}

export async function storeFile(opts: {
  projectDir: string
  serverDir: string
  threadTs: string
  file: IncomingFile
  kind: StoredFile["kind"]
  token: string
}): Promise<StoredFile> {
  const inbox = inboxDir(opts.projectDir, opts.threadTs)
  await mkdir(inbox, { recursive: true })
  const taken = new Set(await readdir(inbox).catch(() => []))
  const name = storedName(opts.file.name, taken)
  const dest = resolve(inbox, name)
  if (!inside(inbox, dest) || name.includes("/") || name.includes("\\")) {
    throw new Error("attachment path escapes the inbox")
  }
  await download(opts.file.url, opts.token, dest, opts.file.size)
  const rel = relative(opts.projectDir, dest).split(sep).join("/")
  const uri = pathToFileURL(join(opts.serverDir, rel)).href
  return { name, kind: opts.kind, uri, path: dest }
}

export async function excludeInbox(projectDir: string): Promise<void> {
  const exclude = join(projectDir, ".git", "info", "exclude")
  const line = ".slack-tag/"
  let current = ""
  try {
    current = await readFile(exclude, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (current.split("\n").includes(line)) return
  await mkdir(join(projectDir, ".git", "info"), { recursive: true })
  await appendFile(exclude, (current.endsWith("\n") || current.length === 0 ? "" : "\n") + line + "\n")
}

function kindOf(file: IncomingFile): StoredFile["kind"] | "unsupported" {
  const ext = extension(file.name)
  const mime = (file.mimetype ?? "").toLowerCase()
  if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) return "image"
  if (mime.startsWith("video/") || VIDEO_EXT.has(ext)) return "video"
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXT.has(ext)) return "text"
  return "unsupported"
}

function extension(name: string): string {
  const leaf = basename(String(name).replaceAll("\\", "/"))
  const dot = leaf.lastIndexOf(".")
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : ""
}

function displayName(name: string): string {
  const leaf = basename(String(name).replaceAll("\\", "/"))
  return leaf.length > 0 ? leaf : "attachment"
}

function inside(root: string, target: string): boolean {
  const base = resolve(root)
  const dest = resolve(target)
  return dest === base || dest.startsWith(base + sep)
}

async function download(url: string, token: string, dest: string, declaredSize: number): Promise<void> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok || !response.body) {
    throw new Error(`attachment download failed (${response.status})`)
  }
  const length = Number(response.headers.get("content-length") ?? declaredSize)
  if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES) {
    throw new Error("attachment is larger than 20 MB")
  }
  let seen = 0
  const limited = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      if (seen > MAX_ATTACHMENT_BYTES) {
        cb(new Error("attachment is larger than 20 MB"))
        return
      }
      cb(null, chunk)
    },
  })
  await pipeline(Readable.from(response.body), limited, createWriteStream(dest, { flags: "wx" }))
  await access(dest)
}
