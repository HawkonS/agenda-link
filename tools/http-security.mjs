import { isIP } from "node:net";

export const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
export function proxyHeaders(req, apiPort, trustProxy = false) {
  const remote = req.socket.remoteAddress || "127.0.0.1";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const forwarded = req.headers["x-forwarded-for"];
  // Only a single sanitized address from a local, explicitly trusted proxy.
  const client =
    trustProxy && loopback && typeof forwarded === "string" && isIP(forwarded)
      ? forwarded
      : remote;
  const headers = { ...req.headers };
  const hopHeaders = String(headers.connection || "")
    .split(",")
    .map((v) => v.trim().toLowerCase());
  for (const key of [
    ...hopHeaders,
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "forwarded",
    "x-real-ip",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ])
    delete headers[key];
  return {
    ...headers,
    host: "127.0.0.1:" + apiPort,
    "x-forwarded-for": client,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto":
      trustProxy && loopback && req.headers["x-forwarded-proto"] === "https"
        ? "https"
        : "http",
  };
}
