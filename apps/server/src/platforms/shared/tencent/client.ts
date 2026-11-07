import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { createHmac, randomInt } from "node:crypto";
import { ConfigurationService } from "../../../config/configuration.service.js";
import { PlatformHttp, PlatformError } from "../http.js";
import type { PlatformConnectionService } from "../../../platform-connection.service.js";
import { tencentPhone } from "./phone.js";
import { meetingJoinUrl } from "../../meeting-url.js";
import { recordingUrl, type StoredFile } from "../../recording-files.js";
export function tencentSignature(
  method: string,
  path: string,
  body: string,
  key: string,
  secret: string,
  nonce: string,
  timestamp: string,
) {
  const plain =
    method +
    "\nX-TC-Key=" +
    key +
    "&X-TC-Nonce=" +
    nonce +
    "&X-TC-Timestamp=" +
    timestamp +
    "\n" +
    path +
    "\n" +
    body;
  return Buffer.from(
    createHmac("sha256", secret).update(plain).digest("hex"),
  ).toString("base64");
}
export function meetingCode(meeting: any): string | undefined {
  for (const key of ["meeting_code", "meeting_number", "meeting_no"])
    if (meeting?.[key] !== undefined && meeting?.[key] !== null) {
      const value = String(meeting[key]).trim();
      if (value) return value;
    }
  return undefined;
}

/** Keep both the complete API envelope and the selected meeting at the root.
 * This lets templates address documented fields directly while still
 * supporting arbitrary nested fields such as `meeting_info_list.0.*`.
 */
export function tencentMeetingResponse(data: unknown, meeting: any) {
  const envelope =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return { ...envelope, ...(meeting || {}), meeting_info: meeting };
}

function isAlreadyCancelled(error: unknown) {
  if (!(error instanceof PlatformError) || error.code !== "9007") return false;
  return /CANC(?:EL|LE)D|CANCELLED|CANCELED/i.test(
    [error.reason, error.message].filter(Boolean).join(" "),
  );
}

@Injectable()
export class TencentAdapter {
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(PlatformHttp) private http: PlatformHttp,
    @Inject("PlatformConnectionService")
    private connections: PlatformConnectionService,
  ) {}
  get operator() {
    const v = String(
      this.connections.require("tencent-meeting").operatorId || "",
    );
    if (!v) throw new BadRequestException("腾讯会议操作者 ID 未配置");
    return v;
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    credentials?: { secretId?: string | null; secretKey?: string | null },
  ): Promise<any> {
    const connection = this.connections.require("tencent-meeting");
    const key = credentials?.secretId || String(connection.secretId || "");
    const secret = credentials?.secretKey
      ? this.config.decrypt(credentials.secretKey)
      : String(connection.secretKey || "");
    if (!key || !secret || !connection.appId || !connection.sdkId)
      throw new BadRequestException("腾讯会议企业及应用凭据未配置");
    const nonce = String(randomInt(1, 2147483647));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const encoded = body === undefined ? "" : JSON.stringify(body);
    const result = await this.http.request(
      "https://api.meeting.qq.com" + path,
      method,
      {
        "X-TC-Key": key,
        "X-TC-Nonce": nonce,
        "X-TC-Timestamp": timestamp,
        "X-TC-Signature": tencentSignature(
          method,
          path,
          encoded,
          key,
          secret,
          nonce,
          timestamp,
        ),
        "X-TC-Registered": "1",
        AppId: String(connection.appId),
        SdkId: String(connection.sdkId),
      },
      body === undefined ? undefined : encoded,
    );
    if (result.error_info?.error_code)
      throw new PlatformError(
        "腾讯会议",
        String(result.error_info.error_code),
        false,
        undefined,
        result.error_info.message,
      );
    return result;
  }
  async user(id: string) {
    return this.request(
      "/v1/users/" +
        encodeURIComponent(id) +
        "?operator_id=" +
        encodeURIComponent(this.operator) +
        "&operator_id_type=1",
    );
  }
  async userList(): Promise<any[]> {
    const ids = new Map<string, any>();
    const pageSize = 20;
    for (let page = 1; ; page++) {
      const data = await this.request(
        "/v1/users/list?" +
          new URLSearchParams({
            page: String(page),
            page_size: String(pageSize),
            operator_id: this.operator,
            operator_id_type: "1",
          }),
      );
      if (!Array.isArray(data.users))
        throw new PlatformError("腾讯会议", "INVALID_USER_LIST");
      const previousSize = ids.size;
      for (const user of data.users) {
        if (typeof user.userid !== "string" || !user.userid)
          throw new PlatformError("腾讯会议", "INVALID_USER_ID");
        ids.set(user.userid, user);
      }
      if (ids.size > 50_000 || page > 2500)
        throw new PlatformError("腾讯会议", "DIRECTORY_LIMIT_EXCEEDED");
      const total = Number(data.total_count);
      if (Number.isFinite(total) && total >= 0) {
        if (ids.size >= total) return [...ids.values()];
      } else if (data.users.length < pageSize) return [...ids.values()];
      if (ids.size === previousSize)
        throw new PlatformError("腾讯会议", "INCOMPLETE_USER_LIST");
    }
  }
  async userIds(): Promise<Set<string>> {
    return new Set((await this.userList()).map((u) => u.userid));
  }
  isAdvanced(data: any) {
    return [1, 4, 5, 6, 7, 8, 9].includes(
      Number(data.user_account_type ?? data.account_type),
    );
  }
  isUserInDepartment(data: any, departmentId: string) {
    if (!Array.isArray(data.department_list)) return false;
    // Tencent returns no departments for a user assigned to the enterprise root.
    if (!data.department_list.length) return departmentId === "0";
    return (
      data.department_list.length === 1 &&
      (typeof data.department_list[0] === "string"
        ? data.department_list[0]
        : data.department_list[0]?.department_id) === departmentId
    );
  }
  async updateUserAssignment(
    id: string,
    departmentId: string | undefined,
    advanced?: boolean,
  ) {
    if (departmentId === "")
      throw new BadRequestException("腾讯会议部门 ID 不能为空");
    await this.request("/v1/users/" + encodeURIComponent(id), "PUT", {
      operator_id: this.operator,
      operator_id_type: 1,
      ...(departmentId !== undefined
        ? { department_list: [departmentId] }
        : {}),
      ...(advanced !== undefined
        ? {
            user_account_type: advanced
              ? Number(
                  this.connections.get("tencent-meeting").advancedType || 9,
                )
              : 2,
          }
        : {}),
    });
  }
  async verifyAccount(account: {
    accountId: string;
    secretId?: string | null;
    secretKey?: string | null;
  }) {
    const data = await this.request(
      "/v1/users/" +
        encodeURIComponent(account.accountId) +
        "?operator_id=" +
        encodeURIComponent(this.operator) +
        "&operator_id_type=1",
      "GET",
      undefined,
      account,
    );
    const type = Number(data.user_account_type ?? data.account_type);
    if (![1, 4, 5, 6, 7, 8, 9].includes(type))
      throw new BadRequestException("该腾讯会议账号未获得高级用户许可");
    return { ok: true, accountType: type };
  }
  async test() {
    await this.user(this.operator);
    return { ok: true };
  }
  async departments() {
    const rows: any[] = [];
    for (let page = 1; ; page++) {
      const d = await this.request(
        "/v1/departments?userid=" +
          encodeURIComponent(this.operator) +
          "&page=" +
          page +
          "&page_size=20",
      );
      rows.push(...(d.department_list || []));
      if (rows.length > 5000 || page > 250)
        throw new PlatformError("腾讯会议", "DIRECTORY_LIMIT_EXCEEDED");
      if (page >= (d.total_page || 1)) return rows;
    }
  }
  async department(name: string, parentId: string, id?: string | null) {
    return this.request(
      "/v1/departments" + (id ? "/" + encodeURIComponent(id) : ""),
      id ? "PUT" : "POST",
      {
        userid: this.operator,
        department_name: name,
        parent_department_id: parentId || "0",
      },
    );
  }
  async upsertUser(p: {
    id: string;
    name: string;
    email?: string | null;
    phone?: string | null;
    departmentIds: string[];
    advanced?: boolean;
    disabled: boolean;
    exists: boolean;
    wasDisabled?: boolean;
    /** Tencent status 3 means the account has not been activated yet. */
    unactivated?: boolean;
  }) {
    if (!p.phone && !p.exists)
      throw new BadRequestException(
        "创建腾讯会议企业用户需要手机号，请开通飞书手机号读取权限或手动补充",
      );
    const body = {
      operator_id: this.operator,
      operator_id_type: 1,
      userid: p.id,
      username: p.name,
      // Tencent does not allow changing phone/email on an existing user.
      ...(!p.exists
        ? {
            email: p.email || undefined,
            ...tencentPhone(p.phone),
          }
        : {}),
      department_list: p.departmentIds.length
        ? p.departmentIds.slice(0, 1)
        : undefined,
      ...(p.advanced !== undefined
        ? {
            user_account_type: p.advanced
              ? Number(
                  this.connections.get("tencent-meeting").advancedType || 9,
                )
              : 2,
          }
        : {}),
      ...(!p.exists ? { auto_invite: false } : {}),
    };
    await this.request(
      p.exists ? "/v1/users/" + encodeURIComponent(p.id) : "/v1/users",
      p.exists ? "PUT" : "POST",
      body,
    );
    // The enable endpoint only accepts a real state transition. Calling it
    // for every existing active user makes Tencent return 60005/20005/500133.
    const shouldToggleStatus = !p.unactivated && (p.exists
      ? p.wasDisabled !== undefined && p.wasDisabled !== p.disabled
      : p.disabled);
    if (shouldToggleStatus)
      await this.request(
        "/v1/users/" + encodeURIComponent(p.id) + "/enable",
        "PUT",
        {
          operator_id: this.operator,
          operator_id_type: 1,
          enable: !p.disabled,
        },
      );
  }
  async createMeeting(
    p: {
      subject: string;
      startAt: string;
      endAt: string;
      recordingEnabled: boolean;
      inviteeIds: string[];
      /** Tencent calls these users `hosts` during reservation.  The API does
       * not expose a reservation-time `cohosts` field; cohost control remains
       * a separate in-meeting operation. */
      hostIds?: string[];
    },
    account: {
      accountId: string;
      secretId?: string | null;
      secretKey?: string | null;
    },
  ) {
    const data = await this.request(
      "/v1/meetings",
      "POST",
      {
        userid: account.accountId,
        instanceid: 1,
        type: 0,
        subject: p.subject,
        start_time: String(Math.floor(Date.parse(p.startAt) / 1000)),
        end_time: String(Math.floor(Date.parse(p.endAt) / 1000)),
        time_zone: "Asia/Shanghai",
        hosts: [...new Set([account.accountId, ...(p.hostIds || [])])].map(
          (userid) => ({ userid }),
        ),
        invitees: p.inviteeIds.map((userid) => ({ userid })),
        settings: {
          auto_record_type: p.recordingEnabled ? "cloud" : "none",
          participant_join_auto_record: p.recordingEnabled,
        },
      },
      account,
    );
    const meeting = data.meeting_info_list?.[0];
    if (!meeting?.meeting_id)
      throw new PlatformError("腾讯会议", "NO_MEETING_ID", true);
    return {
      id: String(meeting.meeting_id),
      code: meetingCode(meeting),
      url: meetingJoinUrl(meeting.join_url),
      response: tencentMeetingResponse(data, meeting),
    };
  }

  async updateMeeting(
    id: string,
    p: {
      subject: string;
      startAt: string;
      endAt: string;
      inviteeIds?: string[];
      recordingEnabled?: boolean;
    },
    account: {
      accountId: string;
      secretId?: string | null;
      secretKey?: string | null;
    },
  ) {
    await this.request(
      "/v1/meetings/" + encodeURIComponent(id),
      "PUT",
      {
        userid: account.accountId,
        instanceid: 1,
        subject: p.subject,
        start_time: String(Math.floor(Date.parse(p.startAt) / 1000)),
        end_time: String(Math.floor(Date.parse(p.endAt) / 1000)),
        time_zone: "Asia/Shanghai",
        ...(p.inviteeIds
          ? { invitees: p.inviteeIds.map((userid) => ({ userid })) }
          : {}),
        ...(p.recordingEnabled !== undefined
          ? {
              settings: {
                auto_record_type: p.recordingEnabled ? "cloud" : "none",
                participant_join_auto_record: p.recordingEnabled,
              },
            }
          : {}),
      },
      account,
    );
  }
  async cancel(
    id: string,
    account: {
      accountId: string;
      secretId?: string | null;
      secretKey?: string | null;
    },
  ) {
    try {
      await this.request(
        "/v1/meetings/" + encodeURIComponent(id) + "/cancel",
        "POST",
        {
          userid: account.accountId,
          instanceid: 1,
          reason_code: 1,
          reason_detail: "agenda-link 取消预约",
        },
        account,
      );
    } catch (error) {
      // An explicit already-cancelled response is conclusive even if a
      // subsequent meeting lookup would fail or is no longer available.
      if (isAlreadyCancelled(error)) return;
      try {
        const data = await this.request(
          "/v1/meetings/" +
            encodeURIComponent(id) +
            "?" +
            new URLSearchParams({ userid: account.accountId, instanceid: "1" }),
          "GET",
          undefined,
          account,
        );
        if (
          data.meeting_info_list?.[0]?.meeting_state !==
          "MEETING_STATE_CANCELLED"
        )
          throw error;
      } catch (lookupError) {
        // Tencent returns error 9007 (with the typo “CANCLED”) when a meeting
        // has already been cancelled, including when it was deleted manually
        // in the Tencent console. Cancellation is idempotent, so this is a
        // successful end state and should not leave the local job retrying.
        if (!isAlreadyCancelled(lookupError)) throw error;
      }
    }
  }
  async realtimeParticipants(
    id: string,
    account: {
      accountId: string;
      secretId?: string | null;
      secretKey?: string | null;
    },
  ) {
    const participants: any[] = [];
    let status: string | undefined;
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
      const d = await this.request(
        "/v1/meetings/" +
          encodeURIComponent(id) +
          "/real-time-participants?" +
          new URLSearchParams({
            operator_id: account.accountId,
            operator_id_type: "1",
            page: String(page),
            page_size: "50",
          }),
        "GET",
        undefined,
        account,
      );
      if (page === 1) {
        status = String(d.status ?? "");
        lastPage = Number(d.total_page);
      }
      if (
        !Number.isSafeInteger(lastPage) ||
        lastPage < 0 ||
        lastPage > 10000 ||
        (d.current_page !== undefined &&
          Number(d.current_page) !== page &&
          !(page === 1 && lastPage === 0 && Number(d.current_page) === 0)) ||
        (lastPage === 0 && (d.participants?.length || 0) > 0) ||
        (d.participants !== undefined && !Array.isArray(d.participants))
      )
        throw new PlatformError("腾讯会议", "INVALID_PAGINATION");
      participants.push(...(d.participants || []));
    }
    return { participants, status };
  }
  async cohost(
    id: string,
    creator: { userid: string; instanceid: number },
    target: { ms_open_id: string; instanceid: number },
    account: { secretId?: string | null; secretKey?: string | null },
  ) {
    await this.request(
      "/v1/real-control/meetings/" + encodeURIComponent(id) + "/cohosts",
      "PUT",
      {
        operator_id: creator.userid,
        operator_id_type: 1,
        instanceid: creator.instanceid,
        action: true,
        user: {
          to_operator_id: target.ms_open_id,
          to_operator_id_type: 4,
          instanceid: target.instanceid,
        },
      },
      account,
    );
  }
  async recordingFiles(
    meeting: {
      externalMeetingId: string | null;
      startAt: string;
      endAt: string;
    },
    account: {
      accountId: string;
      secretId?: string | null;
      secretKey?: string | null;
    },
    options: { requireComplete?: boolean } = {},
  ): Promise<StoredFile[]> {
    const q = new URLSearchParams({
      userid: account.accountId,
      meeting_id: meeting.externalMeetingId!,
      start_time: String(Math.floor(Date.parse(meeting.startAt) / 1000)),
      end_time: String(
        Math.floor((Date.parse(meeting.endAt) + 86400000) / 1000),
      ),
      page_size: "20",
      page: "1",
    });
    const records = new Map<string, any>();
    for (let page = 1; ; page++) {
      q.set("page", String(page));
      const list = await this.request(
        "/v1/records?" + q,
        "GET",
        undefined,
        account,
      );
      const items = list.record_meetings ?? [];
      const pages = Number(list.total_page ?? 1);
      if (
        !Array.isArray(items) ||
        !Number.isSafeInteger(pages) ||
        pages < 0 ||
        pages > 1000 ||
        (list.current_page != null &&
          Number(list.current_page) !== page &&
          !(pages === 0 && !items.length))
      )
        throw new BadRequestException("腾讯会议返回了无效的录制分页数据");
      for (const record of items) {
        if (
          !record.meeting_record_id ||
          (record.meeting_id &&
            String(record.meeting_id) !== meeting.externalMeetingId)
        )
          throw new BadRequestException("腾讯会议返回了不匹配的录制数据");
        records.set(String(record.meeting_record_id), record);
      }
      if (page >= pages) break;
      if (!items.length)
        throw new BadRequestException("腾讯会议录制分页数据不完整");
    }
    const files = new Map<string, StoredFile>();
    for (const record of records.values()) {
      // Addresses are available after transcoding; this endpoint is not paginated.
      if (record.state != null && Number(record.state) !== 3) {
        if (options.requireComplete)
          throw new BadRequestException("腾讯会议正在生成录制，请稍后删除");
        continue;
      }
      const data = await this.request(
        "/v1/addresses?" +
          new URLSearchParams({
            meeting_record_id: String(record.meeting_record_id),
            userid: account.accountId,
          }),
        "GET",
        undefined,
        account,
      );
      if (
        data.meeting_id &&
        String(data.meeting_id) !== meeting.externalMeetingId
      )
        throw new BadRequestException("腾讯会议返回了不匹配的录制地址");
      if (data.record_files != null && !Array.isArray(data.record_files))
        throw new BadRequestException("腾讯会议返回了无效的录制文件列表");
      const addresses = new Map<string, any>(
        (data.record_files || []).map((f: any) => [
          String(f.record_file_id),
          f,
        ]),
      );
      // Keep file IDs even when sharing/download is disabled, so deletion still works.
      for (const f of [
        ...(record.record_files || []),
        ...(data.record_files || []),
      ]) {
        if (!f.record_file_id) continue;
        const id = String(f.record_file_id),
          address = addresses.get(id) || {};
        const view = address.view_address || f.sharing_url;
        const share = f.sharing_url;
        const download = address.download_address;
        files.set(id, {
          id,
          viewUrl: view ? recordingUrl(view) : undefined,
          shareUrl: share ? recordingUrl(share) : undefined,
          url: download ? recordingUrl(download) : undefined,
          extension: address.download_address_file_type || "mp4",
        });
      }
    }
    return [...files.values()];
  }
  async deleteRecording(
    id: string,
    meetingId: string,
    account: {
      accountId: string;
      secretId?: string | null;
      secretKey?: string | null;
    },
  ) {
    await this.request(
      "/v1/records/" +
        encodeURIComponent(id) +
        "?" +
        new URLSearchParams({
          meeting_id: meetingId,
          userid: account.accountId,
        }),
      "DELETE",
      undefined,
      account,
    );
  }
}
