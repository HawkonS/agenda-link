import { platformComponents } from "../src/platforms/index.js";
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { scryptSync } from "node:crypto";
import { AuthService } from "../src/auth.service.js";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { DatabaseService } from "../src/database.service.js";
import { users, meetings, meetingAttendees, jobs } from "../src/db/schema.js";
import {
  LoginProtection,
  RateLimitError,
  RequestLimiter,
  derivePassword,
} from "../src/security.js";
import { PlatformHttp, PlatformError } from "../src/platforms/shared/http.js";
import { WorkerService } from "../src/worker.service.js";
import { MeetingService } from "../src/meeting.service.js";
import { meetingJoinUrl } from "../src/platforms/meeting-url.js";

test("security boundaries, persistent locks and bounded resource use", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-security-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  process.env.AGENDA_LINK_TEST = "true";
  process.env.AGENDA_LINK_DISABLE_WORKER = "true";
  const { createApplication } = await import("../src/main.js");
  const app = await createApplication();
  const db = app.get(DatabaseService),
    config = app.get(ConfigurationService),
    auth = app.get(AuthService);
  const server = app.getHttpAdapter().getInstance();
  auth.createInitialAdmin("admin", "管理员", "secure-test-password");
  const session = await auth.login(
    "admin",
    "secure-test-password",
    "198.51.100.1",
  );
  const headers = { authorization: "Bearer " + session.token };
  try {
    await t.test(
      "SQL metacharacters cannot authenticate or change a query",
      async () => {
        const response = await server.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "admin' OR 1=1 --", password: "invalid" },
        });
        assert.equal(response.statusCode, 401);
        const invalidId = await server.inject({
          method: "PATCH",
          url: "/api/users/1%20OR%201=1",
          headers,
          payload: { displayName: "injected" },
        });
        assert.equal(invalidId.statusCode, 400);
        assert.equal(
          db.db.select().from(users).where(eq(users.username, "admin")).get()
            ?.displayName,
          "管理员",
        );
      },
    );
    await t.test(
      "configuration rejects property-line injection and unsafe platform links",
      async () => {
        await assert.rejects(
          config.update({ "platform.name": "safe\rauth.jwt-secret=attacker" }),
        );
        await assert.rejects(config.update({ "web.trust-proxy": "anything" }));
        await assert.rejects(config.update({ "app.bind-address": "invalid" }));
        for (const url of [
          "javascript:alert(1)",
          "https://evil.invalid/",
          "https://meeting.tencent.com.evil.invalid/",
          "https://user:pass@meeting.tencent.com/",
        ])
          assert.equal(meetingJoinUrl(url), null);
        assert.equal(
          meetingJoinUrl("https://meeting.tencent.com/dm/test"),
          "https://meeting.tencent.com/dm/test",
        );
      },
    );
    await t.test(
      "five failures lock the account across IPs and process restarts",
      async () => {
        for (let i = 0; i < 4; i++)
          await assert.rejects(
            auth.login("missing", "wrong", "198.51.100." + (i + 10)),
            (e) => (e as any).getStatus() === 401,
          );
        await assert.rejects(
          auth.login("missing", "wrong", "198.51.100.20"),
          (e) => e instanceof RateLimitError && e.retryAfter > 0,
        );
        const restarted = new AuthService(config, db);
        await assert.rejects(
          restarted.login("MISSING", "anything", "198.51.100.99"),
          (e) => e instanceof RateLimitError,
        );
        const protection = new LoginProtection(db);
        assert.doesNotThrow(() =>
          protection.check(
            "missing",
            "198.51.100.99",
            Date.now() + LoginProtection.windowMs + 100,
          ),
        );
      },
    );
    await t.test(
      "twenty failures lock an IP even across accounts; success does not erase the IP history",
      () => {
        const protection = new LoginProtection(db),
          ip = "203.0.113.2";
        for (let i = 0; i < 19; i++) protection.fail("spray" + i, ip);
        protection.success("spray0", ip);
        assert.throws(() => protection.fail("spray19", ip), RateLimitError);
        assert.throws(() => protection.check("admin", ip), RateLimitError);
        assert.doesNotThrow(() => protection.check("admin", "203.0.113.3"));
      },
    );
    await t.test("HTTP lock responses include a retry interval", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "missing", password: "wrong" },
      });
      assert.equal(response.statusCode, 429);
      assert.ok(Number(response.headers["retry-after"]) > 0);
      assert.ok(response.json().retryAfter > 0);
    });
    await t.test(
      "cookie mutations reject cross-site and missing origins, including forged forwarded headers",
      async () => {
        const cookie = "agenda_link_session=" + session.token;
        for (const extra of [
          {},
          {
            origin: "https://evil.invalid",
            "x-forwarded-host": "evil.invalid",
            "x-forwarded-proto": "https",
          },
        ]) {
          const response = await server.inject({
            method: "PATCH",
            url: "/api/profile",
            remoteAddress: "198.51.100.200",
            headers: { cookie, ...extra },
            payload: { displayName: "blocked" },
          });
          assert.equal(response.statusCode, 403);
        }
        assert.equal(
          (
            await server.inject({
              method: "PATCH",
              url: "/api/profile",
              headers: { cookie, origin: config.baseUrl },
              payload: { displayName: "valid", role: "user" },
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await server.inject({
              method: "PATCH",
              url: "/api/profile",
              remoteAddress: "127.0.0.1",
              headers: {
                cookie,
                origin: "http://192.0.2.10:15173",
                "x-forwarded-host": "192.0.2.10:15173",
                "x-forwarded-proto": "http",
              },
              payload: { displayName: "lan-access" },
            })
          ).statusCode,
          200,
          "local web proxy should accept the matching LAN origin",
        );
        assert.equal(
          db.db.select().from(users).where(eq(users.username, "admin")).get()
            ?.role,
          "system_admin",
        );
      },
    );
    await t.test(
      "anonymous callers cannot read users, logs, configuration or database backups",
      async () => {
        for (const url of [
          "/api/users",
          "/api/system/settings",
          "/api/system/logs/server.log",
          "/api/system/backups",
          "/api/account-pools",
          "/api/meetings",
        ]) {
          assert.equal(
            (await server.inject({ method: "GET", url })).statusCode,
            401,
            url,
          );
        }
      },
    );
    await t.test(
      "ordinary users cannot elevate privileges or access another user's calendar",
      async () => {
        const id = db.db
          .insert(users)
          .values({ username: "ordinary", displayName: "普通用户" })
          .returning()
          .get().id;
        const issued = await auth.issue(
          db.db.select().from(users).where(eq(users.id, id)).get()!,
        );
        const userHeaders = { authorization: "Bearer " + issued.token };
        for (const url of [
          "/api/system/settings",
          "/api/system-users",
          "/api/records/audit",
          "/api/platform-connections",
        ])
          assert.equal(
            (await server.inject({ method: "GET", url, headers: userHeaders }))
              .statusCode,
            403,
            url,
          );
        assert.equal(
          (
            await server.inject({
              method: "PATCH",
              url: "/api/users/1",
              headers: userHeaders,
              payload: { role: "system_admin" },
            })
          ).statusCode,
          403,
        );
        db.connection
          .prepare(
            "INSERT INTO calendar_events(created_by,subject,start_at,end_at,request_key,payload_json) VALUES(1,'private','2099-01-01','2099-01-02','private-test','{}')",
          )
          .run();
        assert.equal(
          (
            await server.inject({
              method: "DELETE",
              url: "/api/calendar-events/1",
              headers: userHeaders,
            })
          ).statusCode,
          403,
        );
      },
    );
    await t.test(
      "responses protect authenticated data and reject oversized payloads",
      async () => {
        const response = await server.inject({
          method: "GET",
          url: "/api/profile",
          headers,
        });
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(response.json().passwordHash, undefined);
        assert.equal(
          (
            await server.inject({
              method: "POST",
              url: "/api/auth/login",
              headers: { "content-type": "application/json" },
              payload: JSON.stringify({
                username: "x",
                password: "x".repeat(1024 * 1024),
              }),
            })
          ).statusCode,
          413,
        );
      },
    );
    await t.test(
      "HTTPS forces secure cookies and password changes revoke old sessions",
      async () => {
        await config.update({
          "app.base-url": "https://meet.example.test",
          "auth.cookie-secure": "false",
        });
        await config.load(); // Simulate restart so network and cookie configuration take effect together.
        assert.match(auth.cookie("test"), /; Secure/);
        const result = await server.inject({
          method: "POST",
          url: "/api/profile/password",
          headers,
          payload: {
            currentPassword: "secure-test-password",
            newPassword: "changed-secure-password",
          },
        });
        assert.equal(result.statusCode, 201);
        assert.equal(
          (await server.inject({ method: "GET", url: "/api/profile", headers }))
            .statusCode,
          401,
        );
      },
    );
    await t.test(
      "password hashing yields to the event loop and refuses excess concurrent work",
      async () => {
        const work = Array.from({ length: 4 }, () =>
          derivePassword("test", "0".repeat(32)),
        );
        await assert.rejects(
          derivePassword("excess", "0".repeat(32)),
          RateLimitError,
        );
        let yielded = false;
        setImmediate(() => {
          yielded = true;
        });
        await Promise.all(work);
        assert.equal(yielded, true);
      },
    );
    await t.test(
      "API rate limits cannot be bypassed with client supplied forwarded addresses",
      async () => {
        const limiter = new RequestLimiter();
        limiter.consume("ip", 2, 100);
        limiter.consume("ip", 2, 101);
        assert.throws(() => limiter.consume("ip", 2, 102), RateLimitError);
        assert.doesNotThrow(() => limiter.consume("ip", 2, 60_101));
        for (let i = 0; i < 245; i++) {
          const response = await server.inject({
            method: "GET",
            url: "/api/health",
            remoteAddress: "198.51.100.200",
            headers: { "x-forwarded-for": "203.0.113." + (i % 250) },
          });
          if (response.statusCode === 429) return;
        }
        assert.fail("expected rate limit despite changing forged headers");
      },
    );
    await t.test(
      "expired security state is removed without clearing active locks",
      () => {
        db.setState("oauth:expired", "1");
        db.setState("oauth:valid", String(Date.now() + 600_000));
        db.setState("ordinary-state", "1");
        db.cleanupSecurityState();
        assert.equal(db.getState("oauth:expired"), undefined);
        assert.ok(db.getState("oauth:valid"));
        assert.equal(db.getState("ordinary-state"), "1");
        assert.throws(
          () => auth.protection.check("admin", "203.0.113.2"),
          RateLimitError,
        );
      },
    );
    await t.test(
      "visibility is applied in SQL and lists batch related records",
      () => {
        const user = {
          id: 2,
          username: "ordinary",
          displayName: "普通用户",
          avatarUrl: null,
          role: "user" as const,
          meetingUserType: "ordinary" as const,
        };
        for (let i = 0; i < 100; i++)
          db.db
            .insert(meetings)
            .values({
              subject: "private-" + i,
              startAt: "2099-01-01",
              endAt: "2099-01-02",
              createdBy: 1,
            })
            .run();
        db.db
          .insert(meetingAttendees)
          .values({ meetingId: 1, userId: 2, displayName: "普通用户" })
          .run();
        db.db
          .insert(meetings)
          .values({
            subject: "owned",
            startAt: "2099-01-01",
            endAt: "2099-01-02",
            createdBy: 2,
          })
          .run();
        const result = app.get(MeetingService).list(user);
        assert.equal(result.length, 2);
        assert.equal(result.find((m) => m.id === 1)?.attendees.length, 1);
        assert.throws(() => app.get(MeetingService).accessible(1, user, true));
      },
    );
    await t.test(
      "legacy scrypt passwords remain valid and upgrade after successful login",
      async () => {
        const salt = "a".repeat(32),
          password = "legacy-secure-password";
        const oldHash =
          "scrypt$" +
          salt +
          "$" +
          scryptSync(password, salt, 64).toString("hex");
        const row = db.db
          .insert(users)
          .values({
            username: "legacy",
            displayName: "兼容用户",
            passwordHash: oldHash,
          })
          .returning()
          .get();
        await auth.login("legacy", password, "198.51.100.51");
        const updated = db.db
          .select()
          .from(users)
          .where(eq(users.id, row.id))
          .get()!;
        assert.match(updated.passwordHash!, /^scrypt-v2\$/);
        assert.equal(
          await auth.verifyPasswordAsync(password, updated.passwordHash),
          true,
        );
      },
    );
    await t.test(
      "malformed worker jobs fail without stopping later jobs",
      async () => {
        db.db
          .insert(jobs)
          .values([
            {
              type: "meeting.provision",
              payloadJson: "{broken",
              runAt: new Date(0).toISOString(),
            },
            {
              type: "unknown",
              payloadJson: "null",
              runAt: new Date(0).toISOString(),
            },
          ])
          .run();
        await app.get(WorkerService).runOnce();
        assert.deepEqual(
          db.db
            .select()
            .from(jobs)
            .all()
            .map((j) => j.status),
          ["failed", "failed"],
        );
      },
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("outbound API calls reject redirects, foreign hosts, unbounded responses and secret echoes", async () => {
  const original = globalThis.fetch,
    http = new PlatformHttp(platformComponents);
  try {
    await assert.rejects(
      http.request("http://127.0.0.1/internal"),
      PlatformError,
    );
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.redirect, "error");
      return new Response(
        JSON.stringify({
          error_info: {
            error_code: 999,
            message: "sensitive-app-secret access-token-only",
          },
        }),
        { status: 400 },
      );
    };
    await assert.rejects(
      http.request(
        "https://api.meeting.qq.com/v1/test",
        "POST",
        { authorization: "Bearer access-token-only" },
        { appSecret: "sensitive-app-secret" },
      ),
      (e) =>
        e instanceof PlatformError &&
        !e.message.includes("sensitive-app-secret") &&
        !e.message.includes("access-token-only"),
    );
    globalThis.fetch = async () =>
      new Response(new Uint8Array(8 * 1024 * 1024 + 1));
    await assert.rejects(
      http.request("https://open.feishu.cn/open-apis/test"),
      (e) => e instanceof PlatformError && e.code === "RESPONSE_TOO_LARGE",
    );
  } finally {
    globalThis.fetch = original;
  }
});
