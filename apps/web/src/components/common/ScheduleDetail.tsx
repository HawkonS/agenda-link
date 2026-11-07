import { Copy, FileVideo, MapPin, Users } from "lucide-react";
import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { request } from "../../api";
import { copyText } from "../../lib/clipboard";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { ScheduleRecordings } from "./ScheduleRecordings";
import { cohostDetail } from "../../lib/meeting-cohost";
import { Button } from "../ui/button";
import { ErrorBanner, Status } from "./workspace";

type Attendee = {
  id?: number;
  displayName?: string;
  email?: string | null;
  userId?: string;
  openId?: string;
  cohostStatus?: string;
  cohostError?: string | null;
};
export type ScheduleDetailData = {
  id?: number;
  recordingEnabled?: boolean;
  platformName?:string;calendarPlatformName?:string|null;calendarConnectionId?:string|null;calendarStatus?:string;
  subject: string;
  status: string;
  startAt: string;
  endAt: string;
  calendarDescription?: string | null;
  location?: string | null;
  meetingCode?: string | null;
  externalMeetingId?: string | null;
  provisionStep?: string;
  meetingUrl?: string | null;
  hostAccountName?: string | null;
  hostAccountId?: string | null;
  allocationSource?: string;
  accountPoolName?: string | null;
  attendees?: Attendee[];
  attendeeEmails?: string[];
  error?: string | null;
};

/** Each platform advances independently; a Tencent success must survive a Feishu failure. */
function PlatformStatus({
  data,
  meeting,
}: {
  data: ScheduleDetailData;
  meeting: boolean;
}) {
  const labels: Record<string, string> = {
    provisioning: "预约中",
    pending: "预约中",
    scheduled: "已预约",
    synced: "已预约",
    finished: "已结束",
    failed: "预约失败",
    unknown: "待核对",
    cancelling: "取消中",
    cancel_failed: "取消失败",
    cancelled: "已取消",
    not_created: "未预约",
  };
  const meetingCreated = !!(data.externalMeetingId || data.meetingCode);
  let remoteMeetingStatus = data.status;
  let feishu = data.status;
  if (meeting) {
    if (["provisioning", "failed"].includes(data.status)) {
      remoteMeetingStatus = meetingCreated ? "scheduled" : data.status;
      feishu =
        data.status === "provisioning"
          ? "pending"
          : meetingCreated
            ? "failed"
            : "not_created";
    } else if (data.status === "unknown") feishu = "not_created";
    else if (data.status === "finished") {
      remoteMeetingStatus = "scheduled";
      feishu = "synced";
    }
    if (
      ["cancelling", "cancel_failed"].includes(data.status) &&
      data.provisionStep === "meeting_cancelled"
    )
      remoteMeetingStatus = "cancelled";
  }
  return (
    <div
      className="schedule-detail-badges"
      role="status"
      aria-label="预约状态"
      aria-live="polite"
      aria-atomic="true"
    >
      {meeting && data.status === "finished" && (
        <Status value="finished" label="已结束 · 本系统" />
      )}
      {meeting && (
        <Status
          value={remoteMeetingStatus}
          label={`${labels[remoteMeetingStatus] || remoteMeetingStatus} · ${data.platformName || "会议平台"}`}
        />
      )}
      {(!meeting || data.calendarConnectionId !== null) && <Status value={feishu} label={`${labels[feishu] || feishu} · ${meeting ? data.calendarPlatformName || "日程平台" : data.platformName || "日程平台"}日程`} />}
    </div>
  );
}

/** Feishu notes are plain text. Linkify URLs without interpreting HTML. */
function localizeIsoTimestamps(value: string) {
  return value.replace(
    /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z\b/g,
    (match, year, month, day, hour, minute, second) => {
      const date = new Date(
        year + "-" + month + "-" + day + "T" + hour + ":" + minute + ":" + (second || "00") + "Z",
      );
      if (!Number.isFinite(date.getTime())) return match;
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      }).format(date);
    },
  );
}

function DescriptionText({ value }: { value: string }) {
  const parts = localizeIsoTimestamps(value).split(
    /(https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef]+)/g,
  );
  return (
    <>
      {parts.map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a key={index} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function scheduleTimeSummary(startAt: string, endAt: string) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    return "";
  const date = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  const clock = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  const short = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  const duration =
    minutes > 0
      ? `${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时` : ""}${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`
      : "";
  const sameDay = start.toDateString() === end.toDateString();
  return `${date.format(start)} — ${sameDay ? clock.format(end) : short.format(end)}${duration ? ` · ${duration}` : ""}`;
}
export function ScheduleDetail({
  data,
  meeting,
  loading,
  failed,
  retry,
}: {
  data: ScheduleDetailData;
  meeting: boolean;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}) {
  const description = data.calendarDescription;
  const recordingQuery = useQuery<Array<{
    id: number;
    status: string;
    expiresAt: string | null;
    files: { id: string; viewUrl?: string }[];
  }>>({
    queryKey: ["schedule-recordings", data.id],
    queryFn: () => request(`/meetings/${data.id}/recordings`),
    enabled: meeting && data.id !== undefined,
    refetchInterval: 10000,
  });
  const recordingFile = recordingQuery.data
    ?.filter((recording) => recording.status === "ready")
    .flatMap((recording) => recording.files || [])
    .find((file) => Boolean(file.viewUrl));
  const attendees = [...(data.attendees || [])];
  for (const email of data.attendeeEmails || []) {
    if (
      !attendees.some(
        (person) => person.email?.toLowerCase() === email.toLowerCase(),
      )
    )
      attendees.push({ email });
  }
  return (
    <div className="schedule-detail">
      <div className="schedule-detail-summary">
        <PlatformStatus data={data} meeting={meeting} />
        <div className="schedule-detail-summary-actions">
          {meeting && data.id !== undefined && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!recordingFile?.viewUrl}
                  title={
                    recordingFile?.viewUrl ? "查看云录制" : "暂无可用云录制"
                  }
                >
                  <FileVideo />
                  云录制
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="schedule-recording-popover"
              >
                <ScheduleRecordings
                  meetingId={data.id}
                  subject={data.subject}
                  endAt={data.endAt}
                  enabled={data.recordingEnabled === true}
                />
              </PopoverContent>
            </Popover>
          )}
          {meeting && data.meetingUrl && data.status !== "cancelled" && (
            <Button asChild size="sm">
              <a
                href={data.meetingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                进入会议
              </a>
            </Button>
          )}
        </div>
      </div>
      {data.error && <ErrorBanner message={data.error} />}
      <div className="schedule-detail-layout schedule-detail-layout--split">
        <div className="schedule-detail-main">
          {meeting && (
          <section className="schedule-detail-overview" aria-label="日程信息">
              <dl className="schedule-detail-facts">
                <div className="schedule-detail-meeting-number">
                  <dt>会议号</dt>
                  <dd className="schedule-detail-code">
                    <span
                      className={
                        data.meetingCode
                          ? ""
                          : "schedule-detail-code-pending"
                      }
                    >
                      {data.meetingCode || "等待生成"}
                    </span>
                    {data.meetingCode && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="复制会议号"
                        onClick={() =>
                          void copyText(data.meetingCode!, "会议号")
                        }
                      >
                        <Copy />
                      </Button>
                    )}
                  </dd>
                </div>
                <div className="schedule-detail-host">
                  <dt>主持账号</dt>
                  <dd>
                    {data.hostAccountName || data.hostAccountId || "等待分配"}
                  </dd>
                </div>
              </dl>
          </section>
          )}

          <section
            className="calendar-detail-description"
            aria-labelledby="schedule-description-title"
            aria-busy={loading}
          >
            <div className="calendar-detail-description-heading">
              <h3 id="schedule-description-title">日程说明</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading || failed || !description?.trim()}
                onClick={() =>
                  description && void copyText(description, "日程说明")
                }
              >
                <Copy />
                复制说明
              </Button>
            </div>
            {loading ? (
              <div className="schedule-detail-placeholder" role="status">
                加载说明…
              </div>
            ) : failed ? (
              <div className="schedule-detail-placeholder">
                <ErrorBanner message="日程详情加载失败" retry={retry} />
              </div>
            ) : (
              <div className="calendar-detail-description-content">
                {description?.trim() ? (
                  <DescriptionText value={description} />
                ) : (
                  <span className="schedule-detail-empty">暂无说明</span>
                )}
              </div>
            )}
          </section>

          {data.location && (
            <div className="schedule-detail-location">
              <MapPin aria-hidden="true" />
              <span>{data.location}</span>
            </div>
          )}
        </div>
        <section
          className="schedule-detail-attendees"
          aria-labelledby="schedule-attendees-title"
        >
          <h3 id="schedule-attendees-title">
            <Users aria-hidden="true" />
            参会人
            <span>{attendees.length}</span>
          </h3>
          {attendees.length ? (
            <ul>
              {attendees.map((person, index) => {
                const role =
                  meeting && person.cohostStatus
                    ? cohostDetail(
                        { ...person, cohostStatus: person.cohostStatus },
                        data,
                      )
                    : undefined;
                const name = person.displayName || person.email || "飞书参会人";
                return (
                  <li key={person.id ?? index}>
                    <span
                      className="schedule-detail-person-icon"
                      aria-hidden="true"
                    >
                      {name.slice(0, 1)}
                    </span>
                    <div className="schedule-detail-person">
                      <span title={name}>{name}</span>
                      {role &&
                        role.reason !== "—" &&
                        !["host", "applied", "preassigned_host"].includes(
                          role.status,
                        ) && (
                          <div className="schedule-detail-person-note">
                            {role.reason}
                          </div>
                        )}
                    </div>
                    {role && role.status !== "not_applicable" && (
                      <Status value={role.status} />
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="schedule-detail-attendees-empty">暂无参会人</p>
          )}
        </section>
      </div>
    </div>
  );
}
