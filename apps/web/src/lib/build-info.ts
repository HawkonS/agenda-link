export const BUILD_NUMBER = import.meta.env.VITE_BUILD_NUMBER || "local";
export const BUILD_TIME = import.meta.env.VITE_BUILD_TIME || "";

/** 构建时间统一按本地时区展示，避免登录页和侧栏格式不一致。 */
export function formatBuildTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "本地开发";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(/\//g, "-");
}
