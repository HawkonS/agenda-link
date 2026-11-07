import { z } from "zod";
import { dates, eventSchema } from "./validation.js";

export const hostFields = {
  accountPoolId: z.number().int().positive().optional(),
  hostMode: z.enum(["auto", "person", "pool"]).optional(),
  hostUserId: z.number().int().positive().optional(),
};
export const validHostPreference = (v: { hostMode?: string; hostUserId?: number }) =>
  v.hostMode === "person"
    ? v.hostUserId !== undefined
    : v.hostUserId === undefined;
export const hostPreferenceError = {
  message: "指定主持人时必须选择人员，其他模式不能指定主持人",
  path: ["hostUserId"],
};
export const noHostMessage = (mode?: string) =>
  mode === "person"
    ? "所选主持账号不可用或在该时段已有会议，请更换主持人或使用账号池"
    : mode === "pool"
      ? "所选账号池在该时段没有已验证的空闲高级账号，请更换账号池或调整时间"
      : "该时段没有已验证的空闲高级账号，请调整时间、参会人或发起账号";
export const bookingSchema = eventSchema
  .safeExtend({
    ...hostFields,
    providerId:z.string().max(100).optional(), connectionId:z.string().max(100).optional(),
    attendeeIds: z.array(z.number().int().positive()).max(300).default([]),
    attendeeEmails: z.array(z.string().email().max(254)).max(100).default([]),
    recordingEnabled: z.boolean().default(false),
    recordingTtlDays: z.number().int().min(1).max(365).default(30),
    calendarTemplateId: z.number().int().positive().optional(),
    calendarConnectionId:z.string().max(100).nullable().optional(),
    calendarConnectionIds:z.array(z.string().max(100)).max(20).optional(),
  })
  .refine(validHostPreference, hostPreferenceError);
export const hostSelectionSchema = dates
  .safeExtend({
    ...hostFields,
    providerId:z.string().max(100).optional(), connectionId:z.string().max(100).optional(),
    attendeeIds: z.array(z.number().int().positive()).max(300).default([]),
  })
  .refine(validHostPreference, hostPreferenceError);
const blockedPathSegment = new Set(["__proto__", "prototype", "constructor"]);

function resolvePath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!segment || blockedPathSegment.has(segment)) return undefined;
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function templateValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function render(
  template: string,
  values: Record<string, string>,
  providerResponse?: unknown,
  providerId?: string,
) {
  return template.replace(
    /\{([a-zA-Z0-9_]+|provider\.[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,199})\}/g,
    (_, key: string) => {
      if (key.startsWith("provider.")) {
        const raw = key.slice("provider.".length);
        const slash = raw.indexOf("/");
        if (slash !== -1) {
          const scope = raw.slice(0, slash);
          if (providerId && scope !== providerId) return "";
          return templateValue(
            resolvePath(providerResponse, raw.slice(slash + 1)),
          );
        }
        return templateValue(resolvePath(providerResponse, raw));
      }
      return values[key] ?? "{" + key + "}";
    },
  );
}

/** 模板变量里的会议平台使用完整产品名，而不是底层连接名。 */
export function meetingPlatformLabel(connectionId: string, name: string) {
  if (connectionId === "feishu-meeting") return "飞书会议";
  if (connectionId === "tencent-meeting") return "腾讯会议";
  return name.endsWith("会议") ? name : `${name}会议`;
}

/** Template strings are rendered into Feishu/event descriptions, so they must
 * contain local readable time rather than the raw UTC ISO timestamp. */
export function templateDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}
