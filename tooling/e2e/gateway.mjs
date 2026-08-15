import { request as createHttpRequest } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { buildForwardedHeaders, routeTarget } from "./gateway-routing.mjs";

const transport = process.env.E2E_GATEWAY_TRANSPORT;
const gatewayPort = Number(process.env.E2E_GATEWAY_PORT);
const apiPort = Number(process.env.E2E_API_PORT);
const webPort = Number(process.env.E2E_WEB_PORT);
const certificatePath = process.env.E2E_CERT_PATH;
const keyPath = process.env.E2E_KEY_PATH;
const validPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
if (![gatewayPort, apiPort, webPort].every(validPort) || !["http", "https"].includes(transport)) {
  throw new Error("Gateway configuration is invalid");
}
if (transport === "https" && (!certificatePath || !keyPath)) throw new Error("HTTPS Gateway certificate configuration is invalid");

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function handler(request, response) {
  if (!loopback.has(request.socket.remoteAddress ?? "")) { response.writeHead(403).end(); return; }
  if (request.url === "/_e2e/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", transport }));
    return;
  }
  const path = request.url ?? "/";
  const upstream = createHttpRequest({ host: "127.0.0.1", port: routeTarget(new URL(path, `${transport}://127.0.0.1`).pathname, { api: apiPort, web: webPort }), method: request.method, path, headers: buildForwardedHeaders(request.headers, transport) }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
}

const server = transport === "https"
  ? createHttpsServer({ cert: await readFile(certificatePath), key: await readFile(keyPath) }, handler)
  : createHttpServer(handler);
server.listen(gatewayPort, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
