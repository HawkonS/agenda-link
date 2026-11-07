import { z } from "zod";
import { parseLocalDateTime } from "./date-time";
const required = (label: string, max = 200) =>
  z.string().trim().min(1, `请填写${label}`).max(max, `${label}最多 ${max} 字`);
export const syncPolicyFormSchema = z
  .object({
    automaticMode: z.enum(["manual", "interval", "daily"]),
    intervalMinutes: z.string(),
    dailyHour: z.string().regex(/^(?:[01]\d|2[0-3])$/),
    dailyMinute: z.string().regex(/^[0-5]\d$/),
  })
  .superRefine((v, ctx) => {
    if (
      v.automaticMode === "interval" &&
      (!/^\d+$/.test(v.intervalMinutes) ||
        Number(v.intervalMinutes) < 1 ||
        Number(v.intervalMinutes) > 10080)
    )
      ctx.addIssue({
        code: "custom",
        path: ["intervalMinutes"],
        message: "同步间隔应为 1–10080 分钟的整数",
      });
  });
const email = z
  .string()
  .refine(
    (v) => !v || z.string().email().safeParse(v).success,
    "请输入有效的邮箱地址",
  );
const emails = z.string().refine(
  (v) =>
    v
      .split(/[\s,;]+/)
      .filter(Boolean)
      .every((v) => z.string().email().safeParse(v).success),
  "邮箱格式不正确，多个邮箱请用逗号分隔",
);
const date = z
  .string()
  .refine(
    (v) => !!parseLocalDateTime(v),
    "请选择日期和时间，或输入 年-月-日 时:分",
  );
const reminder = z
  .array(
    z.number().int().min(0, "提醒不能小于 0").max(10080, "提醒最多提前 7 天"),
  )
  .max(5, "最多设置 5 个提醒");
const extensions = z
  .array(
    z.object({
      key: z.string().trim().min(1, "请填写信息名称"),
      value: z.string(),
    }),
  )
  .superRefine((rows, ctx) => {
    const keys = new Set<string>();
    rows.forEach((row, i) => {
      if (keys.has(row.key))
        ctx.addIssue({
          code: "custom",
          path: [i, "key"],
          message: "信息名称不能重复",
        });
      keys.add(row.key);
    });
  });
const timing = {
  subject: required("主题", 200),
  startAt: date,
  endAt: date,
  reminders: reminder,
  extensions,
};
const order = (v: { startAt: string; endAt: string }, ctx: z.RefinementCtx) => {
  const start = parseLocalDateTime(v.startAt),
    end = parseLocalDateTime(v.endAt);
  if (start && end && end <= start)
    ctx.addIssue({
      code: "custom",
      path: ["endAt"],
      message: "结束时间应晚于开始时间",
    });
};
export const meetingSchema = z
  .object({
    subject: timing.subject,
    startAt: timing.startAt,
    endAt: timing.endAt,
    reminders: reminder.optional(),
    extensions,
    attendeeEmails: emails,
    recordingEnabled: z.boolean(),
    recordingTtlDays: z.coerce.number(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    order(v, ctx);
    if (
      v.recordingEnabled &&
      (!Number.isInteger(v.recordingTtlDays) ||
        v.recordingTtlDays < 1 ||
        v.recordingTtlDays > 365)
    )
      ctx.addIssue({
        code: "custom",
        path: ["recordingTtlDays"],
        message: "保留天数应为 1–365 的整数",
      });
  });
export const userSchema = (editing: boolean) =>
  z
    .object({
      username: required("登录账号", 100),
      displayName: required("显示名称", 100),
      email,
      phone: z.string(),
      password: editing
        ? z.string().refine((v) => !v || v.length >= 12, "密码至少 12 位")
        : z.string().min(12, "密码至少 12 位"),
      role: z.enum(["user", "operation_admin", "system_admin"]),
      systemAccess: z.enum(["allowed", "blocked"]),
    })
    .passthrough();
export const poolSchema = z.object({
  connectionId: z.string().optional(),
  name: required("账号池名称", 100),
  accountIds: z.array(z.number()),
  description: z.string(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
});
export const accountSchema = z
  .object({
    name: required("账号名称", 100),
    accountId: required("平台账号 ID", 200),
    secretId: z.string(),
    secretKey: z.string(),
  })
  .superRefine((v, ctx) => {
    if (!!v.secretId !== !!v.secretKey)
      ctx.addIssue({
        code: "custom",
        path: [v.secretId ? "secretKey" : "secretId"],
        message: "独立接口凭据需同时填写 Secret ID 和 Secret Key",
      });
  });
export const ruleSchema = z
  .object({
    name: required("规则名称", 100),
    departmentExternalId: z.string(),
    departmentName: z.string(),
    meetingUserType: z.enum(["ordinary", "advanced"]),
    enabled: z.boolean(),
    isDefault: z.boolean(),
  })
  .passthrough();
export const personSchema = z.object({
  phone: z.string(),
  email,
  tencentUserId: z.string(),
});
export const profileSchema = z.object({
  displayName: required("显示名称", 100),
  email,
});
export const passwordSchema = z
  .object({
    currentPassword: required("当前密码", 1000),
    newPassword: z.string().min(12, "新密码至少 12 位").max(1000, "密码过长"),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ["newPassword"],
    message: "新密码不能与当前密码相同",
  });
export const loginSchema = z.object({
  username: required("用户名", 100),
  password: required("密码", 1000),
});
export const templateSchema = z
  .object({
    name: required("模板名称", 100),
    title: required("日程标题", 500),
    description: z.string(),
    location: z.string(),
    reminders: z
      .array(z.number().int().min(0).max(10080))
      .max(5, "最多设置 5 个提醒"),
    extras: z.array(z.object({ key: z.string(), value: z.string() })),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const keys = new Set<string>();
    v.extras.forEach((row, i) => {
      if (!row.key.trim())
        ctx.addIssue({
          code: "custom",
          path: ["extras", i, "key"],
          message: "请填写信息名称",
        });
      else if (keys.has(row.key.trim()))
        ctx.addIssue({
          code: "custom",
          path: ["extras", i, "key"],
          message: "信息名称不能重复",
        });
      keys.add(row.key.trim());
    });
  });
export const connectionSchema = z.record(z.string());
// Properties are flat keys; encode dots so RHF does not interpret them as nested objects.
export const settingFieldName = (key: string) => key.replaceAll(".", "__");
export const settingsFormValues = (values: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      settingFieldName(key),
      value,
    ]),
  );
export const settingsSchema = z.record(z.string()).superRefine((v, ctx) => {
  function check(
    key: string,
    valid: (value: string) => boolean,
    message: string,
  ) {
    const name = settingFieldName(key);
    if (name in v && !valid(v[name]!))
      ctx.addIssue({ code: "custom", path: [name], message });
  }
  check("platform.name", (v) => !!v.trim(), "请填写平台名称");
  check(
    "platform.primary-color",
    (v) => /^#[\da-f]{6}$/i.test(v),
    "请输入 #RRGGBB 格式的颜色",
  );
  for (const key of ["app.port", "web.port"])
    check(
      key,
      (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535,
      "端口应为 1–65535 的整数",
    );
  check(
    "worker.interval-seconds",
    (v) => /^\d+$/.test(v) && Number(v) >= 1,
    "轮询间隔应为正整数",
  );
  check(
    "recording.ttl-days",
    (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 365,
    "保留天数应为 1–365 的整数",
  );
  for (const key of ["app.base-url", "feishu.login.redirect-uri"])
    check(
      key,
      (v) =>
        !v || (/^https?:\/\//.test(v) && z.string().url().safeParse(v).success),
      "请输入有效的 HTTP 或 HTTPS 地址",
    );
});
