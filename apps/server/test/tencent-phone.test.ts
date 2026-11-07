import {platformComponents} from "../src/platforms/index.js";
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tencentPhone,
  tencentPhoneKey,
} from "../src/platforms/shared/tencent/phone.js";
import { PlatformHttp, PlatformError } from "../src/platforms/shared/http.js";
import { TencentAdapter } from "../src/platforms/shared/tencent/client.js";
import { render } from "../src/meeting-shared.js";
import type { ConfigurationService } from "../src/config/configuration.service.js";
import type { PlatformConnectionService } from "../src/platform-connection.service.js";

test("Tencent phone bodies split Feishu country prefixes from national phone numbers", () => {
  for (const value of [
    "+8613800000000",
    "13800000000",
    "008613800000000",
    "+86 138-0000-0000",
    "8613800000000",
  ])
    assert.deepEqual(tencentPhone(value), { area: "86", phone: "13800000000" });
  assert.deepEqual(tencentPhone("+85251234567"), {
    area: "852",
    phone: "51234567",
  });
  assert.deepEqual(tencentPhone("+12025550123"), {
    area: "1",
    phone: "2025550123",
  });
  assert.equal(tencentPhone(null), undefined);
  for (const value of [
    "1234",
    "+86bad13800000000",
    "13800000000 ext 123",
    "+8601088888888",
  ])
    assert.throws(() => tencentPhone(value), /手机号码格式无效/);
});

test("phone matching preserves existing identities across country-code formats", () => {
  assert.equal(
    tencentPhoneKey("+8613800000000"),
    tencentPhoneKey("13800000000", "86"),
  );
  assert.equal(
    tencentPhoneKey("+85251234567"),
    tencentPhoneKey("51234567", "852"),
  );
  assert.notEqual(
    tencentPhoneKey("+12025550123"),
    tencentPhoneKey("+442025550123"),
  );
  assert.equal(tencentPhoneKey("138****0000"), "");
});

test("Tencent cancellation handles deleted meetings without hiding other failures", async (t) => {
  const alreadyCancelled = (reason = "MEETING CANCLED") =>
    new PlatformError("api.meeting.qq.com", "9007", true, 500, reason);
  const timeout = new PlatformError("api.meeting.qq.com", "NETWORK", true);
  const permissionDenied = new PlatformError("api.meeting.qq.com", "500122");
  const unrelated = alreadyCancelled("OTHER MEETING ERROR");
  const connections = {
    require: () => ({
      appId: "enterprise",
      sdkId: "app",
      secretId: "key",
      secretKey: "secret",
    }),
  } as unknown as PlatformConnectionService;
  const config = {
    decrypt: (value: string) => value,
  } as unknown as ConfigurationService;
  const scenarios: { name: string; responses: unknown[]; failure?: Error }[] = [
    { name: "normal cancellation", responses: [{}] },
    ...["MEETING CANCLED", "MEETING CANCELLED", "MEETING CANCELED"].map(
      (message) => ({
        name: message + " completes without a lookup",
        responses: [alreadyCancelled(message)],
      }),
    ),
    {
      name: "HTTP 200 cancellation envelope is also conclusive",
      responses: [
        { error_info: { error_code: 9007, message: "MEETING CANCLED" } },
      ],
    },
    {
      name: "uncertain cancellation is resolved by an already-deleted lookup",
      responses: [timeout, alreadyCancelled()],
    },
    {
      name: "uncertain cancellation is resolved by a cancelled meeting state",
      responses: [
        timeout,
        { meeting_info_list: [{ meeting_state: "MEETING_STATE_CANCELLED" }] },
      ],
    },
    {
      name: "an active meeting does not resolve an uncertain cancellation",
      responses: [
        timeout,
        { meeting_info_list: [{ meeting_state: "MEETING_STATE_STARTED" }] },
      ],
      failure: timeout,
    },
    {
      name: "permission and lookup failures retain the original error",
      responses: [permissionDenied, timeout],
      failure: permissionDenied,
    },
    {
      name: "a 9007 response without the cancellation reason is not accepted",
      responses: [unrelated, unrelated],
      failure: unrelated,
    },
  ];
  for (const scenario of scenarios)
    await t.test(scenario.name, async () => {
      let calls = 0;
      const http = {
        request: async (_url: string, method: string) => {
          assert.equal(method, calls === 0 ? "POST" : "GET");
          assert.ok(calls < scenario.responses.length, "unexpected lookup");
          const response = scenario.responses[calls++];
          if (response instanceof Error) throw response;
          return response;
        },
      } as unknown as PlatformHttp;
      const tencent = new TencentAdapter(config, http, connections);
      const result = tencent.cancel("meeting-1", {
        accountId: "host",
        secretId: "key",
        secretKey: "secret",
      });
      if (scenario.failure)
        await assert.rejects(result, (error) => error === scenario.failure);
      else await result;
      assert.equal(calls, scenario.responses.length);
    });
});

test("calendar templates can safely render arbitrary Tencent response paths", () => {
  const response = {
    meeting_info_list: [
      {
        meeting_id: "meeting-1",
        meeting_code: "123 456 789",
        nested: { value: "custom" },
      },
    ],
    meeting_info: { meeting_id: "meeting-1" },
  };
  assert.equal(
    render(
      "{provider.meeting_info_list.0.meeting_code}|{provider.nested.value}",
      {},
      response,
    ),
    "123 456 789|",
  );
  assert.equal(
    render("{provider.meeting_info.meeting_id}", {}, response),
    "meeting-1",
  );
  assert.equal(
    render("{provider.__proto__.polluted}|{provider.missing}", {}, response),
    "|",
  );
  assert.equal(
    render(
      "{provider.tencent/meeting_info.meeting_id}|{provider.feishu/meeting_info.meeting_id}",
      {},
      response,
      "tencent",
    ),
    "meeting-1|",
  );
});

test("users without a subdepartment omit department_list instead of sending an invalid empty array", async () => {
  const bodies: Record<string, unknown>[] = [];
  const http = {
    request: async (
      _url: string,
      _method: string,
      _headers: unknown,
      body: string,
    ) => {
      bodies.push(JSON.parse(body));
      return {};
    },
  } as unknown as PlatformHttp;
  const connections = {
    require: () => ({
      appId: "enterprise",
      sdkId: "app",
      secretId: "key",
      secretKey: "secret",
      operatorId: "operator",
    }),
  } as unknown as PlatformConnectionService;
  const tencent = new TencentAdapter(
    {} as ConfigurationService,
    http,
    connections,
  );
  const person = {
    id: "person",
    name: "企业成员",
    phone: "+8613800000000",
    departmentIds: [] as string[],
    advanced: false,
    disabled: false,
    exists: false,
  };
  await tencent.upsertUser(person);
  assert.equal(Object.hasOwn(bodies[0]!, "department_list"), false);
  assert.equal(bodies[0]!.phone, "13800000000");
  assert.equal(bodies[0]!.area, "86");
  await tencent.upsertUser({ ...person, departmentIds: ["child", "other"] });
  assert.deepEqual(bodies[1]!.department_list, ["child"]);
});

test("Tencent validation errors returned as HTTP 500 are definite failures with actionable messages", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error_info: { error_code: 20006, message: "手机格式异常" },
        }),
        { status: 500 },
      ),
  );
  await assert.rejects(
    () =>
      new PlatformHttp(platformComponents).request(
        "https://api.meeting.qq.com/v1/users",
        "POST",
        {},
        {},
      ),
    (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.code, "20006");
      assert.equal(error.httpStatus, 500);
      assert.equal(error.ambiguous, false);
      assert.match(error.message, /手机格式异常/);
      assert.match(error.message, /area=86/);
      assert.doesNotMatch(error.message, /结果不确定/);
      return true;
    },
  );
});

test("Tencent scope failures retain the operator-range explanation", () => {
  const error = new PlatformError(
    "api.meeting.qq.com",
    "500122",
    false,
    400,
    "该接口的操作者不在应用可用范围内。",
  );
  assert.match(error.message, /该接口的操作者不在应用可用范围内/);
  assert.match(error.message, /应用安全和可用范围/);
});

test("unrecognized server failures remain ambiguous and credentials are redacted", async (t) => {
  const secretId = "test-sensitive-secret-id";
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error_info: {
            error_code: 99999,
            message: "upstream failure " + secretId,
          },
        }),
        { status: 500 },
      ),
  );
  await assert.rejects(
    () =>
      new PlatformHttp(platformComponents).request(
        "https://api.meeting.qq.com/v1/meetings",
        "POST",
        { "X-TC-Key": secretId },
        {},
      ),
    (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.ambiguous, true);
      assert.match(error.message, /结果不确定/);
      assert.doesNotMatch(error.message, /test-sensitive-secret-id/);
      return true;
    },
  );
});

test("transport failures during writes still require reconciliation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection reset");
  });
  await assert.rejects(
    () =>
      new PlatformHttp(platformComponents).request(
        "https://api.meeting.qq.com/v1/users",
        "POST",
        {},
        {},
      ),
    (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.code, "NETWORK");
      assert.equal(error.ambiguous, true);
      return true;
    },
  );
});
