import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = new URL("..", import.meta.url).pathname
const work = join(tmpdir(), "slack-tag-s3")
const project = join(work, "proj")
const home = join(work, "home")
mkdirSync(join(home, ".config/opencode"), { recursive: true })
mkdirSync(project, { recursive: true })

const password = "demo-password"
writeFileSync(join(project, "README.md"), "The first line of the readme.\n")
writeFileSync(
  join(home, ".config/opencode/opencode.jsonc"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "mock/mock",
      autoupdate: false,
      plugins: [join(root, "plugin")],
      providers: {
        mock: {
          name: "Mock",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "http://127.0.0.1:4010/v1", apiKey: "unused" },
          models: { mock: { name: "Mock" } },
        },
      },
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
      experimental: {
        policies: [{ action: "permission", resource: "shell:git push *", effect: "deny" }],
      },
    },
    null,
    2,
  ),
)

const opencode = join(root, "spike/v2/node_modules/.bin/opencode")
const children = []
function up(cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "inherit" })
  children.push(child)
  return child
}

up("node", [join(root, "spike/v2/mock-model.mjs")], { MOCK_PORT: "4010" })
up(opencode, ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  OPENCODE_SERVER_PASSWORD: password,
})

for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch("http://127.0.0.1:4096/api/model", {
      headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
    })
    if (res.ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 200))
  if (i === 49) throw new Error("opencode did not start")
}

up("node", ["--experimental-strip-types", join(root, "bridge/src/main.ts")], {
  OC_PASSWORD: password,
  OC_URL: "http://127.0.0.1:4096",
  PROJECT_DIR: project,
  SLACK_OWNER_ID: "U_OWNER",
  PORT: "4173",
})

process.on("SIGINT", () => {
  for (const child of children) child.kill()
  process.exit(0)
})
