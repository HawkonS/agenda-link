import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuration, port } from "./config.mjs";
import { contentSecurityPolicy, proxyHeaders } from "./http-security.mjs";
const config = configuration(),
  apiPort = port(config["app.port"]),
  webPort = port(config["web.port"]);
const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/web/dist",
);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (req.url === "/api" || req.url?.startsWith("/api/")) {
    const headers = proxyHeaders(
      req,
      apiPort,
      config["web.trust-proxy"] === "true",
    );
    if (Number(req.headers["content-length"]) > 1024 * 1024) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end('{"message":"请求内容过大"}');
      return;
    }
    const proxy = http.request(
      {
        host: "127.0.0.1",
        port: apiPort,
        path: req.url,
        method: req.method,
        headers,
        timeout: 120000,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
        upstream.on("error", () => res.destroy());
      },
    );
    proxy.on("timeout", () => proxy.destroy());
    proxy.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end('{"message":"API 服务暂时不可用"}');
      } else res.destroy();
    });
    req.on("aborted", () => proxy.destroy());
    req.pipe(proxy);
    return;
  }
  if (!["GET", "HEAD"].includes(req.method || "")) {
    res.writeHead(405);
    res.end();
    return;
  }
  try {
    const pathname = decodeURIComponent(
      new URL(req.url || "/", "http://localhost").pathname,
    );
    let file = path.resolve(dist, "." + pathname);
    if (
      (file !== dist && !file.startsWith(dist + path.sep)) ||
      pathname.includes("\0")
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (path.extname(pathname)) {
        res.writeHead(404);
        res.end();
        return;
      }
      file = path.join(dist, "index.html");
      info = await stat(file);
    }
    res.setHeader(
      "Content-Type",
      mime[path.extname(file)] || "application/octet-stream",
    );
    res.setHeader("Content-Length", info.size);
    res.setHeader(
      "Cache-Control",
      file.includes(path.sep + "assets" + path.sep)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch {
    res.writeHead(400);
    res.end();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.maxRequestsPerSocket = 1000;
server.on("error", (error) => {
  console.error("Web 启动失败：" + error.message);
  process.exitCode = 1;
});
server.listen(webPort, config["web.bind-address"] || "0.0.0.0", () =>
  console.log("Web listening on " + webPort),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10000).unref();
  });
