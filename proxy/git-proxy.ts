import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { text } from "node:stream/consumers";

// Credentials exist only in this sidecar. The agent can use one repository's smart HTTP API.
const repository = process.env.GITHUB_REPOSITORY ?? "";
const token = process.env.GITHUB_TOKEN ?? "";
if (!/^[\w-]+\/[\w.-]+$/.test(repository) || repository.endsWith(".git") || !token)
  throw new Error("GITHUB_REPOSITORY (owner/repo) and GITHUB_TOKEN are required");
const upstream = new URL(process.env.GIT_UPSTREAM ?? "https://github.com");
// Local HTTP is for the integration fixture only; production always uses GitHub TLS.
if (upstream.origin !== "https://github.com" && upstream.hostname !== "127.0.0.1")
  throw new Error("invalid Git upstream");
const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
const services = [
  "git-upload-pack",
  ...(process.env.GIT_ALLOW_PUSH === "1" ? ["git-receive-pack"] : []),
];
// With GIT_ALLOW_PULL_REQUESTS=1 it may also open or find that repository's jeff/* pull requests.
const pullRequests = process.env.GIT_ALLOW_PULL_REQUESTS === "1";
// The local fixture serves the REST API too; production uses GitHub's API host.
const api = upstream.origin === "https://github.com" ? new URL("https://api.github.com") : upstream;
const pulls = `/repos/${repository}/pulls`;
const owner = repository.split("/")[0]!;
const headers = { "content-type": "application/json", "user-agent": "slack-tag-git-proxy" };
const isRef = (ref: unknown, prefix = ""): ref is string =>
  typeof ref === "string" && ref.startsWith(prefix) && /^[\w-]+(?:[./][\w-]+)*$/.test(ref);

// Only these calls: read the default branch, find the open PR for a jeff/* head, open one.
function pullRequestCall(method = "", url = "", payload = ""): [string, string?] | undefined {
  if (method === "GET" && url === `/repos/${repository}`) return [url];
  if (method === "GET" && url.startsWith(`${pulls}?`)) return lookup(url.slice(pulls.length + 1));
  if (method === "POST" && url === pulls) return create(payload);
}

function lookup(search: string): [string] | undefined {
  const query = new URLSearchParams(search);
  const head = query.get("head") ?? "";
  if (query.size !== 2 || query.get("state") !== "open" || !head.startsWith(`${owner}:`)) return;
  if (isRef(head.slice(owner.length + 1), "jeff/"))
    return [`${pulls}?${new URLSearchParams({ head, state: "open" })}`];
}

// Rebuilt from checked fields, so nothing else (such as issue conversion) reaches GitHub.
function create(payload: string): [string, string] | undefined {
  try {
    const { title, body, head, base } = JSON.parse(payload) as Record<string, unknown>;
    const strings = typeof title === "string" && typeof body === "string";
    if (strings && isRef(head, "jeff/") && isRef(base) && head !== base)
      return [pulls, JSON.stringify({ title, body, head, base })];
  } catch {}
}

async function pullRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "POST" && !(Number(req.headers["content-length"]) <= 65_536))
    return void res.writeHead(413).end("request body too large");
  const call = pullRequestCall(req.method, req.url, req.method === "POST" ? await text(req) : "");
  if (!call) return void res.writeHead(403).end("pull request operation denied");
  // Fresh headers, so caller credentials never reach GitHub; redirects are never followed.
  const reply = await fetch(new URL(call[0], api), {
    method: req.method!,
    headers: { ...headers, authorization: `Bearer ${token}` },
    body: call[1] ?? null,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  if (reply?.status !== 200 && reply?.status !== 201)
    return void res.writeHead(502).end(`GitHub API failed (${reply?.status ?? "no reply"})`);
  // Only the fields the tool reads: repository JSON can carry a temporary clone token.
  const fields = JSON.stringify(await reply.json(), ["default_branch", "html_url", "number"]);
  res.writeHead(reply.status, { "content-type": "application/json" }).end(fields);
}

const server = createServer((req, res) => {
  if (pullRequests && req.url?.startsWith("/repos/"))
    return void pullRequest(req, res).catch(() => res.destroy());
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding !== "gzip") return void res.writeHead(415).end("unsupported encoding");
  const service = services.find((s) =>
    req.method === "GET"
      ? req.url === `/${repository}.git/info/refs?service=${s}`
      : req.method === "POST" && req.url === `/${repository}.git/${s}`,
  );
  if (!service) return void res.writeHead(403).end("repository or operation denied");
  // Construct from validated literals, not arbitrary client URLs; never follow upstream redirects.
  const url = new URL(req.url!, upstream);
  const out = send(
    url,
    {
      method: req.method,
      headers: {
        authorization,
        ...(encoding ? { "content-encoding": encoding } : {}),
        "content-type": `application/x-${service}-request`,
        ...(req.headers["git-protocol"] === "version=2" ? { "git-protocol": "version=2" } : {}),
      },
    },
    (reply) => {
      if (reply.statusCode !== 200) {
        reply.resume();
        res.writeHead(502).end("Git upstream refused request");
        return;
      }
      res.writeHead(200, {
        "content-type": `application/x-${service}-${req.method === "GET" ? "advertisement" : "result"}`,
      });
      reply.on("error", () => res.destroy());
      reply.pipe(res);
    },
  );
  out.setTimeout(120_000, () => out.destroy());
  out.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Git upstream unavailable");
  });
  req.on("aborted", () => out.destroy());
  res.on("close", () => out.destroy());
  req.pipe(out);
});
server.requestTimeout = 120_000;
server.listen(Number(process.env.PORT ?? 8081), process.env.HOST ?? "0.0.0.0", () => {
  const address = server.address();
  if (address && typeof address === "object") console.log(`git proxy listening on ${address.port}`);
});
