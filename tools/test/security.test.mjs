import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyHeaders, contentSecurityPolicy } from "../http-security.mjs";
test("web proxy strips spoofed IP and hop-by-hop headers", () => {
  const req = {
    socket: { remoteAddress: "203.0.113.1" },
    headers: {
      host: "meet.example.com",
      "x-forwarded-for": "198.51.100.1",
      "x-forwarded-proto": "https",
      forwarded: "for=198.51.100.1",
      connection: "keep-alive, x-secret",
      "x-secret": "smuggled",
    },
  };
  const headers = proxyHeaders(req, 18480, true);
  assert.equal(headers["x-forwarded-for"], "203.0.113.1");
  assert.equal(headers["x-forwarded-proto"], "http");
  for (const key of ["forwarded", "connection", "x-secret"])
    assert.equal(headers[key], undefined);
});
test("only explicitly trusted local proxies may forward a single valid IP", () => {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "meet.example.com",
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-proto": "https",
    },
  };
  assert.equal(proxyHeaders(req, 18480)["x-forwarded-for"], "127.0.0.1");
  assert.equal(
    proxyHeaders(req, 18480, true)["x-forwarded-for"],
    "203.0.113.1",
  );
  assert.equal(proxyHeaders(req, 18480, true)["x-forwarded-proto"], "https");
  req.headers["x-forwarded-for"] = "198.51.100.1, 203.0.113.1";
  assert.equal(proxyHeaders(req, 18480, true)["x-forwarded-for"], "127.0.0.1");
  assert.match(contentSecurityPolicy, /script-src 'self';/);
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
});
