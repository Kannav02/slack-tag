import { request as httpRequest, createServer, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

// Holds the OpenCode Go key so project containers never receive it. OpenCode sends model
// requests here with a placeholder credential; the proxy swaps in the real key and forwards
// them, unchanged otherwise, to the one configured upstream.

const key = process.env.OPENCODE_API_KEY;
if (!key) throw new Error("OPENCODE_API_KEY is required");
const upstream = new URL(process.env.UPSTREAM_URL ?? "https://opencode.ai/zen/go/v1");
const port = Number(process.env.PORT ?? 8080);
const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
const HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function target(url = ""): URL | undefined {
  const { pathname, search } = new URL(url, "http://proxy");
  if (!pathname.startsWith("/v1/") || url.includes("..")) return;
  return new URL(upstream.pathname.replace(/\/$/, "") + pathname.slice(3) + search, upstream);
}

function forwardHeaders(headers: IncomingHttpHeaders) {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (!HOP.has(name)) out[name] = value;
  if (out["x-api-key"]) {
    out["x-api-key"] = key;
    delete out.authorization;
  } else out.authorization = `Bearer ${key}`;
  return out;
}

const server = createServer((req, res) => {
  const url = target(req.url);
  if (!url) {
    res.writeHead(404).end("not found");
    return;
  }
  const out = send(url, { method: req.method, headers: forwardHeaders(req.headers) }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
    console.log(`${req.method} ${url.pathname} ${reply.statusCode}`);
  });
  out.on("error", (error) => {
    console.error(`${req.method} ${url.pathname} failed: ${error.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end("upstream unavailable");
  });
  req.pipe(out);
});

server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
  const address = server.address();
  console.log(
    `key proxy listening on ${typeof address === "object" && address ? address.port : port}`,
  );
});
