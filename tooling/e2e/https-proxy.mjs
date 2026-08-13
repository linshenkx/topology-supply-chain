import { request as createHttpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";

const port = Number(process.env.E2E_HTTPS_PORT);
const apiPort = Number(process.env.E2E_API_PORT);
const webPort = Number(process.env.E2E_WEB_PORT);
const certificatePath = process.env.E2E_CERT_PATH;
const keyPath = process.env.E2E_KEY_PATH;
if (![port, apiPort, webPort].every((value) => Number.isInteger(value) && value > 0) || !certificatePath || !keyPath) throw new Error("HTTPS proxy configuration is invalid");
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const certificate = await readFile(certificatePath);
const key = await readFile(keyPath);
const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
  if (!loopback.has(request.socket.remoteAddress ?? "")) { response.writeHead(403).end(); return; }
  if (request.url === "/_e2e/health") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ status: "ok" })); return; }
  // Only canonical v1 API traffic belongs to the standalone API runtime.
  // Retired `/api/*` routes remain owned by Web so their exact 410 migration
  // response is observable through the same HTTPS origin.
  const targetPort = request.url?.startsWith("/api/v1/") ? apiPort : webPort;
  const upstream = createHttpRequest({ host: "127.0.0.1", port: targetPort, method: request.method, path: request.url, headers: { ...request.headers, "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1" } }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
});
server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
