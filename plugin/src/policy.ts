import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

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
// Built-in tools run in the server process: /proc exposes its environment, /data (its HOME) its sessions.
const SERVER_ONLY = ["/proc", "/data"];
const SERVER_DENY: Decision = {
  effect: "deny",
  message: "Server-only path, blocked by the safety plugin",
};

// Newlines are handled as independent commands; other shell syntax requires approval.
const COMPOUND = /[;&|<>`\r\\$(){}]/;
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
const GIT_SAFE = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "switch",
  "add",
  "commit",
  "remote",
  "ls-remote",
  "fetch",
  "pull",
  "push",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const PACKAGE_SAFE = new Set(["test", "run", "install", "ci"]);
const FIND_UNSAFE = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

// Reuse shell lexing, then inspect nested shell strings conservatively for hard denies.
function tokens(text: string): string[] {
  const words = shellWords(text) ?? text.replace(/["']/g, "").split(/\s+/).filter(Boolean);
  return words.flatMap((word) => (/[\s"']/.test(word) ? tokens(word) : [word]));
}
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
      if (
        aliased ||
        (sub === "push" &&
          words
            .slice(i + 1)
            .some(
              (word) =>
                /^--(f|fo|for|forc|force.*|m|mi|mir|mirr|mirro|mirror)(=|$)/.test(word) ||
                /^-[^-]*f/.test(word) ||
                word.startsWith("+"),
            ))
      )
        return true;
    }
  }
  return false;
}

/** 1. Reject shell syntax. 2. Tokenize quoted words. 3. Reject unclosed quotes. */
function shellWords(command: string): string[] | undefined {
  if (COMPOUND.test(command)) return undefined;
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

function hasOption(flags: string[], names: string[]): boolean {
  return flags.some(
    (flag) => flag.startsWith("--") && names.some((name) => name.startsWith(flag.split("=")[0]!)),
  );
}

function safeGit(sub: string, rest: string[]): boolean {
  if (!GIT_SAFE.has(sub)) return false;
  const flags = rest.filter((word) => word.startsWith("-"));
  // External programs, config changes and output files are never auto-approved.
  if (
    hasOption(flags, [
      "--exec",
      "--upload-pack",
      "--receive-pack",
      "--config",
      "--output",
      "--ext-diff",
      "--textconv",
    ])
  )
    return false;
  if (sub === "switch")
    return (
      (rest.length === 1 || (rest.length === 2 && rest[0] === "-c")) &&
      /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(rest.at(-1)!) &&
      !rest.at(-1)!.includes("..")
    );
  if (sub === "branch")
    return (
      (rest.length === 1 &&
        /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(rest[0]!) &&
        !rest[0]!.includes("..")) ||
      rest.every((word) =>
        /^(--(show-current|list|all|remotes|verbose|no-color)|-[arv]+)$/.test(word),
      )
    );
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
  if (sub === "commit") return !hasOption(flags, ["--amend", "--fixup", "--squash"]);
  if (!["fetch", "pull", "push", "ls-remote"].includes(sub)) return true;
  const options: Record<string, RegExp> = {
    fetch: /^(--(all|prune|tags|no-tags|quiet|verbose)|-[qv])$/,
    pull: /^(--(ff-only|quiet|verbose)|-[qv])$/,
    push: /^(--(set-upstream|tags|all|dry-run|quiet|verbose|porcelain)|-[uqvn]+)$/,
    "ls-remote": /^(--(heads|branches|tags|refs|quiet|exit-code)|-q)$/,
  };
  if (flags.some((flag) => !options[sub]!.test(flag))) return false;
  if (sub === "pull" && !flags.includes("--ff-only")) return false;
  // Only configured remote names and ordinary refs, never URLs, paths or +refspecs.
  const args = rest.filter((word) => !word.startsWith("-"));
  if (args.length && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(args[0]!)) return false;
  return args
    .slice(1)
    .every(
      (word) =>
        /^[A-Za-z0-9_][A-Za-z0-9_./-]*(?::[A-Za-z0-9_][A-Za-z0-9_./-]*)?$/.test(word) &&
        !word.includes("..") &&
        !word.includes("//"),
    );
}

function safeShell(command: string): boolean {
  const words = shellWords(command);
  if (!words) return false;
  const [name, sub, ...rest] = words;
  if (!name || name.includes("/") || name.includes("=")) return false;
  if (READ_ONLY.has(name)) return true;
  if (name === "rg") return !command.includes("--pre");
  if (name === "find") return ![sub, ...rest].some((word) => FIND_UNSAFE.test(word ?? ""));
  if (name === "pytest" || name === "make" || name === "tsc") return true;
  if (name === "node") return sub === "--test";
  if (PACKAGE_MANAGERS.has(name)) return PACKAGE_SAFE.has(sub ?? "");
  return name === "git" && safeGit(sub ?? "", rest);
}

// Relative paths resolve against the server's directory (/project); symlinks resolve when the path exists.
function serverOnly(path: string, parent: boolean): boolean {
  let full = resolve(path);
  try {
    full = realpathSync(full);
  } catch {}
  return SERVER_ONLY.some((root) => within(root, full) || (parent && within(full, root)));
}

function within(folder: string, path: string): boolean {
  const rest = relative(folder, path);
  return rest !== ".." && !rest.startsWith("../");
}

function readsServer(action: string, resources: readonly string[], path: unknown): boolean {
  if (!READ.has(action) && action !== "external_directory") return false;
  const search = action === "glob" || action === "grep";
  const paths = search ? (typeof path === "string" ? [path] : []) : resources;
  // A grep over a parent such as / would read file contents under /proc.
  return paths.some((item) => serverOnly(item, action === "grep"));
}

/** `path` is the folder OpenCode sends as metadata for glob and grep, whose resources are patterns. */
export function decide(action: string, resources: readonly string[], path?: unknown): Decision {
  if (action === "shell") {
    // OpenCode splits chains and pipelines into one resource per command, so every part is checked.
    const command = resources.join(" | ");
    if (denied(command)) return DENY;
    const commands = resources
      .flatMap((resource) => resource.split("\n"))
      .filter((part) => part.trim());
    return commands.length > 0 && commands.every(safeShell) ? ALLOW : ASK;
  }
  if (EDIT.has(action)) {
    if (resources.some((path) => PROTECTED.test(path))) return DENY;
    return resources.every((path) => !path.split("/").includes("..")) ? ALLOW : ASK;
  }
  if (readsServer(action, resources, path)) return SERVER_DENY;
  if (READ.has(action)) return resources.some((path) => DOTENV.test(path)) ? ASK : ALLOW;
  return ASK;
}

// Errors never allow: the action waits for the owner instead.
export function safeDecide(action: string, resources: readonly string[], path?: unknown): Decision {
  try {
    return decide(action, resources, path);
  } catch {
    return ASK;
  }
}

export function stripSecrets(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (SECRET.test(key) || SECRET.test(env[key] ?? "")) delete env[key];
  }
}
