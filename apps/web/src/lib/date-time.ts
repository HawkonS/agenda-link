/** Local wall-clock values are converted to UTC only when sending the request. */
export function parseLocalDateTime(value: string): Date | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return;
  const [, y, m, d, h, minute, seconds] = match.map(Number);
  const date = new Date(y!, m! - 1, d!, h!, minute!, seconds || 0);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m! - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== (seconds || 0)
  )
    return;
  return date;
}
export function localDateTimeValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
