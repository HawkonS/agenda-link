import { Inject, Injectable, BadRequestException } from "@nestjs/common";
import { ConfigurationService } from "../../../config/configuration.service.js";
import { PlatformHttp, PlatformError } from "../http.js";
import type { PlatformConnectionService } from "../../../platform-connection.service.js";
import type { FeishuAvatarSource } from "./avatar.js";
type DirectoryKind = "booking" | "sync" | "login" | "meeting";
/** 飞书开放平台的瞬时限流/令牌失效错误码，重试后通常可以继续。 */
const FEISHU_RATE_LIMIT = new Set([
  "99991400",
  "99991401",
  "99991402",
  "99991403",
]);
const FEISHU_AUTH_INVALID = new Set(["99991661", "99991663", "99991668"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export type DirectoryDepartment = {
  open_department_id: string;
  name: string;
  parent_department_id: string;
};
export type DirectoryPerson = FeishuAvatarSource & {
  open_id: string;
  user_id?: string;
  name: string;
  email?: string;
  mobile?: string;
  department_ids: string[];
  status?: { is_resigned?: boolean; is_frozen?: boolean };
};
import { eventDescription, type EventPayload } from "../../calendar/contract.js";
export { eventDescription, type EventPayload } from "../../calendar/contract.js";
@Injectable()
export class FeishuAdapter {
  private cache?: { token: string; expires: number; key: string };
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(PlatformHttp) private http: PlatformHttp,
    @Inject("PlatformConnectionService")
    private connections: PlatformConnectionService,
  ) {}
  get calendarId() {
    const id = String(
      this.connections.require("feishu-calendar").calendarId || "",
    );
    if (!id)
      throw new BadRequestException(
        "请在数据源设置中配置飞书共享日历 ID，并授予应用 writer 权限",
      );
    return id;
  }
  async token(kind: DirectoryKind = "booking", signal?: AbortSignal) {
    const connection =
      kind === "login"
        ? {
            appId: this.config.get("feishu.login.app-id"),
            appSecret: this.config.get("feishu.login.app-secret"),
          }
        : this.connections.require(
            kind === "sync" ? "feishu-directory" : kind === "meeting" ? "feishu-meeting" : "feishu-calendar",
          );
    if (!connection.appId || !connection.appSecret)
      throw new BadRequestException(
        "请先配置飞书登录应用 App ID 和 App Secret，并开通通讯录读取权限",
      );
    const key = String(connection.appId) + String(connection.appSecret);
    if (this.cache && this.cache.expires > Date.now() && this.cache.key === key)
      return this.cache.token;
    for (let attempt = 0; ; attempt++) {
      const d = await this.http.request(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        "POST",
        {},
        {
          app_id: connection.appId,
          app_secret: connection.appSecret,
        },
        signal,
      );
      if (d.code === 0 && d.tenant_access_token) {
        this.cache = {
          token: d.tenant_access_token,
          expires: Date.now() + (d.expire - 60) * 1000,
          key,
        };
        return this.cache.token;
      }
      if (attempt < 3 && FEISHU_RATE_LIMIT.has(String(d.code))) {
        await sleep(1000 * 2 ** attempt + Math.random() * 250);
        continue;
      }
      throw new PlatformError("飞书", String(d.code));
    }
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    kind: DirectoryKind = "booking",
    signal?: AbortSignal,
  ) {
    const url = "https://open.feishu.cn/open-apis" + path;
    for (let attempt = 0; ; attempt++) {
      const d = await this.http.request(
        url,
        method,
        { authorization: "Bearer " + (await this.token(kind, signal)) },
        body,
        signal,
      );
      if (d.code === 0) return d.data ?? {};
      const code = String(d.code);
      if (attempt < 3 && FEISHU_RATE_LIMIT.has(code)) {
        await sleep(1000 * 2 ** attempt + Math.random() * 250);
        continue;
      }
      if (attempt < 1 && FEISHU_AUTH_INVALID.has(code)) {
        // 令牌可能被提前吊销或轮换：清缓存后重新取一次。
        this.cache = undefined;
        continue;
      }
      throw new PlatformError("飞书", code);
    }
  }
  async pages(path: string, kind: DirectoryKind = "booking") {
    const items: any[] = [];
    let page = "";
    const seen = new Set<string>();
    do {
      const separator = path.includes("?") ? "&" : "?";
      const d = await this.request(
        path +
          separator +
          "page_size=50" +
          (page ? "&page_token=" + encodeURIComponent(page) : ""),
        "GET",
        undefined,
        kind,
      );
      items.push(...(d.items || []));
      if (items.length > 50_000 || seen.size > 1000)
        throw new PlatformError("飞书", "DIRECTORY_LIMIT_EXCEEDED");
      if (!d.has_more) break;
      page = d.page_token;
      if (!page || seen.has(page))
        throw new PlatformError("飞书", "INVALID_PAGINATION");
      seen.add(page);
    } while (true);
    return items;
  }
  async directory(kind: "sync" | "login" = "sync", includePeople = true) {
    const root =
      kind === "sync"
        ? String(
            this.connections.require("feishu-directory").rootDepartmentId || "0",
          )
        : "0";
    const departments = (await this.pages(
      "/contact/v3/departments/" +
        encodeURIComponent(root) +
        "/children?department_id_type=open_department_id&fetch_child=true",
      kind,
    )) as DirectoryDepartment[];
    if (departments.length > 5000)
      throw new BadRequestException(
        "单实例最多支持 5000 个部门，请缩小飞书通讯录范围",
      );
    if (root !== "0") {
      const data = await this.request(
        "/contact/v3/departments/" +
          encodeURIComponent(root) +
          "?department_id_type=open_department_id",
        "GET",
        undefined,
        kind,
      );
      if (data.department)
        departments.unshift({ ...data.department, parent_department_id: "0" });
    }
    const people = new Map<string, DirectoryPerson>();
    const departmentIds = includePeople
      ? [root, ...departments.map((d) => d.open_department_id)]
      : [];
    // 部门串行读取在大型通讯录里容易超过前端 60s 超时；用有限并发缩短总时长。
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(4, departmentIds.length) },
      async () => {
        for (;;) {
          const index = cursor++;
          if (index >= departmentIds.length) return;
          const id = departmentIds[index]!;
          const rows = (await this.pages(
            "/contact/v3/users/find_by_department?department_id=" +
              encodeURIComponent(id) +
              "&department_id_type=open_department_id&user_id_type=open_id",
            kind,
          )) as DirectoryPerson[];
          for (const person of rows) people.set(person.open_id, person);
          if (people.size > 50_000)
            throw new BadRequestException(
              "单实例最多支持 50000 名人员，请缩小飞书通讯录范围",
            );
        }
      },
    );
    await Promise.all(workers);
    return { departments, people: [...people.values()] };
  }
  async test(kind: DirectoryKind = "booking") {
    const connection = this.connections.require(
      kind === "sync" ? "feishu-directory" : kind === "meeting" ? "feishu-meeting" : "feishu-calendar",
    );
    await this.token(kind);
    await this.request(
      "/contact/v3/scopes?page_size=10",
      "GET",
      undefined,
      kind,
    );
    if (kind === "booking" && connection.calendarId)
      await this.request(
        "/calendar/v4/calendars/" + encodeURIComponent(this.calendarId),
      );
    return {
      ok: true,
      calendarConfigured: Boolean(connection.calendarId),
    };
  }
  async oauth(code: string, verifier: string) {
    const d = await this.http.request(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      "POST",
      {},
      {
        grant_type: "authorization_code",
        client_id: this.config.get("feishu.login.app-id"),
        client_secret: this.config.get("feishu.login.app-secret"),
        code,
        redirect_uri: this.config.get("feishu.login.redirect-uri"),
        code_verifier: verifier,
      },
    );
    if (!d.access_token)
      throw new PlatformError(
        "飞书 OAuth",
        String(d.code || d.error || "NO_TOKEN"),
      );
    const user = await this.http.request(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      "GET",
      { authorization: "Bearer " + d.access_token },
    );
    if (user.code !== 0)
      throw new PlatformError("飞书 OAuth", String(user.code));
    return user.data;
  }
  private eventBody(p: EventPayload) {
    return {
      summary: p.subject,
      description: eventDescription(p),
      start_time: {
        timestamp: String(Math.floor(Date.parse(p.startAt) / 1000)),
        timezone: "Asia/Shanghai",
      },
      end_time: {
        timestamp: String(Math.floor(Date.parse(p.endAt) / 1000)),
        timezone: "Asia/Shanghai",
      },
      location: p.location ? { name: p.location } : undefined,
      ...(p.reminders
        ? { reminders: p.reminders.map((minutes) => ({ minutes })) }
        : {}),
      vchat: p.meetingUrl
        ? {
            vc_type: "third_party",
            meeting_url: p.meetingUrl,
            description: p.meetingProviderName || "加入会议",
          }
        : { vc_type: "no_meeting" },
      // Keep the shared calendar event visible to all invited attendees. A
      // private event hides the attendee list in Feishu, which makes a
      // meeting created from this service look as if nobody was invited.
      visibility: "default",
      attendee_ability: "can_invite_others",
    };
  }
  async createEvent(
    p: EventPayload,
    key: string,
    calendarId = this.calendarId,
  ) {
    const data = await this.request(
      "/calendar/v4/calendars/" +
        encodeURIComponent(calendarId) +
        "/events?idempotency_key=" +
        encodeURIComponent(key),
      "POST",
      this.eventBody(p),
    );
    if (!data.event?.event_id)
      throw new PlatformError("飞书日历", "NO_EVENT_ID", true);
    return { id: data.event.event_id, calendarId };
  }
  async invite(
    eventId: string,
    calendarId: string,
    attendees: EventPayload["attendees"],
  ) {
    const base =
      "/calendar/v4/calendars/" +
      encodeURIComponent(calendarId) +
      "/events/" +
      encodeURIComponent(eventId) +
      "/attendees";
    // UserID is stable across enterprise apps; OpenID is scoped to a specific app.
    for (const mode of ["user_id", "open_id"] as const) {
      const group = (attendees || []).filter((p) =>
        mode === "user_id" ? Boolean(p.userId) : !p.userId,
      );
      if (!group.length) continue;
      const path = base + "?user_id_type=" + mode;
      // Calendar attendees must be read with the same booking app that owns
      // the shared calendar. The sync app has a different OpenID namespace
      // and can return an incomplete attendee list.
      const current = await this.pages(path, "booking");
      const seen = new Set(
        current.map((p) =>
          p.user_id
            ? "u:" + p.user_id
            : "e:" + String(p.third_party_email).toLowerCase(),
        ),
      );
      const people: Record<string, string>[] = [];
      for (const p of group) {
        const id = mode === "user_id" ? p.userId : p.openId;
        const key = id ? "u:" + id : "e:" + p.email?.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (id) people.push({ type: "user", user_id: id });
        else if (p.email)
          people.push({ type: "third_party", third_party_email: p.email });
      }
      for (let i = 0; i < people.length; i += 500)
        await this.request(path, "POST", {
          attendees: people.slice(i, i + 500),
          need_notification: true,
        });
    }
  }
  async updateEvent(id: string, calendarId: string, p: EventPayload) {
    await this.request(
      "/calendar/v4/calendars/" +
        encodeURIComponent(calendarId) +
        "/events/" +
        encodeURIComponent(id),
      "PATCH",
      this.eventBody(p),
    );
  }
  async readEventDescription(id: string, calendarId: string) {
    const data = await this.request(
      "/calendar/v4/calendars/" +
        encodeURIComponent(calendarId) +
        "/events/" +
        encodeURIComponent(id),
      "GET",
      undefined,
      "booking",
      AbortSignal.timeout(2500),
    );
    return typeof data.event?.description === "string"
      ? (data.event.description as string)
      : undefined;
  }
  async replaceAttendees(
    id: string,
    calendarId: string,
    people: EventPayload["attendees"],
  ) {
    const base =
      "/calendar/v4/calendars/" +
      encodeURIComponent(calendarId) +
      "/events/" +
      encodeURIComponent(id) +
      "/attendees";
    const current = await this.pages(base + "?user_id_type=open_id", "booking");
    const stable = (people || []).some((p) => p.userId)
      ? await this.pages(base + "?user_id_type=user_id", "booking")
      : [];
    const stableByAttendee = new Map(
      stable.map((p) => [p.attendee_id, p.user_id]),
    );
    const keepOpen = new Set(
      (people || []).map((p) => p.openId).filter(Boolean),
    );
    const keepUser = new Set(
      (people || []).map((p) => p.userId).filter(Boolean),
    );
    const keepEmail = new Set(
      (people || []).map((p) => p.email?.toLowerCase()).filter(Boolean),
    );
    const remove = current
      .filter(
        (p) =>
          !p.is_organizer &&
          !(p.user_id
            ? keepOpen.has(p.user_id) ||
              keepUser.has(stableByAttendee.get(p.attendee_id))
            : keepEmail.has(String(p.third_party_email).toLowerCase())),
      )
      .map((p) => p.attendee_id)
      .filter(Boolean);
    for (let i = 0; i < remove.length; i += 500)
      await this.request(base + "/batch_delete?user_id_type=open_id", "POST", {
        attendee_ids: remove.slice(i, i + 500),
        need_notification: true,
      });
    await this.invite(id, calendarId, people);
  }
  async deleteEvent(id: string, calendarId: string) {
    await this.request(
      "/calendar/v4/calendars/" +
        encodeURIComponent(calendarId) +
        "/events/" +
        encodeURIComponent(id),
      "DELETE",
    );
  }
}
