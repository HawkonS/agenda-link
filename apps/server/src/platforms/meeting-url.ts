export function meetingJoinUrl(value: unknown, domains=[".tencent.com", ".qq.com", ".tencentmeeting.com"]): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !domains.some((s) =>
        url.hostname === s.replace(/^\./, "") || url.hostname.endsWith(s),
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
