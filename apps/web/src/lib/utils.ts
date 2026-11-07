import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function time(value?: string | null) {
  if (!value) return "—";
  const date = new Date(
    value.includes("T") ? value : value.replace(" ", "T") + "Z",
  );
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
}
export function localDate(value: string) {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function jsonObject(value: string): Record<string, string> {
  const result = JSON.parse(value || "{}");
  if (
    !result ||
    Array.isArray(result) ||
    typeof result !== "object" ||
    Object.values(result).some((v) => typeof v !== "string")
  )
    throw new Error("扩展信息必须是 JSON 字符串键值对象");
  return result;
}
export function reminders(value: string) {
  const result = value
    .split(",")
    .filter((v) => v.trim())
    .map(Number);
  if (
    result.length > 5 ||
    result.some((v) => !Number.isInteger(v) || v < 0 || v > 10080)
  )
    throw new Error("提醒最多 5 项，每项为 0–10080 分钟的整数");
  return result;
}
export const roleText: Record<string, string> = {
  user: "用户",
  operation_admin: "运营管理员",
  system_admin: "系统管理员",
};
export const statusText: Record<string, string> = {
  provisioning: "预约排队中",
  scheduled: "已预约",
  unknown: "待核对",
  failed: "失败",
  cancelling: "取消中",
  cancel_failed: "取消失败",
  cancelled: "已取消",
  finished: "已结束",
  pending: "等待同步",
  synced: "已同步",
  queued: "排队中",
  running: "执行中",
  success: "成功",
  processing: "处理中",
  ready: "可下载",
  expired: "已过期",
  applied: "已设为联席",
  preassigned_host: "已预约主持人",
  cohost_pending: "待设置",
  waiting_meeting: "等待开会",
  waiting_join: "等待入会",
  cohost_ended: "会议已结束",
  cohost_cancelled: "会议已取消",
  host: "会议主持人",
  not_applicable: "不适用",
  available: "可用",
  disabled: "停用",
  active: "启用",
  error: "错误",
};
