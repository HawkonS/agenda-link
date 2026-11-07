import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { SessionProvider } from "../src/lib/session";
import App from "../src/App";
import * as api from "../src/api";
import { DataTable } from "../src/components/common/workspace";
import { localDateTimeValue } from "../src/lib/date-time";
vi.mock("../src/api", () => ({
  me: vi.fn(),
  getBranding: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  request: vi.fn(),
  getSummary: vi.fn(),
  createMeeting: vi.fn(),
  requestKey: () => "stable-test-idempotency-key",
  api: { post: vi.fn(), get: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));
const admin = {
  id: 1,
  username: "admin",
  displayName: "测试管理员",
  avatarUrl: "https://example.com/admin.jpg",
  role: "system_admin" as const,
  meetingUserType: "ordinary" as const,
};
const branding = {
  name: "测试会议中心",
  title: "测试会议中心",
  logo: "/logo.svg",
  favicon: "/favicon.svg",
  primaryColor: "#1677ff",
  footer: "企业会议服务",
};
const platformFixtures = [
  {
    id: "directory.feishu",
    providerId: "feishu",
    name: "飞书",
    capability: "directory",
    connectionId: "feishu-directory",
    configured: true,
    capabilities: { read: true, import: true, write: false },
  },
  {
    id: "directory.tencent",
    providerId: "tencent",
    name: "腾讯会议",
    capability: "directory",
    connectionId: "tencent-meeting",
    configured: true,
    syncFrom: ["feishu-directory"],
    capabilities: { read: true, import: true, write: true },
  },
  {
    id: "meeting.tencent",
    providerId: "tencent",
    name: "腾讯会议",
    capability: "meeting",
    connectionId: "tencent-meeting",
    configured: true,
    capabilities: { accountPool: true, recording: true, cohost: true },
    templateVariables: [
      {
        key: "join_url",
        label: "腾讯入会链接",
        sample: "https://meeting.tencent.com/example",
      },
    ],
  },
  {
    id: "meeting.feishu",
    providerId: "feishu",
    name: "飞书",
    capability: "meeting",
    connectionId: "feishu-meeting",
    configured: false,
    capabilities: { accountPool: false, recording: true },
  },
  {
    id: "calendar.feishu",
    providerId: "feishu",
    name: "飞书",
    capability: "calendar",
    connectionId: "feishu-calendar",
    configured: true,
    capabilities: { create: true },
  },
];
const connectionMetadata: any = {
  "feishu-calendar": {
    name: "飞书日程",
    fields: [
      { key: "appId", label: "App ID", required: true },
      { key: "appSecret", label: "App Secret", required: true, secret: true },
      { key: "calendarId", label: "共享日历 ID", required: true },
    ],
  },
  "feishu-directory": {
    name: "飞书通讯录",
    fields: [
      { key: "appId", label: "App ID", required: true },
      { key: "appSecret", label: "App Secret", required: true, secret: true },
      { key: "rootDepartmentId", label: "同步根部门 ID" },
    ],
  },
  "tencent-meeting": {
    name: "腾讯会议开放平台",
    fields: [
      { key: "appId", label: "App ID / 企业 ID", required: true },
      { key: "sdkId", label: "Sdk ID", required: true },
      { key: "secretId", label: "Secret ID", required: true },
      { key: "secretKey", label: "Secret Key", required: true, secret: true },
      { key: "operatorId", label: "管理员 UserID", required: true },
      { key: "advancedType", label: "高级许可类型代码", type: "number" },
    ],
  },
};
let values: Record<string, string>,
  meetings: any[],
  events: any[],
  connections: any[],
  syncPreview: any;
let syncPolicy: any;
let recordItems: any[];
let recordingRows: any[];
function mount(path = "/dashboard") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  values = {
    "platform.name": branding.name,
    "platform.title": "测试会议中心",
    "platform.logo": "/logo.svg",
    "platform.favicon": "/favicon.svg",
    "platform.primary-color": "#1677ff",
    "recording.ttl-days": "30",
    "recording.delete-remote": "true",
    "sync.interval-minutes": "0",
    "sync.disable-missing": "false",
    "feishu.login.app-id": "",
    "feishu.login.app-secret": "",
    "feishu.login.redirect-uri": "",
    "feishu.login.tenant-key": "",
    "app.port": "18480",
    "web.port": "15173",
    "storage.data-dir": "./data",
    "logging.dir": "./logs",
    "worker.interval-seconds": "60",
    "auth.cookie-secure": "false",
  };
  syncPreview = { fetchedAt: null, departments: [], people: [] };
  syncPolicy = {
    overwriteDepartments: false,
    overwriteUsers: false,
    preserveExistingPermissions: true,
    automaticMode: "manual",
    intervalMinutes: 60,
    dailyTime: "03:00",
    disableMissingUsers: false,
    nextRunAt: null,
  };
  meetings = [];
  events = [];
  recordItems = [];
  recordingRows = [];
  connections = [
    {
      kind: "feishu-calendar",
      configured: true,
      values: {
        appId: "app-booking",
        appSecret: "********",
        calendarId: "calendar",
      },
    },
    {
      kind: "feishu-directory",
      configured: true,
      values: { appId: "app-booking", appSecret: "********", rootDepartmentId: "0" },
    },
    {
      kind: "tencent-meeting",
      configured: false,
      values: {
        appId: "",
        sdkId: "",
        secretId: "",
        secretKey: "",
        operatorId: "",
        advancedType: "9",
      },
    },
  ];
  vi.mocked(api.me).mockResolvedValue(admin);
  vi.mocked(api.getBranding).mockResolvedValue(branding);
  vi.mocked(api.login).mockResolvedValue({ token: "", user: admin });
  vi.mocked(api.logout).mockResolvedValue(undefined);
  vi.mocked(api.getSummary).mockResolvedValue({
    meetings: 0,
    recordings: 0,
    users: 1,
    departments: 0,
    accountPools: 0,
    upcoming: [],
  });
  vi.mocked(api.createMeeting).mockImplementation(async (payload: any) => {
    const created = {
      ...payload,
      platformName: "腾讯会议",
      id: 91,
      status: "provisioning",
      createdBy: admin.id,
    };
    meetings.push(created);
    return created;
  });
  vi.mocked(api.api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.api.get).mockImplementation(
    async (path) =>
      ({
        data:
          path === "/system/runtime"
            ? {
                version: "0.1.0",
                uptime: 100,
                api: true,
                web: true,
                worker: { enabled: true },
                ports: { api: "18480", web: "15173" },
                mode: "standalone",
                maintenance: { available: false },
              }
            : { text: "测试日志" },
      }) as any,
  );
  vi.mocked(api.request).mockImplementation(
    async (path, method = "GET", body: any) => {
      if (path === "/platforms") return platformFixtures;
      if (path === "/recordings" && method === "GET") return recordingRows;
      if (/^\/meetings\/\d+\/recordings$/.test(path) && method === "GET")
        return recordingRows
          .filter((row) => row.meeting.id === Number(path.split("/")[2]))
          .map((row) => row.recording);
      if (path.startsWith("/records/statistics"))
        return { created: 12, cancelled: 3, failed: 1, processing: 2 };
      if (path === "/system/logs")
        return [
          {
            name: "server.log",
            size: 100,
            modifiedAt: "2030-01-01T00:00:00Z",
            active: true,
          },
          {
            name: "web.log.1",
            size: 50,
            modifiedAt: "2030-01-01T00:00:00Z",
            active: false,
          },
        ];
      if (path === "/platform-connections")
        return connections.map((c) => ({
          ...c,
          ...connectionMetadata[c.kind],
        }));
      if (path === "/system/business-settings")
        return { ttlDays: 30, deleteRemote: true };
      if (path === "/system/configuration") {
        if (method === "PATCH") values = { ...values, ...body.values };
        return {
          values: { ...values },
          effective: { ...values },
          revision: "a".repeat(64),
          pendingRestart: [],
          encryptionKeyConfigured: true,
        };
      }
      if (path.startsWith("/records/") && method === "GET")
        return {
          items: recordItems,
          total: recordItems.length,
          page: 1,
          pageSize: 20,
          throughId: 120,
        };
      if (path.startsWith("/system/logs/")) return { text: "测试日志" };
      if (path === "/system-users")
        return [
          {
            ...admin,
            systemAccess: "allowed",
            status: "active",
            feishuLoginOpenId: null,
          },
        ];
      if (path === "/system-users/feishu-preview")
        return {
          people: [
            {
              open_id: "login-open",
              name: "飞书张三",
              avatarUrl: "https://example.com/zhang-san.jpg",
              mobile: "13800000000",
              systemAccess: "not_added",
              departmentNames: ["研发部"],
            },
          ],
        };
      if (path.startsWith("/sync/directory")) return syncPreview;
      if (path === "/sync/policy") {
        if (method === "PATCH")
          syncPolicy = {
            ...syncPolicy,
            ...body,
            nextRunAt:
              body.automaticMode === "manual" ? null : "2030-10-15T19:00:00Z",
          };
        return syncPolicy;
      }
      if (path === "/sync/feishu/read") {
        syncPreview = {
          fetchedAt: "2030-10-14T00:00:00Z",
          departments: [
            {
              id: 1,
              open_department_id: "dept-1",
              name: "研发部",
              path: "研发部",
              tencentDepartmentId: "td-1",
            },
          ],
          people: [
            {
              id: 2,
              open_id: "open-2",
              name: "飞书张三",
              avatarUrl: "https://example.com/zhang-san.jpg",
              department_ids: ["dept-1"],
              departmentNames: ["研发部"],
              phone: "13800000000",
              externalId: "existing-advanced",
              meetingUserType: "advanced",
            },
          ],
        };
        return syncPreview;
      }
      if (path === "/auth/feishu/status") return { enabled: false };
      if (path === "/calendar-owners") return [];
      if (path.split("?")[0] === "/meetings")
        return meetings.map((m) => ({
          platformName: "腾讯会议",
          calendarPlatformName: "飞书",
          connectionId: "tencent-meeting",
          calendarConnectionId: "feishu-calendar",
          ...m,
        }));
      if (path.split("?")[0] === "/calendar-events") return events;
      if (
        method === "GET" &&
        /^\/(meetings|calendar-events)\/\d+$/.test(path)
      ) {
        const source = path.startsWith("/meetings/") ? meetings : events;
        const row = source.find(
          (item) => item.id === Number(path.split("/").at(-1)),
        );
        return {
          platformName: "腾讯会议",
          calendarPlatformName: "飞书",
          calendarConnectionId: "feishu-calendar",
          ...row,
          calendarDescription: row.calendarDescription ?? row.description,
        };
      }
      if (path.startsWith("/directory/people"))
        return [
          { id: admin.id, displayName: admin.displayName, externalId: null },
          { id: 2, displayName: "已同步成员", externalId: "member-2" },
          { id: 3, displayName: "未同步成员", externalId: null },
        ];
      if (path === "/booking/options")
        return { recordingTtlDays: 45, platforms: platformFixtures };
      if (path === "/system/settings") {
        if (method === "PATCH") {
          values = { ...values, ...body };
          return { restartRequired: false };
        }
        return {
          values: { ...values },
          connections: connections.map((c) => ({
            ...c,
            ...connectionMetadata[c.kind],
          })),
          databasePath: "/test/data.sqlite",
          jobs: [],
        };
      }
      if (path.startsWith("/platform-connections/") && method === "PATCH")
        return {};
      return [];
    },
  );
});
describe("React workspace migration", () => {
  it("keeps page names accessible while removing visible page title blocks", async () => {
    mount("/account-pools");
    const heading = await screen.findByRole("heading", { name: "账号资源" });
    expect(heading.classList.contains("sr-only")).toBe(true);
    expect(document.querySelector(".page-title")).toBeNull();
  });
  it("switching configuration groups keeps unsaved values and uses revisioned saves", async () => {
    mount("/settings?tab=branding");
    const user = userEvent.setup();
    const name = await screen.findByLabelText("平台名称");
    await user.clear(name);
    await user.type(name, "新会议平台");
    await user.click(screen.getByRole("tab", { name: "飞书登录" }));
    expect(await screen.findByLabelText("登录应用 App ID")).not.toBeNull();
    await user.click(screen.getByRole("tab", { name: "品牌外观" }));
    expect((screen.getByLabelText("平台名称") as HTMLInputElement).value).toBe(
      "新会议平台",
    );
    await user.click(screen.getByRole("button", { name: "保存配置变更" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/system/configuration",
        "PATCH",
        { revision: "a".repeat(64), values: { "platform.name": "新会议平台" } },
      ),
    );
  });
  it.each(["pending", "provisioning", "cancelling"])(
    "refreshes %s schedules every second and returns to normal polling after completion",
    async (status) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      let view: ReturnType<typeof mount> | undefined;
      try {
        const row = {
          id: 71,
          subject: "状态刷新测试",
          status,
          startAt: "2030-10-14T10:00:00.000Z",
          endAt: "2030-10-14T11:00:00.000Z",
        };
        if (status === "pending") events = [row];
        else meetings = [row];
        view = mount("/calendar?tab=list");
        await waitFor(() =>
          expect(view!.client.getQueryData(["calendar"])).toBeDefined(),
        );
        const fetchCount = () =>
          vi
            .mocked(api.request)
            .mock.calls.filter(([path]) => path.split("?")[0] === "/meetings").length;
        const initial = fetchCount();
        if (status === "pending") events = [{ ...row, status: "synced" }];
        else
          meetings = [
            {
              ...row,
              status: status === "cancelling" ? "cancelled" : "scheduled",
            },
          ];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(fetchCount()).toBe(initial + 1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(fetchCount()).toBe(initial + 1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(8000);
        });
        expect(fetchCount()).toBe(initial + 2);
      } finally {
        view?.unmount();
        view?.client.clear();
        vi.useRealTimers();
      }
    },
  );
  it("calendar and list views both include personal schedules and booked meetings", async () => {
    const startAt = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      15,
      10,
    ).toISOString();
    const endAt = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      15,
      11,
    ).toISOString();
    meetings = [
      {
        id: 21,
        subject: "项目评审会",
        startAt,
        endAt,
        status: "scheduled",
        createdBy: 1,
      },
    ];
    events = [
      { id: 21, subject: "个人待办日程", startAt, endAt, status: "synced" },
    ];
    mount("/calendar");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /项目评审会/ });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "日历视图",
      "列表视图",
    ]);
    expect(
      screen
        .getByRole("tab", { name: "日历视图" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: /个人待办日程/ })).not.toBeNull();
    await user.click(screen.getByRole("tab", { name: "列表视图" }));
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["选择", "日程名称", "类别", "开始时间", "结束时间", "预约人", "状态", "操作"]);
    expect(screen.getByRole("button", { name: "个人待办日程" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "上个月" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "项目评审会" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "项目评审会" }),
    ).not.toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "取消会议" }),
    ).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("tab", { name: "日历视图" }));
    expect(screen.getByRole("button", { name: "上个月" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /项目评审会/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /个人待办日程/ })).not.toBeNull();
  });
  it("old meeting links use the new list view and keep the same view tabs", async () => {
    meetings = [
      {
        id: 51,
        subject: "旧链接会议",
        startAt: "2030-10-15T02:00:00Z",
        endAt: "2030-10-15T03:00:00Z",
        status: "scheduled",
      },
    ];
    mount("/calendar?tab=meetings");
    await screen.findByRole("button", { name: "旧链接会议" });
    expect(
      screen
        .getByRole("tab", { name: "列表视图" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "日历视图",
      "列表视图",
    ]);
  });
  it.each(["event", "meeting"])(
    "copies the exact %s description with line breaks from its detail dialog",
    async (kind) => {
      const description =
        "  项目进展评审\n腾讯会议号：123 456 789\nhttps://meeting.tencent.com/example\n";
      const row = {
        id: 33,
        subject: "可以复制的日程",
        description,
        startAt: "2030-10-15T02:00:00Z",
        endAt: "2030-10-15T03:00:00Z",
        status: kind === "event" ? "synced" : "scheduled",
      };
      if (kind === "event") events = [row];
      else meetings = [row];
      const user = userEvent.setup();
      const writeText = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();
      mount("/calendar?tab=list");
      await user.click(
        await screen.findByRole("button", { name: row.subject }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", { name: "复制说明" }),
      );
      expect(writeText).toHaveBeenCalledWith(description);
      expect(toast.success).toHaveBeenCalledWith("日程说明已复制");
    },
  );
  it("does not offer copying an empty description", async () => {
    events = [
      {
        id: 34,
        subject: "空说明日程",
        description: "  ",
        status: "pending",
        startAt: "2030-10-15T02:00:00Z",
        endAt: "2030-10-15T03:00:00Z",
      },
    ];
    const user = userEvent.setup();
    mount("/calendar?tab=list");
    await user.click(await screen.findByRole("button", { name: "空说明日程" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("暂无说明")).not.toBeNull();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "复制说明",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("shows the full Feishu note instead of an empty booking description", async () => {
    const calendarDescription =
      "张三 邀请你参加项目评审\n\n腾讯会议号：123 456 789\n加入腾讯会议：https://meeting.tencent.com/example\n\n部门: 研发部\n<script>unsafe</script>";
    meetings = [
      {
        id: 72,
        subject: "完整飞书说明",
        description: "",
        calendarDescription,
        startAt: "2030-10-15T02:00:00Z",
        endAt: "2030-10-15T03:00:00Z",
        status: "scheduled",
        meetingCode: "123 456 789",
      },
    ];
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    mount("/calendar?tab=list");
    await user.click(
      await screen.findByRole("button", { name: "完整飞书说明" }),
    );
    const dialog = await screen.findByRole("dialog");
    const copy = within(dialog).getByRole("button", { name: "复制说明" });
    await waitFor(() =>
      expect((copy as HTMLButtonElement).disabled).toBe(false),
    );
    expect(
      dialog.querySelector(".calendar-detail-description-content")?.textContent,
    ).toBe(calendarDescription);
    expect(dialog.querySelector("script")).toBeNull();
    expect(
      within(dialog)
        .getByRole("link", { name: "https://meeting.tencent.com/example" })
        .getAttribute("href"),
    ).toBe("https://meeting.tencent.com/example");
    await user.click(copy);
    expect(writeText).toHaveBeenLastCalledWith(calendarDescription);
    await user.click(
      within(dialog).getByRole("button", { name: "复制会议号" }),
    );
    expect(writeText).toHaveBeenLastCalledWith("123 456 789");
  });
  it("keeps copying unavailable until the detail response has loaded", async () => {
    meetings = [
      {
        id: 73,
        subject: "异步日程说明",
        description: "原始输入",
        status: "scheduled",
        startAt: "2030-10-15T02:00:00Z",
        endAt: "2030-10-15T03:00:00Z",
      },
    ];
    const original = vi.mocked(api.request).getMockImplementation()!;
    let resolve!: (value: any) => void;
    vi.mocked(api.request).mockImplementation((path, ...args) =>
      path === "/meetings/73"
        ? new Promise((done) => {
            resolve = done;
          })
        : original(path, ...args),
    );
    const user = userEvent.setup();
    mount("/calendar?tab=list");
    await user.click(
      await screen.findByRole("button", { name: "异步日程说明" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("加载说明…")).not.toBeNull();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "复制说明",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(dialog).queryByText("原始输入")).toBeNull();
    await act(async () =>
      resolve({ ...meetings[0], calendarDescription: "完整的飞书说明" }),
    );
    expect(await within(dialog).findByText("完整的飞书说明")).not.toBeNull();
  });
  it("reports a clipboard failure without claiming success", async () => {
    events = [
      {
        id: 35,
        subject: "复制失败日程",
        description: "日程说明内容",
        status: "pending",
        startAt: "2030-10-15T02:00:00Z",
        endAt: "2030-10-15T03:00:00Z",
      },
    ];
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("Permission denied"),
    );
    mount("/calendar?tab=list");
    await user.click(
      await screen.findByRole("button", { name: "复制失败日程" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "复制说明",
      }),
    );
    expect(toast.error).toHaveBeenCalledWith("复制失败，请手动选择说明内容");
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("updates an open newly created reservation from pending to successful without reopening it", async () => {
    const user = userEvent.setup();
    mount("/meetings");
    fireEvent.change(await screen.findByLabelText("会议主题"), {
      target: { value: "创建进度验证" },
    });
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    await user.click(screen.getByRole("button", { name: "提交预约" }));
    const dialog = await screen.findByRole("dialog", { name: "创建进度验证" });
    expect(within(dialog).getByText("预约中 · 腾讯会议")).not.toBeNull();
    meetings[0] = {
      ...meetings[0],
      meetingCode: "123 456 789",
      meetingUrl: "https://meeting.tencent.com/example",
    };
    await waitFor(
      () =>
        expect(within(dialog).getByText("已预约 · 腾讯会议")).not.toBeNull(),
      { timeout: 2500 },
    );
    expect(within(dialog).getByText("预约中 · 飞书日程")).not.toBeNull();
    meetings[0] = { ...meetings[0], status: "scheduled" };
    await waitFor(
      () =>
        expect(within(dialog).getByText("已预约 · 飞书日程")).not.toBeNull(),
      { timeout: 2500 },
    );
    expect(within(dialog).queryByText("预约中 · 腾讯会议")).toBeNull();
    expect(
      within(dialog)
        .getByRole("link", { name: "进入会议" })
        .getAttribute("href"),
    ).toBe("https://meeting.tencent.com/example");
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["failed", undefined, "预约失败 · 腾讯会议"],
    ["failed", "123456789", "预约失败 · 飞书日程"],
    ["unknown", undefined, "待核对 · 腾讯会议"],
    ["cancel_failed", "123456789", "取消失败 · 飞书日程"],
  ])(
    "shows a persistent actionable result for %s (%s)",
    async (status, code, title) => {
      meetings = [
        {
          id: 93,
          subject: "未完成的预约",
          status,
          meetingCode: code,
          provisionStep:
            status === "cancel_failed" ? "meeting_cancelled" : "reserved",
          error: "平台暂时不可用",
          createdBy: admin.id,
          startAt: "2030-10-14T02:00:00Z",
          endAt: "2030-10-14T03:00:00Z",
        },
      ];
      mount("/calendar?meeting=93");
      const dialog = await screen.findByRole("dialog", {
        name: "未完成的预约",
      });
      expect(within(dialog).getByText(title)).not.toBeNull();
      expect(
        within(dialog).getByRole("button", {
          name:
            status === "unknown"
              ? "核对结果"
              : status === "cancel_failed"
                ? "重试取消"
                : "重试",
        }),
      ).not.toBeNull();
      if (code)
        expect(
          within(dialog).getByText(
            status === "cancel_failed"
              ? "已取消 · 腾讯会议"
              : "已预约 · 腾讯会议",
          ),
        ).not.toBeNull();
      expect(within(dialog).queryByText("预约成功")).toBeNull();
    },
  );
  it.each([
    ["scheduled", "pending", "等待开会", "会议开始、参会人入会后自动设置"],
    ["scheduled", "waiting_join", "等待入会", "请使用绑定账号加入会议"],
    ["scheduled", "failed", "失败", "腾讯会议权限不足（9042）"],
    ["cancelled", "pending", "会议已取消", "不再设置联席主持人"],
    ["finished", "pending", "会议已结束", "会议结束前未完成设置"],
  ])(
    "explains cohost state %s / %s in meeting details",
    async (status, cohostStatus, label, reason) => {
      meetings = [
        {
          id: 81,
          subject: "联席状态测试",
          status,
          createdBy: 1,
          startAt: "2035-10-15T02:00:00Z",
          endAt: "2035-10-15T03:00:00Z",
          attendees: [
            {
              id: 1,
              displayName: "受邀参会人",
              cohostStatus,
              cohostError: ["waiting_join", "failed"].includes(cohostStatus)
                ? reason
                : null,
            },
          ],
        },
      ];
      mount("/calendar?tab=list");
      const user = userEvent.setup();
      if (status === "cancelled") {
        await user.click(await screen.findByRole("button", { name: /筛选/ }));
        await user.click(
          await screen.findByRole("combobox", { name: "日程状态" }),
        );
        await user.click(
          await screen.findByRole("option", { name: "全部状态" }),
        );
        await user.click(screen.getByRole("button", { name: "完成" }));
      }
      await user.click(await screen.findByRole("button", { name: "详情" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(label)).not.toBeNull();
      expect(within(dialog).getByText(reason)).not.toBeNull();
      expect(within(dialog).queryByText("等待同步")).toBeNull();
    },
  );
  it("does not truncate server-paginated rows when local pagination is disabled", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `记录 ${i + 1}`,
    }));
    render(
      <DataTable
        rows={rows}
        pagination={false}
        columns={[{ key: "name", title: "记录", render: (row) => row.name }]}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(26);
    expect(screen.getByText("记录 25")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
  });
  it("keeps default and custom column widths unchanged when paging to long content", async () => {
    render(
      <DataTable
        rows={[
          { id: 1, name: "短名字" },
          { id: 2, name: "很长的第二页用户名".repeat(30) },
        ]}
        pageSize={1}
        columns={[
          {
            key: "name",
            title: "用户",
            render: (row) => row.name,
          },
          {
            key: "actions",
            title: "操作",
            width: 200,
            render: () => <button>编辑</button>,
          },
        ]}
      />,
    );
    const user = userEvent.setup();
    const table = screen.getByRole("table");
    const layout = () => ({
      minimum: table.style.getPropertyValue("--table-min-width"),
      columns: Array.from(table.querySelectorAll("col")).map((column) =>
        column.style.getPropertyValue("--column-width"),
      ),
    });
    expect(table.classList.contains("data-table--fixed")).toBe(true);
    expect(layout()).toEqual({ minimum: "440px", columns: ["240px", "200px"] });
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.queryByText("短名字")).toBeNull();
    expect(screen.getByText("很长的第二页用户名".repeat(30))).not.toBeNull();
    expect(layout()).toEqual({ minimum: "440px", columns: ["240px", "200px"] });
  });
  it("shows Feishu callback errors as a toast and consumes the URL message", async () => {
    vi.mocked(api.me).mockRejectedValueOnce(new Error("unauthorized"));
    mount("/login?auth_error=feishu_login_failed");
    await screen.findByRole("heading", { name: "欢迎回来" });
    const buildInfo = screen.getByLabelText("构建信息");
    expect(buildInfo.textContent).not.toContain("构建号");
    expect(buildInfo.querySelector("span")?.textContent?.trim()).not.toBe("");
    expect(buildInfo.textContent).toMatch(/最后更新: .+/);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "飞书登录失败，请重新发起授权后重试。若问题持续，请联系管理员。",
      ),
    );
    expect(screen.queryByText("feishu_login_failed")).toBeNull();
  });
  it("local sign-in restores the workspace without an initialization page", async () => {
    vi.mocked(api.me).mockRejectedValueOnce(new Error("unauthorized"));
    mount("/login");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "欢迎回来" });
    await user.type(screen.getByLabelText("用户名"), "admin");
    await user.type(screen.getByLabelText("密码"), "test-password-only");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(api.login).toHaveBeenCalledWith("admin", "test-password-only"),
    );
    await screen.findByRole("heading", { name: /测试管理员/ });
  });
  it("shows local sign-in failures as a toast instead of an inline banner", async () => {
    vi.mocked(api.me).mockRejectedValueOnce(new Error("unauthorized"));
    vi.mocked(api.login).mockRejectedValueOnce({
      response: { data: { message: "用户名或密码错误" } },
    });
    mount("/login");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "欢迎回来" });
    await user.type(screen.getByLabelText("用户名"), "admin");
    await user.type(screen.getByLabelText("密码"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("用户名或密码错误"),
    );
    expect(screen.queryByText("登录遇到问题？请联系管理员")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("ordinary users cannot open admin pages or see operator navigation", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "user" });
    mount("/settings");
    await screen.findByRole("heading", { name: /测试管理员/ });
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByText("系统设置")).toBeNull();
    expect(within(nav).queryByText("组织人员")).toBeNull();
    expect(api.request).not.toHaveBeenCalledWith("/system/settings");
  });
  it("operators have organization controls but no system configuration access", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "operation_admin" });
    mount("/user-sync");
    expect(await screen.findByRole("tab", { name: "飞书用户" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "用户同步" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(
      within(nav).getByRole("link", { name: "组织同步" }),
    ).not.toBeNull();
    expect(
      within(nav).getByRole("link", { name: "人员同步" }),
    ).not.toBeNull();
    expect(within(nav).queryByRole("link", { name: "系统设置" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "账号权限" })).toBeNull();
  });
  it("meetings validate time ranges and submit mapped invitees with an idempotency key", async () => {
    mount("/meetings");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "会议管理" });
    await user.type(await screen.findByLabelText("会议主题"), "产品讨论");
    fireEvent.change(await screen.findByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    fireEvent.change(await screen.findByLabelText("结束时间"), {
      target: { value: "2030-10-14T09:00" },
    });
    await user.click(screen.getByRole("button", { name: "提交预约" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "结束时间应晚于开始时间",
    );
    expect(api.createMeeting).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText("结束时间"), {
      target: { value: "2030-10-14T11:00" },
    });
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "测试管理员（我）",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "已同步成员" }));
    expect(
      (screen.getByRole("checkbox", { name: /未同步成员/ }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await user.click(screen.getByRole("button", { name: "提交预约" }));
    await waitFor(() =>
      expect(api.createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "产品讨论",
          attendeeIds: [1, 2],
          recordingTtlDays: 45,
          extensions: {},
        }),
        "stable-test-idempotency-key",
      ),
    );
    expect(vi.mocked(api.createMeeting).mock.calls[0]![0]).not.toHaveProperty(
      "reminders",
    );
    const detail = await screen.findByRole("dialog", { name: "产品讨论" });
    expect(within(detail).getByText("预约中 · 腾讯会议")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "提交预约" })).toBeNull();
    await user.click(within(detail).getByRole("button", { name: "关闭详情" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "预约记录" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
  it("places the description beside a template that uses it", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation((path, ...args) =>
      path === "/calendar-templates"
        ? Promise.resolve([
            {
              id: 9,
              name: "默认邀请",
              descriptionTemplate: "{description}",
              enabled: true,
              isDefault: true,
            },
          ])
        : base(path, ...args),
    );
    const user = userEvent.setup();
    mount("/meetings");
    await user.type(await screen.findByLabelText("会议主题"), "无提醒设置会议");

    const accountFields = screen.getByRole("group", { name: "发起账号选择" });
    expect(
      within(accountFields).getByRole("combobox", { name: "日程模板" }),
    ).not.toBeNull();
    expect(within(accountFields).getByLabelText("会议说明")).not.toBeNull();
    await user.click(screen.getByText("更多", { selector: "span" }));
    const more = document.querySelector(
      "details.booking-disclosure",
    ) as HTMLElement;
    expect(within(more).queryByLabelText("提醒时间")).toBeNull();
    expect(within(more).queryByLabelText("会议说明")).toBeNull();

    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    await user.click(screen.getByRole("button", { name: "提交预约" }));
    await waitFor(() =>
      expect(api.createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          recordingEnabled: true,
          calendarTemplateId: 9,
        }),
        "stable-test-idempotency-key",
      ),
    );
    const payload = vi.mocked(api.createMeeting).mock.calls[0]![0];
    expect(payload).not.toHaveProperty("reminders");
    expect(payload).not.toHaveProperty("reminderSelection");
    expect(payload).not.toHaveProperty("location");
  });
  it("keeps the description in More when a template does not use it", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation((path, ...args) =>
      path === "/calendar-templates"
        ? Promise.resolve([
            {
              id: 10,
              name: "仅会议号",
              descriptionTemplate: "会议号：{meetingCode}",
              enabled: true,
              isDefault: true,
            },
          ])
        : base(path, ...args),
    );
    const user = userEvent.setup();
    mount("/meetings");
    await user.type(await screen.findByLabelText("会议主题"), "普通模板会议");
    const accountFields = screen.getByRole("group", { name: "发起账号选择" });
    expect(within(accountFields).queryByLabelText("会议说明")).toBeNull();
    await user.click(screen.getByText("更多", { selector: "span" }));
    expect(
      within(screen.getByText("会议说明").closest("details")!).getByLabelText(
        "会议说明",
      ),
    ).not.toBeNull();
  });
  it("lets requesters deselect themselves without restoring the default", async () => {
    mount("/meetings");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "选择内部参会人" }),
    );
    const self = screen.getByRole("checkbox", {
      name: "测试管理员（我）",
    }) as HTMLInputElement;
    expect(self.disabled).toBe(false);
    expect(self.checked).toBe(true);
    await user.click(self);
    await user.click(screen.getByRole("button", { name: "完成" }));
    fireEvent.change(screen.getByLabelText("会议主题"), {
      target: { value: "保留手动选择" },
    });
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "测试管理员（我）",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.getByLabelText("会议主题")).toHaveProperty(
      "value",
      "保留手动选择",
    );
  });
  it("failed meeting requests keep the same idempotency key on retry", async () => {
    vi.mocked(api.createMeeting).mockRejectedValueOnce(new Error("network"));
    mount("/meetings");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "会议管理" });
    fireEvent.change(await screen.findByLabelText("会议主题"), {
      target: { value: "同一次请求" },
    });
    fireEvent.change(await screen.findByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    fireEvent.change(await screen.findByLabelText("结束时间"), {
      target: { value: "2030-10-14T11:00" },
    });
    const submit = screen.getByRole("button", { name: "提交预约" });
    await user.click(submit);
    await waitFor(() =>
      expect((submit as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(submit);
    await waitFor(() => expect(api.createMeeting).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createMeeting).mock.calls.map((c) => c[1])).toEqual([
      "stable-test-idempotency-key",
      "stable-test-idempotency-key",
    ]);
  });
  it("books after confirming the default current start and suggested end without choosing a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(2030, 9, 15, 14, 37);
    vi.setSystemTime(now);
    try {
      const base = vi.mocked(api.request).getMockImplementation()!;
      vi.mocked(api.request).mockImplementation(async (path, method, body) => {
        if (path === "/booking/host-preview")
          return {
            available: true,
            allocationSource: "pool",
            hostAccountName: "共享主持人",
            hostAccountId: "shared-host",
            accountPoolId: 7,
            accountPoolName: "研发备用池",
          };
        return base(path, method, body);
      });
      mount("/meetings");
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText("会议主题"), "马上开会");
      await user.click(screen.getByLabelText("开始时间"));
      await user.click(screen.getByRole("button", { name: "完成" }));
      const end = new Date(now.getTime() + 60 * 60 * 1000);
      expect(
        (screen.getByLabelText("开始时间") as HTMLInputElement).value,
      ).toBe(localDateTimeValue(now).replace("T", " "));
      expect(
        (screen.getByLabelText("结束时间") as HTMLInputElement).value,
      ).toBe(localDateTimeValue(end).replace("T", " "));
      await user.click(screen.getByLabelText("结束时间"));
      await user.click(screen.getByRole("button", { name: "完成" }));
      const summary = screen.getByRole("complementary", { name: "预约摘要" });
      await screen.findByText("共享主持人", { selector: ".booking-host-name" });
      expect(api.request).toHaveBeenCalledWith(
        "/booking/host-preview",
        "POST",
        {
          providerId: "tencent",
          connectionId: "tencent-meeting",
          startAt: now.toISOString(),
          endAt: end.toISOString(),
          attendeeIds: [admin.id],
        },
      );
      await user.click(screen.getByRole("button", { name: "提交预约" }));
      await waitFor(() =>
        expect(api.createMeeting).toHaveBeenCalledWith(
          expect.objectContaining({
            providerId: "tencent",
            connectionId: "tencent-meeting",
            startAt: now.toISOString(),
            endAt: end.toISOString(),
          }),
          "stable-test-idempotency-key",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not overwrite a manually specified end when the booking start changes", async () => {
    mount("/meetings");
    fireEvent.change(await screen.findByLabelText("结束时间"), {
      target: { value: "2030-10-15T15:00" },
    });
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-15T14:00" },
    });
    expect((screen.getByLabelText("结束时间") as HTMLInputElement).value).toBe(
      "2030-10-15 15:00",
    );
  });
  it("keeps the suggested end an hour after the start while choosing its day and time", async () => {
    mount("/meetings");
    fireEvent.change(await screen.findByLabelText("开始时间"), {
      target: { value: "2030-10-15T09:30" },
    });
    expect((screen.getByLabelText("结束时间") as HTMLInputElement).value).toBe(
      "2030-10-15 10:30",
    );
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-16T23:30" },
    });
    expect((screen.getByLabelText("结束时间") as HTMLInputElement).value).toBe(
      "2030-10-17 00:30",
    );
  });
  it("previews the host after picking a calendar day and time from the dropdowns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 9, 15, 14, 37));
    try {
      const base = vi.mocked(api.request).getMockImplementation()!;
      vi.mocked(api.request).mockImplementation(async (path, method, body) => {
        if (path === "/booking/host-preview")
          return {
            available: true,
            allocationSource: "pool",
            hostAccountName: "明天的主持人",
            hostAccountId: "tomorrow-host",
            accountPoolId: 8,
            accountPoolName: "客户会议池",
          };
        return base(path, method, body);
      });
      mount("/meetings");
      const user = userEvent.setup();
      await user.click(await screen.findByLabelText("开始时间"));
      await user.click(screen.getByRole("button", { name: /2030年10月16日/ }));
      await user.click(screen.getByRole("combobox", { name: "开始时间小时" }));
      await user.click(screen.getByRole("option", { name: /^18$/ }));
      await user.click(screen.getByRole("button", { name: "完成" }));
      await user.click(screen.getByLabelText("结束时间"));
      await user.click(screen.getByRole("button", { name: "完成" }));
      const summary = screen.getByRole("complementary", { name: "预约摘要" });
      await screen.findByText("明天的主持人", { selector: ".booking-host-name" });
      expect(api.request).toHaveBeenLastCalledWith(
        "/booking/host-preview",
        "POST",
        {
          providerId: "tencent",
          connectionId: "tencent-meeting",
          startAt: new Date(2030, 9, 16, 18, 37).toISOString(),
          endAt: new Date(2030, 9, 16, 19, 37).toISOString(),
          attendeeIds: [admin.id],
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    ["2030-10-14T10:00", "结束时间应晚于开始时间"],
    ["2030-10-14T09:00", "结束时间应晚于开始时间"],
    ["2030-02-30T11:00", "结束时间格式不正确"],
    ["无效时间", "结束时间格式不正确"],
  ])(
    "explains an invalid end time %s and recovers the host when corrected",
    async (endAt, message) => {
      const base = vi.mocked(api.request).getMockImplementation()!;
      vi.mocked(api.request).mockImplementation(async (path, method, body) => {
        if (path === "/booking/host-preview")
          return {
            available: true,
            allocationSource: "pool",
            hostAccountName: "空闲主持人",
            hostAccountId: "idle-host",
            accountPoolId: 7,
            accountPoolName: "空闲账号池",
          };
        return base(path, method, body);
      });
      mount("/meetings");
      fireEvent.change(await screen.findByLabelText("开始时间"), {
        target: { value: "2030-10-14T10:00" },
      });
      fireEvent.change(screen.getByLabelText("结束时间"), {
        target: { value: endAt },
      });
      const summary = screen.getByRole("complementary", { name: "预约摘要" });
      expect(screen.getByText(message)).not.toBeNull();
      expect(
        screen.queryByText("填写开始和结束时间后显示"),
      ).toBeNull();
      fireEvent.change(screen.getByLabelText("结束时间"), {
        target: { value: "2030-10-14T11:00" },
      });
      await screen.findByText("空闲主持人", { selector: ".booking-host-name" });
      expect(screen.queryByText(message)).toBeNull();
      fireEvent.change(screen.getByLabelText("结束时间"), {
        target: { value: endAt },
      });
      expect(screen.queryByText("空闲主持人", { selector: ".booking-host-name" })).toBeNull();
    },
  );
  it("host preview follows time, invitees and pool selection and shows the actual account and named pool", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation(
      async (path, method, body: any) => {
        if (path === "/account-pools")
          return [{ id: 7, name: "研发备用池", enabled: true }];
        if (path === "/booking/host-preview") {
          expect(method).toBe("POST");
          return {
            available: true,
            allocationSource: body.attendeeIds.includes(2) ? "invitee" : "pool",
            hostAccountName: body.attendeeIds.includes(2)
              ? "受邀张三"
              : "共享主持人",
            hostAccountId: body.attendeeIds.includes(2)
              ? "zhangsan-host"
              : "shared-host",
            accountPoolName: body.attendeeIds.includes(2) ? null : "研发备用池",
          };
        }
        return base(path, method, body);
      },
    );
    mount("/meetings");
    const user = userEvent.setup();
    const summary = await screen.findByRole("complementary", {
      name: "预约摘要",
    });
    expect(
      screen.getByText("填写开始和结束时间后显示"),
    ).not.toBeNull();
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(([path]) => path === "/booking/host-preview"),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2030-10-14T11:00" },
    });
    await screen.findByText("共享主持人", { selector: ".booking-host-name" });
    expect(within(summary).queryByText("shared-host")).toBeNull();
    expect(
      screen.getByText("账号池", { selector: ".booking-host-source" }),
    ).not.toBeNull();
    await user.click(
      screen.getByRole("button", { name: "查看发起账号：共享主持人" }),
    );
    const details = screen.getByRole("dialog", { name: "发起账号详情" });
    expect(within(details).getByText("shared-host")).not.toBeNull();
    expect(within(details).getByText("研发备用池")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "发起账号详情" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "发起账号" }));
    await user.click(screen.getByRole("option", { name: "使用账号池" }));
    await user.click(screen.getByRole("combobox", { name: "账号池" }));
    await user.click(screen.getByRole("option", { name: "研发备用池" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/booking/host-preview",
        "POST",
        expect.objectContaining({ accountPoolId: 7 }),
      ),
    );
    await user.click(screen.getByRole("combobox", { name: "发起账号" }));
    await user.click(
      screen.getByRole("option", { name: "自动选择（本人优先）" }),
    );
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    await user.click(screen.getByRole("checkbox", { name: "已同步成员" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    await screen.findByText("受邀张三", { selector: ".booking-host-name" });
    expect(screen.getByText("受邀人", { selector: ".booking-host-source" })).not.toBeNull();
    expect(screen.queryByText("共享主持人", { selector: ".booking-host-name" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "查看发起账号：受邀张三" })
        .title,
    ).toContain("zhangsan-host");
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2030-10-14T09:00" },
    });
    expect(screen.queryByText("受邀张三", { selector: ".booking-host-name" })).toBeNull();
  });
  it("keeps a confirmed personal host while attendees change, but checks new times", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    const hostRequests: any[] = [];
    let personalAvailable = true;
    vi.mocked(api.request).mockImplementation(
      async (path, method, body: any) => {
        if (path === "/account-pools")
          return [{ id: 7, name: "研发备用池", enabled: true }];
        if (path === "/booking/host-preview") {
          hostRequests.push(body);
          const source = personalAvailable
            ? "personal"
            : body.attendeeIds.includes(2)
              ? "invitee"
              : "pool";
          return {
            available: true,
            allocationSource: source,
            hostAccountId: `${source}-host`,
            hostAccountName:
              source === "personal"
                ? "本人主持账号"
                : source === "invitee"
                  ? "受邀主持账号"
                  : "备用主持账号",
            accountPoolId: source === "pool" ? 7 : null,
            accountPoolName: source === "pool" ? "研发备用池" : null,
          };
        }
        return base(path, method, body);
      },
    );
    mount("/meetings");
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    const summary = screen.getByRole("complementary", { name: "预约摘要" });
    await screen.findByText("本人主持账号", { selector: ".booking-host-name" });
    expect(hostRequests).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    await user.click(screen.getByRole("checkbox", { name: "已同步成员" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.getByText("本人主持账号", { selector: ".booking-host-name" })).not.toBeNull();
    expect(screen.queryByText("正在查找空闲高级账号…")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "移除测试管理员（我）" }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(hostRequests).toHaveLength(1);
    expect(screen.getByText("本人主持账号", { selector: ".booking-host-name" })).not.toBeNull();
    personalAvailable = false;
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2030-10-14T12:00" },
    });
    await screen.findByText("受邀主持账号", { selector: ".booking-host-name" });
    expect(hostRequests).toHaveLength(2);
    expect(hostRequests[1]).toMatchObject({
      attendeeIds: [2],
      endAt: new Date(2030, 9, 14, 12).toISOString(),
    });
    await user.click(screen.getByRole("button", { name: "移除已同步成员" }));
    await screen.findByText("备用主持账号", { selector: ".booking-host-name" });
    expect(hostRequests).toHaveLength(3);
  });
  it("uses the latest attendees when a refreshed personal host becomes unavailable", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    const hostRequests: any[] = [];
    let personalAvailable = true;
    vi.mocked(api.request).mockImplementation(
      async (path, method, body: any) => {
        if (path === "/booking/host-preview") {
          hostRequests.push(body);
          const invited = body.attendeeIds.includes(2);
          return {
            available: true,
            allocationSource: personalAvailable
              ? "personal"
              : invited
                ? "invitee"
                : "pool",
            hostAccountId: "host",
            hostAccountName: personalAvailable
              ? "本人主持账号"
              : invited
                ? "当前受邀主持人"
                : "旧的账号池主持人",
            accountPoolId: null,
            accountPoolName: null,
          };
        }
        return base(path, method, body);
      },
    );
    const { client } = mount("/meetings");
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    const summary = screen.getByRole("complementary", { name: "预约摘要" });
    await screen.findByText("本人主持账号", { selector: ".booking-host-name" });
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    await user.click(screen.getByRole("checkbox", { name: "已同步成员" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    personalAvailable = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["booking-host"] });
    });
    expect(screen.queryByText("旧的账号池主持人", { selector: ".booking-host-name" })).toBeNull();
    await screen.findByText("当前受邀主持人", { selector: ".booking-host-name" });
    expect(hostRequests.map((body) => body.attendeeIds)).toEqual([
      [admin.id],
      [admin.id],
      [admin.id, 2],
    ]);
  });
  it("reuses a pending request that confirms a personal host after another attendee was selected", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    let resolvePersonal: (value: unknown) => void = () => {};
    let count = 0;
    vi.mocked(api.request).mockImplementation(async (path, method, body) => {
      if (path === "/booking/host-preview") {
        count++;
        return new Promise((resolve) => {
          resolvePersonal = resolve;
        });
      }
      return base(path, method, body);
    });
    mount("/meetings");
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    await waitFor(() => expect(count).toBe(1));
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    await user.click(screen.getByRole("checkbox", { name: "已同步成员" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    await act(async () => {
      resolvePersonal({
        available: true,
        allocationSource: "personal",
        hostAccountName: "已确认本人账号",
        hostAccountId: "personal-host",
        accountPoolId: null,
        accountPoolName: null,
      });
    });
    await screen.findByText("已确认本人账号", {
      selector: ".booking-host-name",
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(count).toBe(1);
  });
  it("a slow earlier host preview cannot replace the account for newly selected times", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    let resolveOld: (value: unknown) => void = () => {};
    let count = 0;
    vi.mocked(api.request).mockImplementation(async (path, method, body) => {
      if (path === "/booking/host-preview") {
        if (++count === 1)
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        return {
          available: true,
          allocationSource: "personal",
          hostAccountName: "当前本人账号",
          hostAccountId: "current-host",
          accountPoolName: null,
        };
      }
      return base(path, method, body);
    });
    mount("/meetings");
    await screen.findByLabelText("开始时间");
    const summary = screen.getByRole("complementary", { name: "预约摘要" });
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2030-10-14T11:00" },
    });
    await waitFor(() => expect(count).toBe(1));
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2030-10-14T12:00" },
    });
    await screen.findByText("当前本人账号", { selector: ".booking-host-name" });
    resolveOld({
      available: true,
      allocationSource: "pool",
      hostAccountName: "旧的账号",
      hostAccountId: "stale-host",
      accountPoolName: "旧账号池",
    });
    await waitFor(() =>
      expect(screen.queryByText("旧的账号", { selector: ".booking-host-name" })).toBeNull(),
    );
    expect(screen.getByText("本人", { selector: ".booking-host-source" })).not.toBeNull();
  });
  it("host preview reports no idle account and permits recovery after a request fails", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    let fail = true;
    vi.mocked(api.request).mockImplementation(async (path, method, body) => {
      if (path === "/booking/host-preview") {
        if (fail) throw new Error("network");
        return { available: false, reason: "该时段没有空闲高级账号" };
      }
      return base(path, method, body);
    });
    mount("/meetings");
    const user = userEvent.setup();
    await screen.findByLabelText("开始时间");
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2030-10-14T11:00" },
    });
    const summary = screen.getByRole("complementary", { name: "预约摘要" });
    await screen.findByText("暂时无法获取发起账号");
    fail = false;
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("该时段没有空闲高级账号");
  });
  it.each([
    ["/dashboard", ".dashboard-quick-panel"],
    ["/calendar", ".calendar-toolbar-actions"],
    ["/calendar?tab=list", ".calendar-toolbar-actions"],
    ["/calendar?create=1", null],
  ] as const)(
    "uses the shared meeting booking form from %s",
    async (path, selector) => {
      mount(path);
      const user = userEvent.setup();
      if (selector) {
        await waitFor(() =>
          expect(document.querySelector(selector)).not.toBeNull(),
        );
        const entry = within(document.querySelector(selector) as HTMLElement);
        expect(entry.queryByText("创建个人日程")).toBeNull();
        if (path === "/dashboard")
          expect(
            entry.getByRole("link", { name: "我的日程" }).getAttribute("href"),
          ).toBe("/calendar");
        await user.click(entry.getByRole("link", { name: "会议预约" }));
      }
      await user.type(await screen.findByLabelText("会议主题"), "客户回访");
      expect(document.querySelectorAll("form")).toHaveLength(1);
      expect(screen.queryByRole("dialog", { name: "新建日程" })).toBeNull();
      fireEvent.change(screen.getByLabelText("开始时间"), {
        target: { value: "2030-10-14T10:00" },
      });
      fireEvent.change(screen.getByLabelText("结束时间"), {
        target: { value: "2030-10-14T11:00" },
      });
      await user.click(screen.getByText("更多", { selector: "span" }));
      await user.type(
        screen.getByLabelText("外部邀请邮箱"),
        "person@example.com",
      );
      await user.click(screen.getByRole("button", { name: "提交预约" }));
      await waitFor(() =>
        expect(api.createMeeting).toHaveBeenCalledWith(
          expect.objectContaining({
            subject: "客户回访",
            attendeeIds: [admin.id],
            attendeeEmails: ["person@example.com"],
          }),
          "stable-test-idempotency-key",
        ),
      );
      expect(api.api.post).not.toHaveBeenCalled();
      const detail = await screen.findByRole("dialog", { name: "客户回访" });
      expect(within(detail).getByText("预约中 · 腾讯会议")).not.toBeNull();
    },
  );
  it("redirects old create links without loading the historical calendar", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation((path, ...args) => {
      if (["/calendar-events", "/meetings"].includes(path.split("?")[0]!))
        return new Promise(() => {});
      return base(path, ...args);
    });
    mount("/calendar?tab=list&create=1");
    expect(await screen.findByLabelText("会议主题")).not.toBeNull();
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(([p]) => String(p).split("?")[0] === "/calendar-events"),
    ).toBe(false);
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(([p]) => String(p).split("?")[0] === "/meetings"),
    ).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps historical calendar details and cancellation without a second form", async () => {
    events = [
      {
        id: 93,
        subject: "历史个人日程",
        status: "synced",
        startAt: "2030-10-15T02:00:00Z",
        endAt: "2030-10-15T03:00:00Z",
      },
    ];
    mount("/calendar?event=93&tab=list");
    const user = userEvent.setup();
    const detail = await screen.findByRole("dialog", { name: "历史个人日程" });
    expect(within(detail).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(document.querySelector("form")).toBeNull();
    await user.click(within(detail).getByRole("button", { name: "取消" }));
    const confirmation = await screen.findByRole("dialog", {
      name: "取消日程",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "确认" }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/calendar-events/93/cancel",
        "POST",
      ),
    );
    expect(api.createMeeting).not.toHaveBeenCalled();
  });
  it("configuration has no object storage and saves only changed file fields", async () => {
    mount("/settings?tab=branding");
    const user = userEvent.setup();
    expect(await screen.findByRole("tab", { name: "配置管理" })).not.toBeNull();
    expect(screen.queryByText(/OSS|COS/)).toBeNull();
    const name = await screen.findByLabelText("平台名称");
    await user.clear(name);
    await user.type(name, "我的协作平台");
    await user.click(screen.getByRole("button", { name: "保存配置变更" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/system/configuration",
        "PATCH",
        {
          revision: "a".repeat(64),
          values: { "platform.name": "我的协作平台" },
        },
      ),
    );
  });
  it("platform tests are disabled until draft credentials are saved", async () => {
    mount("/settings?tab=business");
    const user = userEvent.setup();
    const name = await screen.findByRole("heading", { name: "飞书" });
    const panel = name.closest("section")!;
    const button = within(panel).getByRole("button", { name: "测试连接" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    const id = within(panel).getByLabelText("App ID");
    await user.clear(id);
    await user.type(id, "new-application");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(panel).getByRole("button", { name: "保存连接" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/platform-connections/feishu-calendar",
        "PATCH",
        {
          appId: "new-application",
          appSecret: "********",
          calendarId: "calendar",
        },
      ),
    );
    expect(api.request).toHaveBeenCalledWith(
      "/platform-connections/feishu-directory",
      "PATCH",
      {
        appId: "new-application",
        appSecret: "********",
        rootDepartmentId: "0",
      },
    );
  });
  it("system administrators manage login identities and select Feishu users to authorize", async () => {
    mount("/system-users");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "账号权限" });
    await waitFor(() =>
      expect(
        screen.getAllByRole("img", { name: "测试管理员的头像" }),
      ).toHaveLength(2),
    );
    await user.click(screen.getByRole("button", { name: "手动添加" }));
    const dialog = screen.getByRole("dialog", { name: "手动添加用户" });
    await user.type(within(dialog).getByLabelText("登录账号"), "new-user");
    await user.type(within(dialog).getByLabelText("姓名"), "新用户");
    await user.type(
      within(dialog).getByLabelText("初始密码"),
      "LongPassword123",
    );
    await user.click(
      within(dialog).getByRole("combobox", { name: "系统身份" }),
    );
    await user.click(screen.getByRole("option", { name: "运营管理员" }));
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/system-users",
        "POST",
        expect.objectContaining({
          role: "operation_admin",
          systemAccess: "allowed",
          username: "new-user",
        }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "从飞书添加" }));
    const preview = await screen.findByRole("dialog", {
      name: "从飞书添加系统用户",
    });
    expect(
      within(preview)
        .getByRole("img", { name: "飞书张三的头像" })
        .getAttribute("src"),
    ).toBe("https://example.com/zhang-san.jpg");
    await user.click(
      within(preview).getByRole("checkbox", { name: "添加 飞书张三" }),
    );
    await user.click(
      within(preview).getByRole("button", { name: "添加 1 位用户" }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/system-users/feishu-import",
        "POST",
        { selectedIds: ["login-open"], role: "user" },
      ),
    );
  });
  it("organization selection survives hierarchy folding and submits the chosen departments", async () => {
    syncPreview = {
      fetchedAt: "2030-10-14T00:00:00Z",
      people: [],
      departments: [
        {
          open_department_id: "child",
          parent_department_id: "root",
          name: "研发中心",
        },
        {
          open_department_id: "root",
          parent_department_id: "0",
          name: "示例公司",
        },
      ],
    };
    mount("/sync");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: "选择 研发中心" }),
    );
    await user.click(screen.getByRole("button", { name: "全部收起" }));
    await user.click(screen.getByRole("tab", { name: "同步策略" }));
    await user.click(screen.getByRole("button", { name: "同步到腾讯会议" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/sync/organization",
        "POST",
        expect.objectContaining({
          selectedIds: ["child"],
          overwriteDepartments: false,
          fetchedAt: "2030-10-14T00:00:00Z",
        }),
      ),
    );
  });
  it("sync navigation has its own group and daily scheduling saves without resetting user rules", async () => {
    syncPolicy.overwriteUsers = true;
    syncPolicy.preserveExistingPermissions = false;
    mount("/sync?tab=policy");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "保存策略" });
    const group = screen.getByText("运营", {
      selector: ".nav-caption",
    }).parentElement!;
    expect(within(group).getByRole("link", { name: "组织同步" })).not.toBeNull();
    expect(within(group).getByRole("link", { name: "人员同步" })).not.toBeNull();
    expect(within(group).queryByRole("link", { name: "账号权限" })).toBeNull();
    expect(screen.queryByText("高级 / 普通许可保持原样")).toBeNull();
    await user.click(
      screen.getByRole("combobox", { name: "自动同步组织与用户" }),
    );
    await user.click(screen.getByRole("option", { name: "每天定时执行" }));
    await user.click(screen.getByRole("combobox", { name: "执行小时" }));
    await user.click(screen.getByRole("option", { name: "04 时" }));
    await user.click(screen.getByRole("combobox", { name: "执行分钟" }));
    await user.click(screen.getByRole("option", { name: "30 分" }));
    expect(screen.getByText("保存后更新")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "保存策略" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith("/sync/policy", "PATCH", {
        overwriteDepartments: false,
        automaticMode: "daily",
        intervalMinutes: 60,
        dailyTime: "04:30",
      }),
    );
    expect(syncPolicy.overwriteUsers).toBe(true);
    expect(syncPolicy.preserveExistingPermissions).toBe(false);
    await waitFor(() => expect(screen.queryByText("保存后更新")).toBeNull());
  });
  it("keeps Feishu as the fixed source and lets a registered directory target be selected", async () => {
    platformFixtures.push({
      id: "directory.example",
      providerId: "example",
      name: "示例同步目标",
      capability: "directory",
      connectionId: "example-directory",
      configured: true,
      syncFrom: ["feishu-directory"],
      capabilities: { read: true, import: true, write: true },
    } as any);
    try {
      mount("/sync");
      const user = userEvent.setup();
      expect(await screen.findByText("数据来源")).not.toBeNull();
      const target = await screen.findByRole("combobox", { name: "同步目标" });
      expect(target.textContent).toContain("腾讯会议");
      await user.click(target);
      await user.click(screen.getByRole("option", { name: "示例同步目标" }));
      await waitFor(() =>
        expect(api.request).toHaveBeenCalledWith("/sync/policy", "PATCH", {
          targetConnectionId: "example-directory",
        }),
      );
    } finally {
      platformFixtures.pop();
    }
  });
  it("sync policy validates interval and the old settings link opens the new policy page", async () => {
    mount("/settings?tab=sync");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "保存策略" });
    await user.click(
      screen.getByRole("combobox", { name: "自动同步组织与用户" }),
    );
    await user.click(screen.getByRole("option", { name: "按间隔执行" }));
    const interval = screen.getByRole("spinbutton", {
      name: "同步间隔（分钟）",
    });
    await user.clear(interval);
    await user.type(interval, "0");
    await user.click(screen.getByRole("button", { name: "保存策略" }));
    expect(screen.getByText("同步间隔应为 1–10080 分钟的整数")).not.toBeNull();
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(
          ([path, method]) => path === "/sync/policy" && method === "PATCH",
        ),
    ).toBe(false);
    await user.clear(interval);
    await user.type(interval, "90");
    await user.click(screen.getByRole("button", { name: "保存策略" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/sync/policy",
        "PATCH",
        expect.objectContaining({
          automaticMode: "interval",
          intervalMinutes: 90,
        }),
      ),
    );
  });
  it("user selection shows partial state and filtered deselection preserves hidden users", async () => {
    syncPreview = {
      fetchedAt: "2030-10-14T00:00:00Z",
      departments: [],
      people: [
        {
          open_id: "p1",
          name: "张三",
          department_ids: [],
          departmentNames: ["研发"],
        },
        {
          open_id: "p2",
          name: "李四",
          department_ids: [],
          departmentNames: ["运营"],
        },
        {
          open_id: "p3",
          name: "王五",
          department_ids: [],
          departmentNames: ["研发"],
        },
      ],
    };
    mount("/user-sync");
    const user = userEvent.setup();
    const selectAll = (await screen.findByRole("checkbox", {
      name: "选择当前页",
    })) as HTMLInputElement;
    await user.click(screen.getByRole("checkbox", { name: "选择 张三" }));
    expect(selectAll.indeterminate).toBe(true);
    const search = screen.getByRole("textbox", {
      name: "搜索姓名、手机号或部门",
    });
    await user.type(search, "运营");
    expect(selectAll.indeterminate).toBe(false);
    expect(selectAll.checked).toBe(false);
    await user.click(selectAll);
    expect(
      (screen.getByRole("checkbox", { name: "选择 李四" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await user.click(selectAll);
    await user.clear(search);
    expect(
      (screen.getByRole("checkbox", { name: "选择 张三" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: "选择 李四" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
    await user.type(search, "不存在");
    expect(
      screen.queryByRole("checkbox", { name: "选择当前页" }),
    ).toBeNull();
  });
  it("user synchronization previews records and preserves existing licenses by default", async () => {
    mount("/user-sync");
    const user = userEvent.setup();
    await screen.findByRole("tab", { name: "飞书用户" });
    expect(screen.queryByRole("heading", { name: "用户同步" })).toBeNull();
    await user.click(
      await screen.findByRole("button", { name: "从飞书读取用户" }),
    );
    await screen.findByText("飞书张三");
    expect(
      screen.getByRole("img", { name: "飞书张三的头像" }).getAttribute("src"),
    ).toBe("https://example.com/zhang-san.jpg");
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择 飞书张三",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await user.click(screen.getByRole("tab", { name: "同步策略" }));
    expect(
      screen
        .getByRole("tab", { name: "同步策略" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "保留腾讯会议已有用户权限" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "同步到腾讯会议" }));
    const confirmation = await screen.findByRole("dialog");
    expect(
      within(confirmation).getByText(/把已有账号移动到飞书对应部门/),
    ).not.toBeNull();
    await user.click(
      within(confirmation).getByRole("button", { name: "确认" }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/sync/users",
        "POST",
        expect.objectContaining({
          selectedIds: ["open-2"],
          preserveExistingPermissions: true,
          overwriteUsers: false,
        }),
      ),
    );
  });
  it("long data tables paginate and let users change the page size", async () => {
    const rows = Array.from({ length: 23 }, (_, id) => ({
      id,
      name: `账号 ${id + 1}`,
    }));
    render(
      <DataTable
        rows={rows}
        columns={[{ key: "name", title: "账号", render: (row) => row.name }]}
      />,
    );
    expect(screen.getByText("账号 1")).not.toBeNull();
    expect(screen.queryByText("账号 11")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("账号 11")).not.toBeNull();
    await user.click(screen.getByRole("combobox", { name: "每页条数" }));
    await user.click(screen.getByRole("option", { name: "20 条" }));
    expect(screen.getByText("账号 20")).not.toBeNull();
    expect(screen.queryByText("账号 21")).toBeNull();
  });
  it("logs initially load only metadata; selecting a file reads the body and does not submit configuration", async () => {
    mount("/settings?tab=logs");
    const user = userEvent.setup();
    await screen.findByText("server.log");
    expect(api.api.get).not.toHaveBeenCalled();
    expect(screen.getByText("选择一个日志文件查看内容")).not.toBeNull();
    await user.click(screen.getByText("server.log"));
    await screen.findByText("测试日志");
    expect(api.api.get).toHaveBeenCalledWith(
      "/system/logs/server.log?lines=200",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(api.api.get).toHaveBeenCalledTimes(2));
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(
          ([path, method]) =>
            path === "/system/configuration" && method === "PATCH",
        ),
    ).toBe(false);
  });
  it("invalid values in a hidden configuration group are revealed before saving", async () => {
    mount("/settings?tab=configuration");
    const user = userEvent.setup();
    const port = await screen.findByLabelText("API 端口");
    fireEvent.change(port, { target: { value: "65536" } });
    await user.click(screen.getByRole("tab", { name: "品牌外观" }));
    await user.click(screen.getByRole("button", { name: "保存配置变更" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "端口应为",
    );
    expect(screen.getByLabelText("API 端口")).not.toBeNull();
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(
          ([path, method]) =>
            path === "/system/configuration" && method === "PATCH",
        ),
    ).toBe(false);
  });
  it("statistics cards filter matching jobs and stay in the system navigation group", async () => {
    mount("/audit-logs");
    const user = userEvent.setup();
    await screen.findByText("创建会议成功");
    await user.click(screen.getByText("取消会议成功"));
    await waitFor(() =>
      expect(
        vi
          .mocked(api.request)
          .mock.calls.some(
            ([path]) =>
              path.startsWith("/records/jobs?") &&
              path.includes("type=meeting.cancel"),
          ),
      ).toBe(true),
    );
    const link = screen.getByRole("link", { name: "日志统计" });
    expect(link.closest("section")?.textContent).toContain("系统设置");
    expect(screen.getByRole("tab", { name: "统计" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "日志文件" })).not.toBeNull();
  });
  it("operators can download logs without destructive or system configuration controls", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "operation_admin" });
    mount("/audit-logs?tab=logs");
    const user = userEvent.setup();
    await user.click(await screen.findByText("server.log"));
    await screen.findByText("测试日志");
    expect(screen.getByRole("link", { name: "下载日志" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "清空日志" })).toBeNull();
    expect(screen.queryByRole("link", { name: "系统设置" })).toBeNull();
  });
  it("switching log files discards late responses from a previous file", async () => {
    let finish: (value: any) => void = () => {};
    vi.mocked(api.api.get).mockImplementation(async (path) =>
      path.includes("server.log")
        ? await new Promise((resolve) => {
            finish = resolve;
          })
        : ({ data: { text: "新的日志内容" } } as any),
    );
    mount("/audit-logs?tab=logs");
    const user = userEvent.setup();
    await user.click(await screen.findByText("server.log"));
    await user.click(screen.getByText("web.log.1"));
    await screen.findByText("新的日志内容");
    await act(async () => {
      finish({ data: { text: "过期内容" } });
    });
    expect(screen.queryByText("过期内容")).toBeNull();
  });
  it("log auto refresh is opt in, serial, and stops when changing tabs", async () => {
    mount("/audit-logs?tab=logs");
    const user = userEvent.setup();
    await user.click(await screen.findByText("server.log"));
    await screen.findByText("测试日志");
    const callbacks: (() => void)[] = [];
    const original = setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay: number,
      ...args: any[]
    ) => {
      if (delay === 5000) {
        callbacks.push(callback);
        return 0 as any;
      }
      return original(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      await user.click(screen.getByLabelText("自动刷新"));
      await user.click(screen.getByRole("option", { name: "每 5 秒刷新" }));
      await waitFor(() => expect(callbacks.length).toBe(1));
      const baseline = vi.mocked(api.api.get).mock.calls.length;
      await act(async () => {
        callbacks.shift()!();
      });
      await waitFor(() =>
        expect(vi.mocked(api.api.get).mock.calls.length).toBe(baseline + 1),
      );
      await user.click(screen.getByRole("tab", { name: "统计" }));
      const stopped = vi.mocked(api.api.get).mock.calls.length;
      await act(async () => {
        callbacks.shift()?.();
      });
      expect(vi.mocked(api.api.get).mock.calls.length).toBe(stopped);
    } finally {
      timer.mockRestore();
    }
  });
  it("operators cannot enter system user administration", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "operation_admin" });
    mount("/system-users");
    await screen.findByRole("heading", { name: /测试管理员/ });
    expect(api.request).not.toHaveBeenCalledWith("/system-users");
  });
  it("Tencent advanced accounts can be fetched and selected into a pool without Feishu matching", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation(async (path, method, body) => {
      if (path === "/account-pools")
        return [{ id: 7, name: "共享主持账号池", members: [], enabled: true }];
      if (path === "/meeting-accounts") return [];
      if (path === "/meeting-accounts/platform/tencent-meeting")
        return {
          accounts: [
            {
              accountId: "tencent-only",
              name: "腾讯独立账号",
              departmentNames: ["会议服务"],
              platformStatus: "1",
              canImport: true,
              localId: null,
              localStatus: null,
            },
            {
              accountId: "existing",
              name: "已添加账号",
              departmentNames: [],
              platformStatus: "1",
              canImport: true,
              localId: 1,
              localStatus: "disabled",
            },
            {
              accountId: "remote-disabled",
              name: "腾讯已禁用账号",
              departmentNames: [],
              platformStatus: "4",
              canImport: false,
              localId: null,
              localStatus: null,
            },
          ],
        };
      if (path === "/meeting-accounts/platform/tencent-meeting/import")
        return { created: 1, existing: 0, poolAdded: 1 };
      return base(path, method, body);
    });
    mount("/account-pools");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "高级账号" });
    await user.click(
      screen.getAllByRole("button", { name: "从会议平台获取" })[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("腾讯独立账号");
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "选择平台账号 腾讯已禁用账号",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(within(dialog).getByText("本地已停用")).not.toBeNull();
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "选择平台账号 腾讯独立账号",
      }),
    );
    await user.click(
      within(dialog).getByRole("combobox", { name: "加入账号池" }),
    );
    await user.click(screen.getByRole("option", { name: "共享主持账号池" }));
    await user.click(
      within(dialog).getByRole("button", { name: "添加所选账号" }),
    );
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/meeting-accounts/platform/tencent-meeting/import",
        "POST",
        { accountIds: ["tencent-only"], poolId: 7 },
      ),
    );
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(([path]) => path.startsWith("/sync/")),
    ).toBe(false);
  });
  it("Tencent account fetch errors stay retryable and cannot submit an empty selection", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation(async (path, method, body) => {
      if (path === "/meeting-accounts/platform/tencent-meeting")
        throw new Error("腾讯会议凭据未配置");
      return base(path, method, body);
    });
    mount("/account-pools");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "高级账号" });
    await user.click(
      screen.getAllByRole("button", { name: "从会议平台获取" })[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("alert");
    expect(
      (
        within(dialog).getByRole("button", {
          name: "添加所选账号",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(dialog).getByRole("button", { name: "重试" })).not.toBeNull();
  });
  it("template variables insert at the cursor, support Tencent paths, and return keyboard focus", async () => {
    mount("/calendar-templates?edit=new");
    const user = userEvent.setup();
    const title = (await screen.findByLabelText(
      "日程标题",
    )) as HTMLInputElement;
    await user.clear(title);
    await user.type(title, "前后");
    title.setSelectionRange(1, 1);
    await user.click(screen.getByRole("button", { name: "插入日程标题变量" }));
    await user.type(
      screen.getByRole("textbox", { name: "搜索变量" }),
      "会议号",
    );
    expect(
      screen.queryByRole("button", { name: /会议主题 产品周会/ }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "会议号 123 456 789" }),
    );
    await waitFor(() => expect(title.value).toBe("前【会议号】后"));
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(title.selectionStart).toBe("前【会议号】".length);
    await user.click(screen.getByRole("button", { name: "插入日程说明变量" }));
    await user.click(screen.getByRole("tab", { name: "平台专有" }));
    await user.type(
      screen.getByRole("textbox", { name: "搜索变量" }),
      "join_url",
    );
    await user.click(
      screen.getByRole("button", { name: "腾讯入会链接 join_url" }),
    );
    const description = screen.getByLabelText(
      "日程说明",
    ) as HTMLTextAreaElement;
    expect(description.value).toContain("【平台字段：tencent/join_url】");
    await user.click(screen.getByRole("button", { name: "插入日程说明变量" }));
    await user.click(screen.getByRole("tab", { name: "自定义字段" }));
    const path = screen.getByRole("textbox", {
      name: "平台返回字段路径（日程说明）",
    });
    await user.type(path, "settings.new_field");
    await user.keyboard("{Enter}");
    expect(description.value).toContain("【平台字段：tencent/settings.new_field】");
    expect(api.request).not.toHaveBeenCalledWith(
      "/calendar-templates",
      "POST",
      expect.anything(),
    );
    const trigger = screen.getByRole("button", { name: "插入日程标题变量" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("template drafts survive tab changes and invalid hidden fields bring back the correct tab", async () => {
    mount("/calendar-templates?edit=new");
    const user = userEvent.setup();
    const name = await screen.findByLabelText("模板名称");
    await user.clear(name);
    await user.type(name, "项目沟通");
    await user.clear(screen.getByLabelText("日程标题"));
    await user.click(screen.getByRole("tab", { name: "提醒与设置" }));
    await user.click(screen.getByRole("switch", { name: "启用此模板" }));
    await user.click(screen.getByRole("switch", { name: "设为预约默认模板" }));
    expect(
      screen
        .getByRole("switch", { name: "启用此模板" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "日程内容" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect((screen.getByLabelText("模板名称") as HTMLInputElement).value).toBe(
      "项目沟通",
    );
    expect(await screen.findByRole("alert")).not.toBeNull();
    await user.type(screen.getByLabelText("日程标题"), "项目：【会议主题】");
    await user.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/calendar-templates",
        "POST",
        expect.objectContaining({
          name: "项目沟通",
          titleTemplate: "项目：{subject}",
          enabled: true,
          isDefault: true,
        }),
      ),
    );
  });
  it("templates paginate and filter, and copying never carries the default flag", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    const templates = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      name: `模板 ${i + 1}`,
      titleTemplate: "{subject}",
      descriptionTemplate: "会议号：{meetingCode}",
      locationTemplate: "线上会议",
      remindersJson: "[10]",
      extensionsJson: "{}",
      enabled: i < 11,
      isDefault: i === 0,
    }));
    vi.mocked(api.request).mockImplementation(async (path, method, body) =>
      path === "/calendar-templates" && (!method || method === "GET")
        ? templates
        : base(path, method, body),
    );
    mount("/calendar-templates");
    const user = userEvent.setup();
    await screen.findByText("模板 1", { exact: true });
    expect(screen.queryByText("模板 12", { exact: true })).toBeNull();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("模板 12", { exact: true })).not.toBeNull();
    expect(screen.queryByRole("tab", { name: "已启用" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "已停用" })).toBeNull();
    const statusFilter = screen.getByRole("combobox", { name: "筛选模板状态" });
    expect(
      within(
        screen.getByRole("group", { name: "日程模板筛选与操作" }),
      ).getByRole("combobox", { name: "筛选模板状态" }),
    ).toBe(statusFilter);
    await user.click(statusFilter);
    await user.click(screen.getByRole("option", { name: "已停用" }));
    expect(screen.getByText("模板 12", { exact: true })).not.toBeNull();
    expect(screen.queryByText("模板 11", { exact: true })).toBeNull();
    await user.click(statusFilter);
    await user.click(screen.getByRole("option", { name: "已启用" }));
    expect(screen.getByText("模板 1", { exact: true })).not.toBeNull();
    expect(screen.queryByText("模板 12", { exact: true })).toBeNull();
    await user.click(statusFilter);
    await user.click(screen.getByRole("option", { name: "全部状态" }));
    await user.type(
      screen.getByRole("textbox", { name: "搜索模板名称或内容" }),
      "模板 1",
    );
    expect(screen.queryByText("模板 2", { exact: true })).toBeNull();
    await user.click(screen.getByRole("button", { name: "复制 模板 1" }));
    expect((screen.getByLabelText("模板名称") as HTMLInputElement).value).toBe(
      "模板 1（副本）",
    );
    await user.click(screen.getByRole("tab", { name: "提醒与设置" }));
    expect(
      screen
        .getByRole("switch", { name: "设为预约默认模板" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await user.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/calendar-templates",
        "POST",
        expect.objectContaining({ name: "模板 1（副本）", isDefault: false }),
      ),
    );
  });
  it("invalid supplemental fields reveal their tab and collapsed section", async () => {
    mount("/calendar-templates?edit=new");
    const user = userEvent.setup();
    await screen.findByRole("tab", { name: "提醒与设置" });
    await user.click(screen.getByRole("tab", { name: "提醒与设置" }));
    const summary = screen.getByText("补充信息", { selector: "summary" });
    await user.click(summary);
    await user.click(screen.getByRole("button", { name: "添加补充信息" }));
    await user.type(screen.getByLabelText("补充信息内容 1"), "项目资料");
    await user.click(summary);
    await user.click(screen.getByRole("tab", { name: "日程内容" }));
    await user.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "提醒与设置" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(summary.closest("details")?.open).toBe(true);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("补充信息名称 1"),
      ),
    );
  });
  it("template edit URLs restore existing data and save through PATCH", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation(async (path, method, body) =>
      path === "/calendar-templates"
        ? [
            {
              id: 7,
              name: "客户评审",
              titleTemplate: "评审：{subject}",
              descriptionTemplate: "会议号：{meetingCode}",
              locationTemplate: "线上",
              remindersJson: "[30]",
              extensionsJson: '{"项目":"产品"}',
              enabled: true,
              isDefault: false,
            },
          ]
        : base(path, method, body),
    );
    mount("/calendar-templates?edit=7&tab=settings");
    const user = userEvent.setup();
    await screen.findByRole("switch", { name: "启用此模板" });
    await user.click(screen.getByRole("tab", { name: "日程内容" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("模板名称") as HTMLInputElement).value,
      ).toBe("客户评审"),
    );
    expect(
      (screen.getByLabelText("日程说明") as HTMLTextAreaElement).value,
    ).toBe("会议号：【会议号】");
    await user.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/calendar-templates/7",
        "PATCH",
        expect.objectContaining({
          name: "客户评审",
          reminders: [30],
          extensions: { 项目: "产品" },
        }),
      ),
    );
  });
  it("calendar templates use readable fields, preview and key-value inputs rather than JSON", async () => {
    mount("/calendar-templates");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "日程模板" });
    await user.click(screen.getByRole("button", { name: "创建模板" }));
    await screen.findByRole("heading", { name: "创建日程模板" });
    expect((screen.getByLabelText("日程标题") as HTMLInputElement).value).toBe(
      "【会议主题】",
    );
    expect(screen.getByRole("heading", { name: "产品周会" })).not.toBeNull();
    expect(screen.queryByLabelText("扩展信息 JSON")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "提醒与设置" }));
    await user.click(screen.getByText("补充信息", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: "添加补充信息" }));
    await user.type(screen.getByLabelText("补充信息名称 1"), "项目");
    await user.type(screen.getByLabelText("补充信息内容 1"), "研发");
    await user.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/calendar-templates",
        "POST",
        expect.objectContaining({
          titleTemplate: "{subject}",
          descriptionTemplate:
            "{description}\n\n会议号：{meetingCode}\n加入会议：\n{meetingUrl}",
          reminders: [10],
          extensions: { 项目: "研发" },
        }),
      ),
    );
  });
  it("shows an actionable loading error instead of a blank page", async () => {
    vi.mocked(api.getSummary).mockRejectedValueOnce(new Error("network"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "数据加载失败",
    );
    expect(screen.getByRole("button", { name: "重试" })).not.toBeNull();
  });
  it("operators can read records but cannot delete, clear or retry them", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "operation_admin" });
    recordItems = [
      {
        id: 12,
        type: "sync",
        status: "failed",
        attempts: 5,
        updatedAt: "2030-10-15T00:00:00Z",
      },
    ];
    mount("/audit-logs?tab=jobs");
    await screen.findByText("#12");
    expect(screen.getByRole("tab", { name: "日志文件" })).not.toBeNull();
    for (const name of ["删除", "清理记录", "重试"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "详情" })).not.toBeNull();
  });
  it("ordinary users cannot open the management record viewer", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "user" });
    mount("/audit-logs");
    await screen.findByText("欢迎回到工作台，安排好下一次高效协作。");
    expect(screen.queryByRole("link", { name: "日志与记录" })).toBeNull();
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(([path]) => path.startsWith("/records/")),
    ).toBe(false);
  });
  it("system administrators clear only the reviewed record range", async () => {
    recordItems = [
      {
        id: 12,
        type: "sync",
        status: "failed",
        attempts: 5,
        updatedAt: "2030-10-15T00:00:00Z",
      },
      { id: 13, type: "sync", status: "running", attempts: 1 },
    ];
    mount("/audit-logs?tab=jobs");
    const user = userEvent.setup();
    await screen.findByText("#12");
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "清理记录" }));
    await user.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/records/jobs/clear",
        "POST",
        expect.objectContaining({
          throughId: 120,
          filters: expect.objectContaining({
            from: expect.any(String),
            to: expect.any(String),
          }),
        }),
      ),
    );
  });
  it("administrators can find and delete cancelled schedules", async () => {
    meetings = [
      {
        id: 31,
        subject: "已取消会议",
        status: "cancelled",
        createdBy: 99,
        startAt: "2030-10-15T00:00:00Z",
        endAt: "2030-10-15T01:00:00Z",
      },
    ];
    mount("/calendar?tab=list");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /筛选/ }));
    await screen.findByLabelText("日程状态");
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    await user.click(screen.getByLabelText("日程状态"));
    await user.click(screen.getByRole("option", { name: "已取消" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    await user.click(await screen.findByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith("/meetings/31", "DELETE"),
    );
  });
  it("ordinary users see cancelled meetings without a delete action", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "user" });
    meetings = [
      {
        id: 31,
        subject: "已取消会议",
        status: "cancelled",
        createdBy: admin.id,
        startAt: "2030-10-15T00:00:00Z",
        endAt: "2030-10-15T01:00:00Z",
      },
    ];
    mount("/calendar?tab=list");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /筛选/ }));
    await user.click(await screen.findByLabelText("日程状态"));
    await user.click(screen.getByRole("option", { name: "已取消" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(
      await screen.findByRole("button", { name: "已取消会议" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });
});

describe("local meeting completion", () => {
  const scheduled = () => ({
    id: 31,
    subject: "提前结束测试",
    status: "scheduled",
    createdBy: admin.id,
    startAt: "2035-10-15T00:00:00Z",
    endAt: "2035-10-15T01:00:00Z",
    externalMeetingId: "remote-31",
    calendarEventId: "event-31",
    calendarDescription: "保留原预约说明",
    meetingUrl: "https://meeting.tencent.com/original",
  });
  function mockFinish(fail = false) {
    const original = vi.mocked(api.request).getMockImplementation()!;
    vi.mocked(api.request).mockImplementation(async (path, method, body) => {
      if (path === "/meetings/31/finish" && method === "POST") {
        if (fail) throw new Error("会议任务尚未结束，请稍后结束会议");
        meetings = meetings.map((meeting) => ({
          ...meeting,
          status: "finished",
        }));
        return { ok: true };
      }
      return original(path, method, body);
    });
  }
  it("lets the creator finish from schedule details and keeps both platform reservations visible", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "user" });
    meetings = [scheduled()];
    mockFinish();
    const user = userEvent.setup();
    mount("/calendar?meeting=31");
    const detail = await screen.findByRole("dialog", { name: "提前结束测试" });
    await user.click(within(detail).getByRole("button", { name: "结束会议" }));
    const confirmation = await screen.findByRole("dialog", {
      name: "结束会议",
    });
    expect(
      within(confirmation).getByText(/平台会议及关联日程的原预约保持不变/),
    ).not.toBeNull();
    expect(api.request).not.toHaveBeenCalledWith("/meetings/31/finish", "POST");
    await user.click(
      within(confirmation).getByRole("button", { name: "取消" }),
    );
    expect(api.request).not.toHaveBeenCalledWith("/meetings/31/finish", "POST");
    await user.click(within(detail).getByRole("button", { name: "结束会议" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "结束会议" })).getByRole(
        "button",
        { name: "确认" },
      ),
    );
    await within(detail).findByText("已结束 · 本系统");
    expect(within(detail).getByText("已预约 · 腾讯会议")).not.toBeNull();
    expect(within(detail).getByText("已预约 · 飞书日程")).not.toBeNull();
    expect(within(detail).getByText("保留原预约说明")).not.toBeNull();
    expect(
      within(detail).queryByRole("button", { name: "结束会议" }),
    ).toBeNull();
    expect(
      within(detail)
        .getByRole("link", { name: "进入会议" })
        .getAttribute("href"),
    ).toBe(scheduled().meetingUrl);
    expect(
      vi
        .mocked(api.request)
        .mock.calls.filter(([, method]) => method === "POST"),
    ).toEqual([["/meetings/31/finish", "POST"]]);
    expect(toast.success).toHaveBeenCalledWith("会议已结束，高级账号已释放");
  });
  it.each([".dashboard-meeting-table", ".dashboard-meeting-list"])(
    "finishes a meeting from the home page in %s and refreshes upcoming meetings",
    async (selector) => {
      meetings = [scheduled()];
      mockFinish();
      vi.mocked(api.getSummary).mockImplementation(async () => ({
        meetings: 1,
        upcoming: meetings.filter((meeting) => meeting.status === "scheduled"),
      }));
      const user = userEvent.setup();
      const view = mount("/dashboard");
      await screen.findAllByText("提前结束测试");
      const surface = view.container.querySelector(selector) as HTMLElement;
      await user.click(
        within(surface).getByRole("button", {
          name: selector.includes("list") ? "结束" : "结束会议",
        }),
      );
      await user.click(
        within(
          await screen.findByRole("dialog", { name: "结束会议" }),
        ).getByRole("button", { name: "确认" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "结束会议" })).toBeNull(),
      );
      expect(screen.queryByText("提前结束测试")).toBeNull();
      expect(api.request).toHaveBeenCalledWith("/meetings/31/finish", "POST");
      expect(api.getSummary).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    ["user", admin.id, "scheduled", true],
    ["user", 99, "scheduled", false],
    ["operation_admin", 99, "scheduled", true],
    ["system_admin", 99, "scheduled", true],
    ["system_admin", 99, "provisioning", false],
    ["system_admin", 99, "unknown", false],
    ["system_admin", 99, "cancel_failed", false],
    ["system_admin", 99, "finished", false],
  ] as const)(
    "restricts finishing for %s / owner %s / %s",
    async (role, createdBy, status, allowed) => {
      vi.mocked(api.me).mockResolvedValue({ ...admin, role });
      meetings = [{ ...scheduled(), createdBy, status }];
      mount("/calendar?meeting=31");
      const detail = await screen.findByRole("dialog", {
        name: "提前结束测试",
      });
      expect(!!within(detail).queryByRole("button", { name: "结束会议" })).toBe(
        allowed,
      );
    },
  );
  it("keeps the confirmation open when finishing fails", async () => {
    meetings = [scheduled()];
    mockFinish(true);
    const user = userEvent.setup();
    mount("/calendar?meeting=31");
    const detail = await screen.findByRole("dialog", { name: "提前结束测试" });
    await user.click(within(detail).getByRole("button", { name: "结束会议" }));
    const confirmation = await screen.findByRole("dialog", {
      name: "结束会议",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "确认" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "会议任务尚未结束，请稍后结束会议",
      ),
    );
    expect(screen.getByRole("dialog", { name: "结束会议" })).not.toBeNull();
    expect(meetings[0].status).toBe("scheduled");
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("cloud recording controls", () => {
  const row = () => ({
    meeting: {
      id: 72,
      subject: "产品评审录制",
      startAt: "2020-01-01T09:00:00.000Z",
      endAt: "2020-01-01T10:00:00.000Z",
      status: "finished",
      recordingEnabled: true,
      calendarDescription: "产品评审会议邀请",
    },
    recording: {
      id: 87,
      status: "ready",
      canDelete: true,
      expiresAt: "2035-01-01T00:00:00.000Z",
      error: null,
      files: [
        {
          id: "video-1",
          viewUrl: "https://meeting.tencent.com/crm/example",
          downloadable: false,
          extension: "mp4",
        },
      ],
    },
  });
  it("opens cloud playback without requiring downloads, copies its URL and confirms remote deletion", async () => {
    recordingRows = [row()];
    meetings = [row().meeting];
    const user = userEvent.setup();
    mount("/calendar?tab=list&meeting=72");
    const cloud = await screen.findByRole("button", { name: "云录制" });
    await waitFor(() => expect((cloud as HTMLButtonElement).disabled).toBe(false));
    await user.click(cloud);
    const playback = await screen.findByRole("link", { name: "播放" });
    expect(playback.getAttribute("href")).toBe(
      "https://meeting.tencent.com/crm/example",
    );
    expect(playback.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("button", { name: "下载录制" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "复制播放地址" }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://meeting.tencent.com/crm/example",
    );
    await user.click(screen.getByRole("button", { name: "删除录制" }));
    const dialog = await screen.findByRole("dialog", {
      name: "删除平台云录制",
    });
    expect(within(dialog).getByText(/播放和下载地址也会失效/)).toBeTruthy();
    expect(api.request).not.toHaveBeenCalledWith("/recordings/87", "DELETE");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith("/recordings/87", "DELETE"),
    );
  });
  it("operators can sync but cannot delete, and deleted files have no playback links", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "operation_admin" });
    recordingRows = [
      row(),
      {
        ...row(),
        recording: {
          ...row().recording,
          id: 88,
          status: "deleted",
          canDelete: false,
          files: [{ id: "gone", downloadable: false }],
        },
      },
    ];
    meetings = [row().meeting];
    const user = userEvent.setup();
    mount("/calendar?tab=list&meeting=72");
    const cloud = await screen.findByRole("button", { name: "云录制" });
    await waitFor(() => expect((cloud as HTMLButtonElement).disabled).toBe(false));
    await user.click(cloud);
    await screen.findByRole("link", { name: "播放" });
    expect(screen.queryByRole("button", { name: "删除录制" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "播放" })).toHaveLength(1);
    expect(screen.getByText("已删除")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "同步录制" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith("/recordings/87/retry", "POST"),
    );
  });
  it("shows only the selected schedule's recordings and keeps navigation to three entries", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...admin, role: "user" });
    meetings = [row().meeting];
    recordingRows = [
      row(),
      {
        ...row(),
        meeting: { ...row().meeting, id: 99 },
        recording: {
          ...row().recording,
          id: 99,
          files: [
            {
              id: "private-file",
              viewUrl: "https://meeting.tencent.com/private",
              downloadable: false,
            },
          ],
        },
      },
    ];
    const user = userEvent.setup();
    mount("/calendar?tab=list");
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    for (const label of ["首页概览", "会议管理", "日程管理"])
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "会议录制" })).toBeNull();
    expect(api.request).not.toHaveBeenCalledWith("/meetings/72/recordings");
    await user.click(
      await screen.findByRole("button", { name: "产品评审录制" }),
    );
    const cloud = await screen.findByRole("button", { name: "云录制" });
    await waitFor(() => expect((cloud as HTMLButtonElement).disabled).toBe(false));
    await user.click(cloud);
    const recordings = await screen.findByRole("region", { name: "云录制" });
    await within(recordings).findByRole("link", { name: "播放" });
    expect(within(recordings).getAllByRole("link")).toHaveLength(1);
    expect(
      within(recordings).queryByRole("button", { name: "同步录制" }),
    ).toBeNull();
    expect(
      within(recordings).queryByRole("button", { name: "删除录制" }),
    ).toBeNull();
    expect(api.request).not.toHaveBeenCalledWith("/recordings");
  });
  it("loads no recordings for personal events and redirects the old recording entry to schedules", async () => {
    events = [
      { ...row().meeting, id: 12, subject: "个人日程", status: "synced" },
    ];
    const user = userEvent.setup();
    mount("/recordings");
    await user.click(await screen.findByRole("button", { name: "个人日程" }));
    await screen.findByRole("button", { name: "复制说明" });
    expect(screen.queryByRole("region", { name: "云录制" })).toBeNull();
    expect(
      vi
        .mocked(api.request)
        .mock.calls.some(([path]) => path.endsWith("/recordings")),
    ).toBe(false);
  });
});

describe("explicit booking host selection", () => {
  const candidates = [
    {
      id: 1,
      displayName: admin.displayName,
      externalId: "my-host",
      canHost: true,
    },
    { id: 2, displayName: "高级甲", externalId: "host-a", canHost: true },
    { id: 4, displayName: "高级乙", externalId: "host-b", canHost: true },
    { id: 5, displayName: "高级丙", externalId: "host-c", canHost: true },
    {
      id: 6,
      displayName: "普通参会人",
      externalId: "ordinary",
      canHost: false,
    },
    {
      id: 7,
      displayName: "未邀请高级用户",
      externalId: "not-invited",
      canHost: true,
    },
  ];
  function setup() {
    const base = vi.mocked(api.request).getMockImplementation()!;
    const calls: any[] = [];
    vi.mocked(api.request).mockImplementation(
      async (path, method, body: any) => {
        if (path.startsWith("/directory/people")) return candidates;
        if (path === "/account-pools")
          return [
            { id: 7, name: "默认池", enabled: true, isDefault: true },
            { id: 8, name: "培训池", enabled: true },
          ];
        if (path === "/booking/host-preview") {
          calls.push(body);
          const person =
            candidates.find((p) => p.id === body.hostUserId) || candidates[0]!;
          return {
            available: true,
            allocationSource:
              body.hostMode === "pool"
                ? "pool"
                : person.id === 1
                  ? "personal"
                  : "invitee",
            hostAccountId:
              body.hostMode === "pool" ? "pool-host" : person.externalId,
            hostAccountName:
              body.hostMode === "pool" ? "池内空闲主持人" : person.displayName,
            accountPoolId:
              body.hostMode === "pool" ? body.accountPoolId || 7 : null,
            accountPoolName:
              body.hostMode === "pool"
                ? body.accountPoolId === 8
                  ? "培训池"
                  : "默认池"
                : null,
          };
        }
        return base(path, method, body);
      },
    );
    return calls;
  }
  async function fill() {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("会议主题"), "主持人选择测试");
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    const summary = screen.getByRole("complementary", { name: "预约摘要" });
    await screen.findByText(admin.displayName, { selector: ".booking-host-name" });
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    for (const name of ["高级甲", "高级乙", "高级丙", "普通参会人"])
      await user.click(screen.getByRole("checkbox", { name }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    return { user, summary };
  }
  it.each(["person", "pool"])(
    "lists four eligible people and submits the explicit %s choice",
    async (mode) => {
      const calls = setup();
      mount("/meetings");
      const { user, summary } = await fill();
      expect(calls).toHaveLength(1); // Adding candidates never re-queries an already confirmed personal host.
      await user.click(screen.getByRole("combobox", { name: "发起账号" }));
      for (const name of [
        `${admin.displayName}（我）`,
        "高级甲",
        "高级乙",
        "高级丙",
        "使用账号池",
      ])
        expect(screen.getByRole("option", { name })).toBeTruthy();
      expect(screen.queryByRole("option", { name: "普通参会人" })).toBeNull();
      expect(
        screen.queryByRole("option", { name: "未邀请高级用户" }),
      ).toBeNull();
      await user.click(screen.getByRole("option", { name: "高级丙" }));
      await screen.findByText("高级丙", { selector: ".booking-host-name" });
      expect(calls.at(-1)).toMatchObject({ hostMode: "person", hostUserId: 5 });
      if (mode === "pool") {
        await user.click(screen.getByRole("combobox", { name: "发起账号" }));
        await user.click(screen.getByRole("option", { name: "使用账号池" }));
        await user.click(screen.getByRole("combobox", { name: "账号池" }));
        await user.click(screen.getByRole("option", { name: "培训池" }));
        await screen.findByText("池内空闲主持人", { selector: ".booking-host-name" });
        expect(calls.at(-1)).toMatchObject({
          hostMode: "pool",
          accountPoolId: 8,
        });
        expect(calls.at(-1)).not.toHaveProperty("hostUserId");
      }
      await user.click(screen.getByRole("button", { name: "提交预约" }));
      await waitFor(() =>
        expect(api.createMeeting).toHaveBeenCalledWith(
          expect.objectContaining(
            mode === "pool"
              ? { hostMode: "pool", accountPoolId: 8 }
              : { hostMode: "person", hostUserId: 5 },
          ),
          "stable-test-idempotency-key",
        ),
      );
      expect(vi.mocked(api.createMeeting).mock.calls[0]![0]).not.toHaveProperty(
        "hostSelection",
      );
    },
  );
  it("does not re-query a pinned host when unrelated attendees change", async () => {
    const calls = setup();
    mount("/meetings");
    const { user, summary } = await fill();
    await user.click(screen.getByRole("combobox", { name: "发起账号" }));
    await user.click(screen.getByRole("option", { name: "高级甲" }));
    await screen.findByText("高级甲", { selector: ".booking-host-name" });
    const before = calls.length;
    await user.click(screen.getByRole("button", { name: "移除普通参会人" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(calls).toHaveLength(before);
    expect(screen.getByText("高级甲", { selector: ".booking-host-name" })).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "发起账号" }));
    await user.click(screen.getByRole("option", { name: "使用账号池" }));
    await screen.findByText("池内空闲主持人", { selector: ".booking-host-name" });
    expect(calls.at(-1)).toMatchObject({
      hostMode: "pool",
      attendeeIds: [1, 2, 4, 5],
    });
  });
  it("requires a new choice after the selected host is removed from attendees", async () => {
    setup();
    mount("/meetings");
    const { user, summary } = await fill();
    await user.click(screen.getByRole("combobox", { name: "发起账号" }));
    await user.click(screen.getByRole("option", { name: "高级乙" }));
    await screen.findByText("高级乙", { selector: ".booking-host-name" });
    await user.click(screen.getByRole("button", { name: "移除高级乙" }));
    await user.click(screen.getByRole("button", { name: "提交预约" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "请重新选择发起账号",
    );
    expect(api.createMeeting).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "发起账号" }).textContent,
    ).toContain("已不可用");
  });
});

describe("component declarations", () => {
  it("renders and validates a newly registered component's config without page changes", async () => {
    connections.push({
      kind: "example-meeting",
      name: "示例会议组件",
      configured: false,
      fields: [
        { key: "apiToken", label: "示例密钥", required: true, secret: true },
      ],
      values: { apiToken: "" },
    });
    const user = userEvent.setup();
    mount("/settings?tab=business");
    await user.click(await screen.findByRole("tab", { name: "示例会议组件" }));
    const input = await screen.findByLabelText("示例密钥");
    expect(input.getAttribute("type")).toBe("password");
    await user.click(screen.getByRole("button", { name: "保存连接" }));
    expect(api.request).not.toHaveBeenCalledWith(
      "/platform-connections/example-meeting",
      "PATCH",
      expect.anything(),
    );
    await user.type(input, "test-token");
    await user.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        "/platform-connections/example-meeting",
        "PATCH",
        { apiToken: "test-token" },
      ),
    );
  });
  it("selects the sole Feishu connection, hides pools and allows an independent meeting", async () => {
    const base = vi.mocked(api.request).getMockImplementation()!;
    const configured = platformFixtures.map((p) => ({
      ...p,
      configured: p.capability === "calendar" || p.providerId === "feishu",
    }));
    vi.mocked(api.request).mockImplementation(async (path, method, body) => {
      if (path === "/booking/options")
        return { recordingTtlDays: 30, platforms: configured };
      if (path === "/platforms") return configured;
      if (path === "/booking/host-preview")
        return {
          available: true,
          allocationSource: "configured",
          hostAccountId: "default-owner",
          hostAccountName: "默认会议归属人",
        };
      return base(path, method, body);
    });
    const user = userEvent.setup();
    mount("/meetings");
    await user.type(await screen.findByLabelText("会议主题"), "飞书单独预约");
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2030-10-14T10:00" },
    });
    fireEvent.change(screen.getByLabelText("结束时间"), {
      target: { value: "2030-10-14T11:00" },
    });
    const platform = screen.getByRole("button", { name: "飞书会议" });
    expect(platform.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "飞书日程" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("combobox", { name: "发起账号" }));
    expect(screen.queryByRole("option", { name: "使用账号池" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "提交预约" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() =>
      expect(api.createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "feishu",
          connectionId: "feishu-meeting",
          calendarConnectionIds: ["feishu-calendar"],
        }),
        expect.any(String),
      ),
    );
  });
});
