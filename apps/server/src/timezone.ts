/** 日期筛选按配置时区解释，而不是写死 +08:00。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

export function resolveTimeZone(value?: string) {
  const candidate = (value || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(
      new Date(),
    );
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function offsetAt(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour") % 24,
    value("minute"),
    value("second"),
  );
  return asUtc - date.getTime();
}

/** 指定时区里某一天 00:00 的 epoch 毫秒。 */
export function zonedDayStart(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const guess = Date.UTC(year!, month! - 1, day!);
  let timestamp = guess - offsetAt(new Date(guess), timeZone);
  const corrected = guess - offsetAt(new Date(timestamp), timeZone);
  if (corrected !== timestamp) timestamp = corrected;
  return timestamp;
}

export function nextDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1))
    .toISOString()
    .slice(0, 10);
}
