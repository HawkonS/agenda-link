import assert from "node:assert/strict";
import test from "node:test";
import { FeishuAdapter } from "../src/platforms/shared/feishu/client.js";
import type { PlatformHttp } from "../src/platforms/shared/http.js";
import type { ConfigurationService } from "../src/config/configuration.service.js";
import type { PlatformConnectionService } from "../src/platform-connection.service.js";

const departMent = (id: string, parent = "0") => ({
  open_department_id: id,
  name: id,
  parent_department_id: parent,
});

function adapter(httpRequest: (url: string) => Promise<any>) {
  const http = { request: (url: string) => httpRequest(url) } as unknown as PlatformHttp;
  const connections = {
    require: () => ({ appId: "app", appSecret: "secret", rootDepartmentId: "0" }),
  } as unknown as PlatformConnectionService;
  return new FeishuAdapter({} as ConfigurationService, http, connections);
}

test("飞书通讯录读取会在限流后重试并保留结果", async () => {
  const calls: string[] = [];
  let userCalls = 0;
  const feishu = adapter(async (url) => {
    calls.push(url);
    if (url.includes("tenant_access_token"))
      return { code: 0, tenant_access_token: "token", expire: 7200 };
    if (url.includes("/children"))
      return {
        code: 0,
        data: { items: [departMent("root")], has_more: false },
      };
    userCalls++;
    if (userCalls === 1) return { code: 99991400, msg: "rate limited" };
    return {
      code: 0,
      data: {
        items: [
          {
            open_id: "ou-1",
            user_id: "u-1",
            name: "张三",
            department_ids: ["root"],
          },
        ],
        has_more: false,
      },
    };
  });
  const result = await feishu.directory("sync", true);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0]!.open_id, "ou-1");
  assert.equal(userCalls, 3);
  assert.equal(
    calls.filter((url) => url.includes("tenant_access_token")).length,
    1,
  );
});

test("飞书令牌提前失效时会清缓存并重取", async () => {
  let tokenCalls = 0;
  let userCalls = 0;
  const feishu = adapter(async (url) => {
    if (url.includes("tenant_access_token")) {
      tokenCalls++;
      return { code: 0, tenant_access_token: "token-" + tokenCalls, expire: 7200 };
    }
    if (url.includes("/children"))
      return {
        code: 0,
        data: { items: [], has_more: false },
      };
    userCalls++;
    if (userCalls === 1) return { code: 99991663, msg: "token invalid" };
    return {
      code: 0,
      data: {
        items: [
          {
            open_id: "ou-2",
            user_id: "u-2",
            name: "李四",
            department_ids: ["0"],
          },
        ],
        has_more: false,
      },
    };
  });
  const result = await feishu.directory("sync", true);
  assert.equal(result.people[0]!.open_id, "ou-2");
  assert.equal(tokenCalls, 2);
  assert.equal(userCalls, 2);
});

test("飞书部门人员读取使用有限并发", async () => {
  let active = 0;
  let peak = 0;
  const departments = Array.from({ length: 5 }, (_, i) =>
    departMent("d" + i),
  );
  const feishu = adapter(async (url) => {
    if (url.includes("tenant_access_token"))
      return { code: 0, tenant_access_token: "token", expire: 7200 };
    if (url.includes("/children"))
      return { code: 0, data: { items: departments, has_more: false } };
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return { code: 0, data: { items: [], has_more: false } };
  });
  await feishu.directory("sync", true);
  assert.ok(peak >= 2, `expected concurrent reads, peak=${peak}`);
  assert.ok(peak <= 4, `expected at most 4 concurrent reads, peak=${peak}`);
});
