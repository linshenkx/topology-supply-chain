const identityHeaders = [
  "oai-authenticated-user-email",
  "oai-authenticated-user-full-name",
  "oai-authenticated-user-full-name-encoding",
  "oai-authenticated-user-id",
];

export function routeTarget(pathname, ports) {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/") ? ports.api : ports.web;
}

export function buildForwardedHeaders(requestHeaders, transport) {
  const headers = { ...requestHeaders };
  for (const name of identityHeaders) delete headers[name];
  headers.host = requestHeaders.host ?? "127.0.0.1";
  headers["x-forwarded-host"] = headers.host;
  headers["x-forwarded-proto"] = transport;
  headers["x-forwarded-for"] = "127.0.0.1";
  return headers;
}
