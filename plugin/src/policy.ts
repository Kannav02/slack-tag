export const PLUGIN_VERSION = "1"
export const POLICY_VERSION = 1

export type Decision = { effect: "allow" | "ask" | "deny"; message?: string }

const DENY: Decision = { effect: "deny", message: "Blocked by the safety plugin" }
const SHELL_ALLOW = new Set(["ls", "cat", "pwd", "git status", "git diff", "git log"])
const READ = new Set(["read", "glob", "grep", "list", "search"])
const EDIT = new Set(["edit", "write", "patch"])
const PROTECTED = /(^|\/)(\.opencode(\/|$)|opencode\.jsonc?$|\.git\/hooks(\/|$)|\.git\/config$)/
const SECRET = /OPENCODE_API_KEY|OPENCODE_SERVER_PASSWORD|SLACK_/

export function decide(action: string, resources: readonly string[]): Decision {
  if (action === "shell") {
    const [first, second] = (resources[0] ?? "").trim().split(/\s+/)
    if (first === "sudo") return DENY
    return SHELL_ALLOW.has(first) || SHELL_ALLOW.has(`${first} ${second}`) ? { effect: "allow" } : { effect: "ask" }
  }
  if (EDIT.has(action) && resources.some((path) => PROTECTED.test(path))) return DENY
  return READ.has(action) || EDIT.has(action) ? { effect: "allow" } : { effect: "ask" }
}

export function stripSecrets(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (SECRET.test(key) || SECRET.test(env[key] ?? "")) delete env[key]
  }
}
