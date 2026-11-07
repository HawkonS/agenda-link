import {COMPONENTS,type PlatformComponent} from "../contracts.js";
import { Inject,Optional,Injectable } from "@nestjs/common";
const tencentRejections: Record<string, string> = {
  "500122":
    "操作者不在应用可用范围内。请在腾讯会议应用的“应用安全和可用范围”中加入当前管理员，或配置范围内具有管理权限的管理员 UserID。",
  "20006":
    "手机号码格式异常。腾讯会议要求区号与手机号分开提交，例如 area=86，phone 为 11 位手机号；请检查人员的手机号。",
  "190004": "请求参数非法，请检查人员资料和接口参数。",
  "60005": "用户不存在或未激活，无法执行启用/禁用动作；请核对腾讯会议账号状态。",
  "500133": "当前管理员没有腾讯会议人员管理权限。",
  "20005": "腾讯会议不允许修改超级管理员或企业管理员。",
};
export class PlatformError extends Error {
  constructor(
    readonly platform: string,
    readonly code: string,
    readonly ambiguous = false,
    readonly httpStatus?: number,
    readonly reason?: string,
  ) {
    const isTencent =
      platform === "腾讯会议" || platform === "api.meeting.qq.com";
    const detail = [
      ...new Set(
        [reason, isTencent ? tencentRejections[code] : undefined].filter(
          Boolean,
        ),
      ),
    ].join(" ");
    const uncertain = ambiguous && !(isTencent && tencentRejections[code]);
    super(
      (isTencent ? "腾讯会议" : platform) +
        " 调用失败（" +
        code +
        "）" +
        (detail ? "：" + detail : "") +
        (uncertain ? "，结果不确定，需核对平台后处理" : ""),
    );
    this.ambiguous = uncertain;
  }
}
@Injectable()
export class PlatformHttp {
  private hosts:Set<string>;
  constructor(@Optional() @Inject(COMPONENTS) components:PlatformComponent[]=[]){this.hosts=new Set(components.flatMap(c=>c.apiHosts || []));}
  async request(
    url: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    const hostname = new URL(url).hostname;
    if (
      new URL(url).protocol !== "https:" ||
      !this.hosts.has(hostname)
    )
      throw new PlatformError("开放平台", "UNTRUSTED_ENDPOINT");
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body:
            body === undefined
              ? undefined
              : typeof body === "string"
                ? body
                : JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
          redirect: "error",
        });
      } catch {
        if (method === "GET" && attempt < 2 && !signal?.aborted) continue;
        throw new PlatformError(
          new URL(url).hostname,
          "NETWORK",
          method !== "GET",
        );
      }
      if (
        method === "GET" &&
        [429, 502, 503, 504].includes(response.status) &&
        attempt < 2
      ) {
        await response.body?.cancel();
        await new Promise((r) =>
          setTimeout(
            r,
            Math.min(
              3000,
              Number(response.headers.get("retry-after") || 1) * 1000,
            ),
          ),
        );
        continue;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) {
              await reader.cancel();
              throw new PlatformError(
                hostname,
                "RESPONSE_TOO_LARGE",
                method !== "GET",
              );
            }
            chunks.push(value);
          }
        } catch (error) {
          if (error instanceof PlatformError) throw error;
          throw new PlatformError(hostname, "NETWORK", method !== "GET");
        } finally {
          reader.releaseLock();
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new PlatformError(
          new URL(url).hostname,
          "INVALID_RESPONSE",
          method !== "GET",
        );
      }
      if (!response.ok || data?.error_info?.error_code) {
        const rawReason =
          data?.error_info?.message || data?.message || data?.msg;
        let reason =
          typeof rawReason === "string" ? rawReason.slice(0, 500) : undefined;
        for (const [key, value] of Object.entries(headers))
          if (
            reason &&
            /authorization|key|signature|token/i.test(key) &&
            value.length >= 8
          )
            for (const secret of [value, value.replace(/^Bearer\s+/i, "")])
              if (secret.length >= 8)
                reason = reason.split(secret).join("[redacted]");
        const redactBody = (value: unknown, key = "") => {
          if (
            typeof value === "string" &&
            /secret|password|token|code_verifier|authorization/i.test(key) &&
            value.length >= 4 &&
            reason
          )
            reason = reason.split(value).join("[redacted]");
          else if (value && typeof value === "object")
            for (const [k, v] of Object.entries(value)) redactBody(v, k);
        };
        redactBody(body);
        throw new PlatformError(
          new URL(url).hostname,
          String(data?.error_info?.error_code || data?.code || response.status),
          response.status >= 500 && method !== "GET",
          response.status,
          reason,
        );
      }
      return data;
    }
  }
}
