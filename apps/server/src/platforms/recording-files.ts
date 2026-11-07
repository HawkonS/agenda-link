import { BadRequestException } from "@nestjs/common";
export type StoredFile = {
  id: string;
  url?: string;
  viewUrl?: string;
  /** 腾讯会议录制分享页；非创建人打开时优先用它，避免只有主持人可读。 */
  shareUrl?: string;
  extension: string;
  remoteDeleted?: boolean;
};
export function recordingUrl(raw: string, domains=[".tencent.com", ".qq.com", ".myqcloud.com", ".tencentmeeting.com", ".tencentcs.com"]): string {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !domains.some((s) => u.hostname === s.replace(/^\./, "") || u.hostname.endsWith(s))
    )
      throw new Error();
    return u.toString();
  } catch {
    throw new BadRequestException("平台返回了不受信任的录制地址域名");
  }
}
