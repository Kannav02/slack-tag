import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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

const server = createServer((req, res) => {
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
