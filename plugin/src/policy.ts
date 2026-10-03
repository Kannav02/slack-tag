export const PLUGIN_VERSION = "1";
export const POLICY_VERSION = 3;

export type Decision = { effect: "allow" | "deny" | "ask"; message?: string };

const ALLOW: Decision = { effect: "allow" };
const ASK: Decision = { effect: "ask" };
const DENY: Decision = { effect: "deny", message: "Blocked by the safety plugin" };
const READ = new Set(["read", "glob", "grep", "list", "search"]);
const EDIT = new Set(["edit", "write", "patch"]);
const PROTECTED = /(^|\/)(\.opencode(\/|$)|opencode\.jsonc?$|\.git\/hooks(\/|$)|\.git\/config$)/;
const DOTENV = /(^|\/)\.env(\.|$)/;
const SECRET = /OPENCODE_API_KEY|OPENCODE_SERVER_PASSWORD|SLACK_/;

// Anything that chains, pipes, redirects or substitutes is never auto-allowed.
const COMPOUND = /[;&|<>`\n\r]|\$\(/;
const DOWNLOAD = /\b(curl|wget)\b/;
const RUNS_DOWNLOAD =
  /\|\s*(sudo\s+)?(\S*\/)?(ba|z|da|k)?sh\b|\|\s*(\S*\/)?(python3?|node|perl|ruby|eval|source)\b|<\(\s*(curl|wget)\b|\$\(\s*(curl|wget)\b|`\s*(curl|wget)\b/;
const ESCALATE = new Set(["sudo", "su", "doas"]);
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "nice", "xargs", "builtin"]);
// git options that take a separate value before the subcommand.
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

const READ_ONLY = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep"]);
const GIT_SAFE = new Set(["status", "log", "diff", "show", "branch", "add", "commit"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const PACKAGE_SAFE = new Set(["test", "run", "install", "ci"]);
const FIND_UNSAFE = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

const tokens = (text: string) => text.replace(/["']/g, " ").split(/\s+/).filter(Boolean);
const base = (word: string) => word.slice(word.lastIndexOf("/") + 1);

function gitSubcommand(words: string[], start: number): { sub?: string; aliased: boolean } {
  let aliased = false;
  for (let i = start + 1; i < words.length; i++) {
    const word = words[i]!;
    // An alias set on the command line can rename push.
    if (
      word.startsWith("--config-env=alias.") ||
      ((word === "-c" || word === "--config-env") && (words[i + 1] ?? "").startsWith("alias."))
    )
      aliased = true;
    if (GIT_VALUE_OPTIONS.has(word)) i++;
    else if (!word.startsWith("-")) return { sub: word, aliased };
  }
  return { aliased };
}

function denied(command: string): boolean {
  if (DOWNLOAD.test(command) && RUNS_DOWNLOAD.test(command)) return true;
  for (const segment of command.split(/[;&|\n()`]|\$\(/)) {
    const words = tokens(segment);
    let first = words.findIndex((word) => !/^\w+=/.test(word));
    while (first >= 0 && WRAPPERS.has(base(words[first]!))) first++;
    if (first >= 0 && ESCALATE.has(base(words[first] ?? ""))) return true;
    // git can appear anywhere, for example inside `bash -c 'git push'`.
    for (let i = 0; i < words.length; i++) {
      if (base(words[i]!) !== "git") continue;
      const { sub, aliased } = gitSubcommand(words, i);
      if (sub === "push" || aliased) return true;
    }
  }
  return false;
}

function safeShell(command: string): boolean {
  if (COMPOUND.test(command)) return false;
  const [name, sub, ...rest] = tokens(command);
  if (!name || name.includes("/") || name.includes("=")) return false;
  if (READ_ONLY.has(name)) return true;
  if (name === "rg") return !command.includes("--pre");
  if (name === "find") return ![sub, ...rest].some((word) => FIND_UNSAFE.test(word ?? ""));
  if (name === "pytest" || name === "make" || name === "tsc") return true;
  if (name === "node") return sub === "--test";
  if (PACKAGE_MANAGERS.has(name)) return PACKAGE_SAFE.has(sub ?? "");
  if (name !== "git" || !GIT_SAFE.has(sub ?? "")) return false;
  const flags = rest.filter((word) => word.startsWith("-"));
  if (sub === "branch")
    return !flags.some((flag) =>
      /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(
        flag,
      ),
    );
  if (sub === "commit") return !flags.includes("--amend");
  if (sub === "diff" || sub === "log" || sub === "show")
    return !flags.some((flag) => flag.startsWith("--output"));
  return true;
}

export function decide(action: string, resources: readonly string[]): Decision {
  if (action === "shell") {
    // OpenCode splits chains and pipelines into one resource per command, so every part is checked.
    const command = resources.join(" | ");
    if (denied(command)) return DENY;
    return resources.length === 1 && safeShell(command) ? ALLOW : ASK;
  }
  if (EDIT.has(action)) {
    if (resources.some((path) => PROTECTED.test(path))) return DENY;
    return resources.every((path) => !path.split("/").includes("..")) ? ALLOW : ASK;
  }
  if (READ.has(action)) return resources.some((path) => DOTENV.test(path)) ? ASK : ALLOW;
  return ASK;
}

// Errors never allow: the action waits for the owner instead.
export function safeDecide(action: string, resources: readonly string[]): Decision {
  try {
    return decide(action, resources);
  } catch {
    return ASK;
  }
}

export function stripSecrets(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (SECRET.test(key) || SECRET.test(env[key] ?? "")) delete env[key];
  }
}
