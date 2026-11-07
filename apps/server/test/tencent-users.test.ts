import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { DatabaseService } from "../src/database.service.js";
import { PlatformConnectionService } from "../src/platform-connection.service.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import type { PlatformHttp } from "../src/platforms/shared/http.js";

test("Tencent user updates only call enable for a real state transition", async () => {
  const previous = process.env.AGENDA_LINK_WORKSPACE;
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-tencent-users-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  const config = new ConfigurationService();
  const database = new DatabaseService(config);
  const connections = new PlatformConnectionService(config, database);
  connections.update("tencent-meeting", {
    appId: "app",
    sdkId: "sdk",
    secretId: "key",
    secretKey: "secret",
    operatorId: "admin",
  });
  const calls: { path: string; method: string; body: any }[] = [];
  const http = {
    request: async (raw: string, method: string, _headers: unknown, body?: string) => {
      const url = new URL(raw);
      calls.push({
        path: url.pathname,
        method,
        body: body ? JSON.parse(body) : undefined,
      });
      return {};
    },
  } as unknown as PlatformHttp;
  const tencent = new TencentAdapter(config, http, connections);
  try {
    await tencent.upsertUser({
      id: "u1",
      name: "张三",
      email: "zhangsan@example.com",
      phone: "13800000000",
      departmentIds: ["1"],
      disabled: false,
      exists: true,
      wasDisabled: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[0]!.path, "/v1/users/u1");
    assert.equal("email" in calls[0]!.body, false);
    assert.equal("phone" in calls[0]!.body, false);

    calls.length = 0;
    await tencent.upsertUser({
      id: "u2",
      name: "李四",
      departmentIds: ["1"],
      disabled: false,
      exists: true,
      wasDisabled: true,
    });
    assert.deepEqual(
      calls.map((call) => [call.method, call.path, call.body.enable]),
      [
        ["PUT", "/v1/users/u2", undefined],
        ["PUT", "/v1/users/u2/enable", true],
      ],
    );

    calls.length = 0;
    await tencent.upsertUser({
      id: "u4",
      name: "未激活",
      departmentIds: ["1"],
      disabled: false,
      exists: true,
      wasDisabled: true,
      unactivated: true,
    });
    assert.deepEqual(
      calls.map((call) => [call.method, call.path]),
      [["PUT", "/v1/users/u4"]],
    );

    calls.length = 0;
    await tencent.upsertUser({
      id: "u3",
      name: "王五",
      email: "wangwu@example.com",
      phone: "13900000000",
      departmentIds: ["1"],
      disabled: false,
      exists: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.path, "/v1/users");
    assert.equal(calls[0]!.body.email, "wangwu@example.com");
    assert.ok(calls[0]!.body.phone);
  } finally {
    database.onModuleDestroy();
    if (previous === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
    else process.env.AGENDA_LINK_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
