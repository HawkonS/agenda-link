import { Link } from "react-router-dom";
import {
  ArrowRight,
  CalendarDays,
  FileVideo,
  Layers3,
  Plus,
  Copy,
  Users,
  Video,
} from "lucide-react";
import { copyText } from "../lib/clipboard";
import { getSummary } from "../api";
import { usePage } from "../lib/hooks";
import { useSession } from "../lib/session";
import { time } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Panel, QueryState, DataTable } from "../components/common/workspace";
import { FinishMeetingButton } from "../components/common/FinishMeetingButton";
export default function Dashboard() {
  const { user, isOperator } = useSession(),
    q = usePage("dashboard", getSummary, true);
  const hour = new Date().getHours(),
    greeting =
      hour < 5
        ? "夜深了"
        : hour < 12
          ? "早上好"
          : hour < 14
            ? "中午好"
            : hour < 18
              ? "下午好"
              : "晚上好";
  const data = q.data || {};
  const meetingTime = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "时间待定";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  };
  const cards = [
    {
      label: "会议预约",
      value: data.meetings || 0,
      icon: Video,
      to: "/calendar?tab=list",
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: "会议录制",
      value: data.recordings || 0,
      icon: FileVideo,
      to: "/calendar?tab=list",
      color: "text-violet-600 bg-violet-50",
      description: "仅统计未取消会议中可播放的录制",
    },
    ...(isOperator
      ? [
          {
            label: "飞书人员",
            value: data.feishuPeople || 0,
            icon: Users,
            to: "/user-sync",
            color: "text-emerald-600 bg-emerald-50",
          },
          {
            label: "账号资源",
            value: data.accountPools || 0,
            icon: Layers3,
            to: "/account-pools",
            color: "text-amber-600 bg-amber-50",
          },
        ]
      : []),
  ];
  return (
    <div className="page-shell page-shell--dashboard">
      <div className="dashboard-hero flex items-start justify-between gap-4 flex-wrap">
        <div className="dashboard-welcome">
          <h1 className="text-[25px] font-semibold tracking-tight">
            {greeting}，{user?.displayName || user?.username}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            欢迎回到工作台，安排好下一次高效协作。
          </p>
        </div>
        <Button asChild className="dashboard-booking-action">
          <Link to="/meetings?create=1">
            <Plus />
            会议预约
          </Link>
        </Button>
      </div>
      <QueryState
        loading={q.isLoading}
        error={q.isError}
        retry={() => void q.refetch()}
      >
        <div className="dashboard-kpi-grid">
          {cards.map((c) => (
            <Link
              key={c.label}
              to={c.to}
              className="surface kpi p-5"
              title={c.description}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{c.label}</span>
                <span
                  className={`grid h-8 w-8 place-items-center rounded-lg ${c.color}`}
                >
                  <c.icon className="h-4 w-4" />
                </span>
              </div>
              <div className="mt-3 text-3xl font-semibold tracking-tight">
                {c.value}
              </div>
              <div className="mt-2 flex justify-end text-xs text-muted-foreground">
                <ArrowRight className="h-3 w-3" />
              </div>
            </Link>
          ))}
        </div>
        <div className="dashboard-content-grid">
          <Panel
            className="dashboard-upcoming-panel"
            title="接下来的会议"
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/calendar?tab=list">
                  全部会议
                  <ArrowRight />
                </Link>
              </Button>
            }
          >
            <div
              className={
                data.upcoming?.length
                  ? "dashboard-meeting-table"
                  : "dashboard-meeting-empty"
              }
            >
              <DataTable
                rows={data.upcoming || []}
                columns={[
                  {
                    key: "subject",
                    title: "会议主题",
                    width: 190,
                    render: (r: any) => (
                      <span className="font-medium">{r.subject}</span>
                    ),
                  },
                  {
                    key: "start",
                    title: "开始时间",
                    width: 140,
                    render: (r: any) => (
                      <span className="text-xs text-muted-foreground">
                        {meetingTime(r.startAt)}
                      </span>
                    ),
                  },
                  {
                    key: "link",
                    title: "会议入口",
                    width: 100,
                    render: (r: any) =>
                      r.capabilities?.online === false ? (
                        <span className="text-xs text-muted-foreground">
                          无在线会议
                        </span>
                      ) : r.meetingUrl ? (
                        <a
                          href={r.meetingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-primary"
                        >
                          进入会议 ↗
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          等待平台确认
                        </span>
                      ),
                  },
                  {
                    key: "actions",
                    title: "操作",
                    width: 210,
                    render: (r: any) => {
                      const copyValue = r.meetingUrl || r.meetingCode;
                      return (
                        <div className="row-actions">
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/calendar?meeting=${r.id}`}>
                              查看详情
                            </Link>
                          </Button>
                          {r.capabilities?.online !== false && (
                            <FinishMeetingButton meeting={r} />
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={r.meetingUrl ? "复制会议链接" : "复制会议号"}
                            title={r.meetingUrl ? "复制会议链接" : "复制会议号"}
                            disabled={!copyValue}
                            onClick={() =>
                              copyValue &&
                              void copyText(
                                copyValue,
                                r.meetingUrl ? "会议链接" : "会议号",
                              )
                            }
                          >
                            <Copy />
                          </Button>
                        </div>
                      );
                    },
                  },
                ]}
                emptyTitle="还没有即将开始的会议"
                emptyHint=""
                emptyClassName="dashboard-empty-state"
                emptyAction={
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/meetings?create=1">
                      <Plus />
                      预约第一场会议
                    </Link>
                  </Button>
                }
              />
            </div>
            {!!data.upcoming?.length && (
              <ul className="dashboard-meeting-list" aria-label="接下来的会议">
                {data.upcoming.map((meeting: any) => (
                  <li key={meeting.id}>
                    <div className="dashboard-meeting-copy">
                      <h3>{meeting.subject}</h3>
                      <time dateTime={meeting.startAt}>
                        {meetingTime(meeting.startAt)}
                      </time>
                    </div>
                    <div className="dashboard-meeting-actions">
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/calendar?meeting=${meeting.id}`}>
                          详情
                        </Link>
                      </Button>
                      {meeting.capabilities?.online !== false &&
                        (meeting.meetingUrl ? (
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            className="dashboard-meeting-enter"
                          >
                            <a
                              href={meeting.meetingUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              进入会议
                            </a>
                          </Button>
                        ) : (
                          <span className="dashboard-meeting-note">
                            等待平台确认
                          </span>
                        ))}
                      {meeting.capabilities?.online !== false && (
                        <FinishMeetingButton
                          meeting={meeting}
                          variant="ghost"
                          label="结束"
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel className="dashboard-quick-panel" title="快速开始">
            <div className="px-5 py-2">
              {[
                {
                  to: "/meetings?create=1",
                  title: "会议预约",
                  icon: Video,
                },
                {
                  to: "/calendar",
                  title: "我的日程",
                  icon: CalendarDays,
                },
                {
                  to: "/calendar?tab=list",
                  title: "会议录制",
                  icon: FileVideo,
                },
              ].map((c) => (
                <Link
                  to={c.to}
                  key={c.title}
                  className="group flex items-center gap-3 py-4 border-b last:border-0"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-muted text-[#7a899d]">
                    <c.icon className="h-4 w-4" />
                  </span>
                  <div className="flex-1">
                    <div className="text-xs font-medium group-hover:text-primary">
                      {c.title}
                    </div>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                </Link>
              ))}
            </div>
          </Panel>
        </div>
      </QueryState>
    </div>
  );
}
