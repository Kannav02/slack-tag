export const PLUGIN_VERSION = "1"
export const POLICY_VERSION = 1

export type Effect = "allow" | "ask" | "deny"

export type Decision = {
  effect: Effect
  message?: string
}

const SHELL_ALLOW = new Set(["ls", "cat", "pwd"])
const GIT_ALLOW = new Set(["status", "diff", "log"])

const READ_ACTIONS = new Set(["read", "glob", "grep", "list", "search"])
const EDIT_ACTIONS = new Set(["edit", "write", "patch"])
const WEB_ACTIONS = new Set(["webfetch", "websearch"])

const PROTECTED = [
  /(^|\/)\.opencode(\/|$)/,
  /(^|\/)opencode\.jsonc?$/,
  /(^|\/)\.git\/hooks(\/|$)/,
  /(^|\/)\.git\/config$/,
]

function words(command: string): string[] {
  return command.trim().split(/\s+/)
}

function protectedPath(resource: string): boolean {
  return PROTECTED.some((pattern) => pattern.test(resource))
}

export function decide(action: string, resources: readonly string[]): Decision {
  if (action === "shell") {
    const command = resources[0] ?? ""
    const [first, second] = words(command)
    if (first === "sudo") return { effect: "deny", message: "Blocked by the safety plugin" }
    if (first && SHELL_ALLOW.has(first)) return { effect: "allow" }
    if (first === "git" && second && GIT_ALLOW.has(second)) return { effect: "allow" }
    return { effect: "ask" }
  }

  if (EDIT_ACTIONS.has(action) && resources.some(protectedPath)) {
    return { effect: "deny", message: "Blocked by the safety plugin" }
  }
  if (READ_ACTIONS.has(action) || EDIT_ACTIONS.has(action)) return { effect: "allow" }
  if (WEB_ACTIONS.has(action)) return { effect: "ask" }
  return { effect: "ask" }
}

const SECRET_ENV = new Set(["OPENCODE_API_KEY", "OPENCODE_SERVER_PASSWORD"])

function leaksSecret(value: string | undefined): boolean {
  if (!value) return false
  return value.includes("OPENCODE_API_KEY") || value.includes("OPENCODE_SERVER_PASSWORD") || value.includes("SLACK_")
}

export function stripSecrets(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (SECRET_ENV.has(key) || key.startsWith("SLACK_") || leaksSecret(env[key])) delete env[key]
  }
}
