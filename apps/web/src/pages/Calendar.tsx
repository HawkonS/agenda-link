import { useQuery } from "@tanstack/react-query";
import { ScheduleDetail, scheduleTimeSummary } from "../components/common/ScheduleDetail";
import { FinishMeetingButton } from "../components/common/FinishMeetingButton";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { OptionSelect } from "../components/common/OptionSelect";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, SlidersHorizontal } from "lucide-react";
import { request } from "../api";
import { usePage, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { useWorkspaceTabs } from "../lib/workspace-tabs";
import { time } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  Panel,
  QueryState,
  Modal,
  TextField,
  DataTable,
  Status,
  Confirm,
  SearchBox,
  TableSelectionHeader,
} from "../components/common/workspace";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
function PersonPicker({
  value,
  onChange,
  owners,
  user,
  canViewOthers,
  mode,
  showLabel = true,
}: {
  value: string;
  onChange: (value: string) => void;
  owners: any[];
  user: any;
  canViewOthers: boolean;
  mode: "owner" | "participant";
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const options =
    mode === "participant"
      ? [
          { value: "", label: "全部参与人" },
          ...(user
            ? [
                {
                  value: String(user.id),
                  label: user.displayName
                    ? `我自己（${user.displayName}）`
                    : "我自己",
                },
              ]
            : []),
          ...owners
            .filter((owner: any) => owner.id !== user?.id)
            .map((owner: any) => ({
              value: String(owner.id),
              label: owner.name,
            })),
        ]
      : [
          { value: "self", label: user?.displayName ? `我自己（${user.displayName}）` : "我自己" },
          ...(canViewOthers ? [{ value: "all", label: "全部预约人" }] : []),
          ...owners
            .filter((owner: any) => owner.id !== user?.id)
            .map((owner: any) => ({
              value: String(owner.id),
              label: owner.name,
            })),
        ];
  const current = options.find((option) => option.value === value);
  const filtered = options.filter((option) =>
    option.label.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="calendar-owner-trigger">
          <span className="truncate">
            {showLabel && `${mode === "participant" ? "参与人" : "预约人"}：`}
            {current?.label || (mode === "participant" ? "全部参与人" : "全部预约人")}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="owner-picker-popover" align="start">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="搜索预约人"
        />
        <div className="owner-picker-list">
          {filtered.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`owner-picker-option ${option.value === value ? "is-active" : ""}`}
              title={option.label}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                setSearch("");
              }}
            >
              {option.label}
            </button>
          ))}
          {!filtered.length && <span className="owner-picker-empty">没有匹配的人</span>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function Calendar({capability="calendar"}:{capability?:"calendar"|"meeting"}={}) {
  const [platformFilter,setPlatformFilter]=useState("");
  const platforms=usePage("platforms",()=>request("/platforms"));
  const platformOptions=(Array.isArray(platforms.data)?platforms.data:[]).filter((p:any)=>p.capability===capability);
  const location = useLocation();
  const { activeTab } = useWorkspaceTabs();
  const { user, isOperator, isAdmin } = useSession();
  const [ownerFilter, setOwnerFilter] = useState("self");
  const [participantFilter, setParticipantFilter] = useState("");
  const canViewOthers = isOperator || isAdmin;
  const owners = usePage("calendar-owners", () =>
    canViewOthers ? request("/calendar-owners") : Promise.resolve([]),
  );
  const ownerQuery = [
    canViewOthers ? `owner=${encodeURIComponent(ownerFilter)}` : "",
    participantFilter ? `participant=${encodeURIComponent(participantFilter)}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const q = usePage(
      ownerFilter === "self" && !participantFilter
        ? "calendar"
        : `calendar-${ownerFilter}-${participantFilter}`,
      async () => {
        const query = ownerQuery ? `?${ownerQuery}` : "";
        const [events, meetings] = await Promise.all([
          request("/calendar-events" + query),
          request("/meetings" + query),
        ]);
        return { events, meetings };
      },
      (data) =>
        [...(data?.events || []), ...(data?.meetings || [])].some((r) =>
          ["pending", "provisioning", "cancelling"].includes(r.status),
        )
          ? 1000
          : 10000,
    ),
    { saving, act } = useAction();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams(),
    [month, setMonth] = useState(
      () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    ),
    [selected, setSelected] = useState<number>(),
    [selectedRecords, setSelectedRecords] = useState<Set<string>>(new Set()),
    [statusFilter, setStatusFilter] = useState("active"),
    [query, setQuery] = useState(""),
    [filtersOpen, setFiltersOpen] = useState(false),
    [selectedMeeting, setSelectedMeeting] = useState<number>();
  const [recovering, setRecovering] = useState<any>(),
    [remoteId, setRemoteId] = useState("");
  const rows: any[] = q.data?.events || [],
    meetings: any[] = q.data?.meetings || [],
    detailRow =
      selectedMeeting !== undefined
        ? meetings.find((r) => r.id === selectedMeeting)
        : rows.find((r) => r.id === selected);
  const detailId = selectedMeeting ?? selected;
  const detailKind =
    selectedMeeting !== undefined ? "meetings" : "calendar-events";
  const detailQuery = useQuery({
    queryKey: ["calendar-detail", detailKind, detailId],
    queryFn: () => request(`/${detailKind}/${detailId}`),
    enabled: detailId !== undefined,
    staleTime: 0,
    refetchInterval: (query) =>
      ["pending", "provisioning", "cancelling"].includes(
        query.state.data?.status,
      )
        ? 1000
        : 10000,
  });
  const detailData = detailQuery.data
    ? { ...detailRow, ...detailQuery.data }
    : detailRow;
  const justCreated =
    location.state?.createdSchedule === true &&
    (params.get("meeting") === String(detailId) ||
      params.get("event") === String(detailId));
  useEffect(() => {
    setFiltersOpen(false);
  }, [activeTab]);
  useEffect(() => {
    if (!justCreated || !detailData?.startAt) return;
    const start = new Date(detailData.startAt);
    if (Number.isFinite(start.getTime()))
      setMonth(new Date(start.getFullYear(), start.getMonth(), 1));
  }, [justCreated, detailData?.startAt]);
  const mode = capability==="meeting" || activeTab === "list" ? "list" : "month";
  const visible = (r: any) =>
    statusFilter === "all" ||
    (statusFilter === "cancelled"
      ? r.status === "cancelled"
      : r.status !== "cancelled");
  const activeFilterCount =
    (ownerFilter !== "self" ? 1 : 0) +
    (participantFilter ? 1 : 0) +
    (platformFilter ? 1 : 0) +
    (statusFilter !== "active" ? 1 : 0);
  const ownerName = (id: number) =>
    (owners.data as any[] | undefined)?.find((owner) => owner.id === id)?.name ||
    (id === user?.id ? user?.displayName : "") ||
    "系统";
  const agenda = [
    ...(capability==="meeting" ? [] : rows).map((row) => ({ ...row, itemType: "event" as const })),
    ...meetings.map((row) => ({ ...row, itemType: "meeting" as const })),
  ]
    .filter(row=>!platformFilter || (capability==="meeting" ? row.connectionId : row.itemType==="meeting" ? (row.calendarConnectionId || "system-calendar") : row.connectionId)===platformFilter)
    .filter(visible)
    .filter((row) => {
      if (!query.trim()) return true;
      const text = `${row.subject || ""} ${ownerName(row.createdBy)} ${row.platformName || ""}`;
      return text.toLowerCase().includes(query.toLowerCase());
    })
    .sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
    );

  const calendarRowKey = (row: any) =>
    `${row.itemType === "meeting" ? "meeting" : "event"}:${row.id}`;
  const selectedRows = agenda.filter((row) =>
    selectedRecords.has(calendarRowKey(row)),
  );
  const allSelectedCancelled =
    selectedRows.length > 0 &&
    selectedRows.every((row) => row.status === "cancelled");
  const deleteSelected = async () => {
    for (const row of selectedRows)
      await request(
        `/${row.itemType === "meeting" ? "meetings" : "calendar-events"}/${row.id}`,
        "DELETE",
      );
    setSelectedRecords(new Set());
    await q.refetch();
  };
  useEffect(() => {
    const kind = params.has("meeting") ? "meeting" : "event";
    const raw = params.get(kind);
    const scheduleId = Number(raw);
    if (
      raw &&
      /^\d+$/.test(raw) &&
      Number.isSafeInteger(scheduleId) &&
      scheduleId > 0
    ) {
      setSelected(kind === "event" ? scheduleId : undefined);
      setSelectedMeeting(kind === "meeting" ? scheduleId : undefined);
    } else {
      setSelected(undefined);
      setSelectedMeeting(undefined);
    }
  }, [params]);
  function openEditMeeting(row: any) {
    closeDetail();
    navigate(`/meetings?edit=${row.id}`);
  }
  function closeDetail() {
    setSelected(undefined);
    setSelectedMeeting(undefined);
    if (params.has("meeting") || params.has("event")) {
      const next = new URLSearchParams(params);
      next.delete("meeting");
      next.delete("event");
      setParams(next, { replace: true, state: null });
    }
  }
  const begin = new Date(month.getFullYear(), month.getMonth(), 1);
  begin.setDate(begin.getDate() - ((begin.getDay() + 6) % 7));
  const days = Array.from(
    { length: 42 },
    (_, i) =>
      new Date(begin.getFullYear(), begin.getMonth(), begin.getDate() + i),
  );
  const today = new Date().toDateString();
  const actions = (r: any) => (
    <div className="row-actions">
      {r.status === "failed" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() =>
            void act(
              () => request(`/calendar-events/${r.id}/retry`, "POST"),
              "重试已排队",
            )
          }
        >
          重试
        </Button>
      )}
      {["pending", "synced", "failed", "cancel_failed"].includes(r.status) && (
        <Confirm
          title="取消日程"
          description="将同步取消飞书中的对应日程。"
          onConfirm={() =>
            act(
              () => request(`/calendar-events/${r.id}/cancel`, "POST"),
              "取消已排队",
            )
          }
        >
          {(show) => (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={saving}
              onClick={show}
            >
              {r.status === "cancel_failed" ? "重试取消" : "取消"}
            </Button>
          )}
        </Confirm>
      )}
      {isOperator && r.status === "cancelled" && (
        <Confirm
          title="删除日程记录"
          description="从平台日历和列表移除这条已取消日程。"
          onConfirm={() =>
            act(async () => {
              await request(`/calendar-events/${r.id}`, "DELETE");
              setSelected(undefined);
            }, "日程记录已删除")
          }
        >
          {(show) => (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={saving}
              onClick={show}
            >
              删除
            </Button>
          )}
        </Confirm>
      )}
    </div>
  );
  const meetingActions = (r: any, inDetail = false) => (
    <div className="row-actions">
      {!inDetail && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSelectedMeeting(r.id)}
        >
          详情
        </Button>
      )}
      {r.status === "scheduled" &&
        (isOperator || r.createdBy === user?.id) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openEditMeeting(r)}
          >
            {inDetail ? "修改信息" : "编辑"}
          </Button>
        )}
      {isAdmin && r.status === "unknown" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setRemoteId("");
            setRecovering(r);
            closeDetail();
          }}
        >
          核对结果
        </Button>
      )}
      {r.capabilities?.online !== false && (
        <FinishMeetingButton
          meeting={r}
          disabled={saving}
          label={inDetail ? "结束会议" : "结束"}
        />
      )}
      {(isOperator || r.createdBy === user?.id) && r.status === "failed" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() =>
            void act(
              () => request(`/meetings/${r.id}/retry`, "POST"),
              "重试已排队",
            )
          }
        >
          重试
        </Button>
      )}
      {(isOperator || r.createdBy === user?.id) &&
        [
          "provisioning",
          "scheduled",
          "finished",
          "failed",
          "cancel_failed",
        ].includes(r.status) && (
          <Confirm
            title="取消会议"
            description="取消后将取消平台会议及关联日程。"
            onConfirm={() =>
              act(
                () => request(`/meetings/${r.id}/cancel`, "POST"),
                "取消已排队",
              )
            }
          >
            {(show) => (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={saving}
                onClick={show}
              >
                {r.status === "cancel_failed"
                  ? "重试取消"
                  : inDetail
                    ? "取消会议"
                    : "取消"}
              </Button>
            )}
          </Confirm>
        )}
      {isOperator && r.status === "cancelled" && (
        <Confirm
          title="删除预约记录"
          description="从平台日历和列表移除这条已取消会议。已有录制继续按原保留期限处理。"
          onConfirm={() =>
            act(async () => {
              await request(`/meetings/${r.id}`, "DELETE");
              closeDetail();
            }, "预约记录已删除")
          }
        >
          {(show) => (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={saving}
              onClick={show}
            >
              删除
            </Button>
          )}
        </Confirm>
      )}
    </div>
  );
  const statusControl = (
    <OptionSelect
      value={statusFilter}
      onChange={setStatusFilter}
      label="日程状态"
      className="w-32"
      options={[
        { value: "active", label: "未取消" },
        { value: "cancelled", label: "已取消" },
        { value: "all", label: "全部状态" },
      ]}
    />
  );
  return (
    <div
      className="page-shell page-shell--calendar"
      id="workspace-panel"
      role="tabpanel"
      aria-labelledby={`workspace-tab-${activeTab}`}
    >
      <QueryState
        loading={q.isLoading}
        error={q.isError}
        retry={() => void q.refetch()}
      >
        <Panel className="calendar-events-panel">
          <h1 className="sr-only">日程</h1>
          <div className="calendar-toolbar">
            {mode === "month" ? (
              <div className="calendar-month-switcher">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="上个月"
                  onClick={() =>
                    setMonth(
                      new Date(month.getFullYear(), month.getMonth() - 1, 1),
                    )
                  }
                >
                  <ChevronLeft />
                </Button>
                <h2 className="calendar-month-label" aria-live="polite">
                  {month.getFullYear()} 年 {month.getMonth() + 1} 月
                </h2>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="下个月"
                  onClick={() =>
                    setMonth(
                      new Date(month.getFullYear(), month.getMonth() + 1, 1),
                    )
                  }
                >
                  <ChevronRight />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setMonth(
                      new Date(
                        new Date().getFullYear(),
                        new Date().getMonth(),
                        1,
                      ),
                    )
                  }
                >
                  今天
                </Button>
              </div>
            ) : (
              <div className="calendar-search-control">
                <SearchBox
                  value={query}
                  onChange={setQuery}
                  placeholder="搜索日程名称或预约人"
                />
              </div>
            )}
            <div className="calendar-toolbar-actions">
            <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="calendar-filter-trigger"
                >
                  <SlidersHorizontal />
                  筛选
                  {activeFilterCount > 0 && (
                    <span className="calendar-filter-count">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="calendar-filter-popover"
                onInteractOutside={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (target?.closest?.(".owner-picker-popover"))
                    event.preventDefault();
                }}
                onFocusOutside={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (target?.closest?.(".owner-picker-popover"))
                    event.preventDefault();
                }}
              >
                <div className="calendar-filter-panel">
                  {canViewOthers && (
                    <>
                      <label className="calendar-filter-field">
                        <span>预约人</span>
                        <PersonPicker
                          mode="owner"
                          showLabel={false}
                          value={ownerFilter}
                          onChange={(value) => {
                            setOwnerFilter(value);
                            setSelected(undefined);
                            setSelectedMeeting(undefined);
                          }}
                          owners={(owners.data as any[]) || []}
                          user={user}
                          canViewOthers={canViewOthers}
                        />
                      </label>
                      <label className="calendar-filter-field">
                        <span>参与人</span>
                        <PersonPicker
                          mode="participant"
                          showLabel={false}
                          value={participantFilter}
                          onChange={(value) => {
                            setParticipantFilter(value);
                            if (value && ownerFilter === "self")
                              setOwnerFilter("all");
                            setSelected(undefined);
                            setSelectedMeeting(undefined);
                          }}
                          owners={(owners.data as any[]) || []}
                          user={user}
                          canViewOthers={canViewOthers}
                        />
                      </label>
                    </>
                  )}
                  <label className="calendar-filter-field">
                    <span>平台</span>
                    <OptionSelect
                      label={
                        capability === "meeting" ? "会议平台" : "日程平台"
                      }
                      value={platformFilter}
                      onChange={setPlatformFilter}
                      options={[
                        { value: "", label: "全部平台" },
                        ...platformOptions.map((p: any) => ({
                          value: p.connectionId,
                          label: p.name,
                        })),
                      ]}
                    />
                  </label>
                  <label className="calendar-filter-field">
                    <span>状态</span>
                    {statusControl}
                  </label>
                  <div className="calendar-filter-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOwnerFilter("self");
                        setParticipantFilter("");
                        setPlatformFilter("");
                      }}
                    >
                      重置筛选
                    </Button>
                    <Button size="sm" onClick={() => setFiltersOpen(false)}>
                      完成
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
              <Button size="sm" asChild>
                <Link to="/meetings?create=1">
                  <Plus />
                  会议预约
                </Link>
              </Button>
            </div>
          </div>
          <div
            className={`calendar-panel-body ${mode === "month" ? "calendar-panel-body--month" : ""}`}
          >
            {mode === "month" ? (
              <>
                <div className="calendar-weekdays">
                  {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
                    (d) => (
                      <div key={d} className="calendar-weekday">
                        {d}
                      </div>
                    ),
                  )}
                </div>
                <div
                  className="calendar-month-grid"
                  style={{
                    gridTemplateRows: `repeat(${days.length / 7}, minmax(68px, 1fr))`,
                  }}
                >
                  {days.map((day) => (
                    <div
                      className={`cal-day ${day.getMonth() !== month.getMonth() ? "bg-muted/50" : ""}`}
                      key={day.toISOString()}
                    >
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${day.toDateString() === today ? "bg-primary text-white" : day.getMonth() !== month.getMonth() ? "text-slate-300" : "text-muted-foreground"}`}
                      >
                        {day.getDate()}
                      </span>
                      {agenda
                        .filter(
                          (r) =>
                            new Date(r.startAt).toDateString() ===
                            day.toDateString(),
                        )
                        .map((r) => (
                          <button
                            key={`${r.itemType}-${r.id}`}
                            type="button"
                            className={`cal-event ${r.itemType === "meeting" ? "cal-event--meeting" : ""} ${r.status === "cancelled" ? "opacity-40 line-through" : ""}`}
                            onClick={() =>
                              r.itemType === "meeting"
                                ? setSelectedMeeting(r.id)
                                : setSelected(r.id)
                            }
                            title={r.subject}
                          >
                            <span className="cal-event-time">
                              {new Date(r.startAt).toLocaleTimeString("zh-CN", {
                                hour: "2-digit",
                                minute: "2-digit",
                                hour12: false,
                              })}{" "}
                            </span>
                            <span className="cal-event-title">{r.subject}</span>
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <DataTable
                rows={agenda}
                getRowKey={(r) => `${r.itemType}-${r.id}`}
                emptyTitle="还没有日程安排"
                emptyHint="预约会议后，可在这里查看和管理。"
                columns={[
                  {
                    key: "select",
                    title: "选择",
                    width: 56,
                    header: (pageRows: any[], allRows: any[]) => (
                      <TableSelectionHeader
                        pageIds={pageRows.map(calendarRowKey)}
                        allIds={allRows.map(calendarRowKey)}
                        selectedIds={selectedRecords}
                        onChange={(next) =>
                          setSelectedRecords(
                            new Set([...next].map((value) => String(value))),
                          )
                        }
                      />
                    ),
                    render: (r: any) => (
                      <input
                        type="checkbox"
                        className="workspace-checkbox"
                        aria-label={`选择 ${r.subject}`}
                        checked={selectedRecords.has(calendarRowKey(r))}
                        onChange={(event) =>
                          setSelectedRecords((current) => {
                            const next = new Set(current);
                            if (event.target.checked)
                              next.add(calendarRowKey(r));
                            else next.delete(calendarRowKey(r));
                            return next;
                          })
                        }
                      />
                    ),
                  },
                  {
                    key: "subject",
                    title: "日程名称",
                    width: 220,
                    render: (r) => (
                      <button
                        className="calendar-list-subject"
                        title={r.subject}
                        onClick={() =>
                          r.itemType === "meeting"
                            ? setSelectedMeeting(r.id)
                            : setSelected(r.id)
                        }
                      >
                        {r.subject}
                      </button>
                    ),
                  },
                  {
                    key: "type",
                    title: "类别",
                    width: 100,
                    render: (r) =>
                      r.platformName || (r.itemType==="meeting"?"会议":"日程"),
                  },
                  {
                    key: "startAt",
                    title: "开始时间",
                    width: 140,
                    render: (r) => <span className="whitespace-nowrap text-xs">{time(r.startAt)}</span>,
                  },
                  {
                    key: "endAt",
                    title: "结束时间",
                    width: 140,
                    render: (r) => <span className="whitespace-nowrap text-xs">{time(r.endAt)}</span>,
                  },
                  {
                    key: "owner",
                    title: "预约人",
                    width: 100,
                    render: (r) => (
                      <span className="block truncate text-xs" title={ownerName(r.createdBy)}>
                        {ownerName(r.createdBy)}
                      </span>
                    ),
                  },
                  {
                    key: "status",
                    title: "状态",
                    width: 90,
                    className: "calendar-status-column",
                    render: (r) => <Status value={r.status} />,
                  },
                  {
                    key: "actions",
                    title: "操作",
                    width: 280,
                    render: (r) =>
                      r.itemType === "meeting" ? meetingActions(r) : actions(r),
                  },
                ]}
              />
            )}
          </div>
        </Panel>
      </QueryState>
          {selectedRows.length > 0 && (
            <div className="calendar-selection-dock" role="status">
              <span className="calendar-selection-count">
                已选 <strong>{selectedRows.length}</strong> 条
              </span>
              <span className="calendar-selection-divider" aria-hidden="true" />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedRecords(new Set())}
              >
                取消选择
              </Button>
              <Confirm
                title="删除所选记录"
                description={`将删除选中的 ${selectedRows.length} 条已取消记录。未取消的记录请先取消后再删除。`}
                onConfirm={deleteSelected}
              >
                {(show) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={!allSelectedCancelled || saving}
                    title={
                      allSelectedCancelled
                        ? undefined
                        : "仅已取消的记录可以删除"
                    }
                    onClick={show}
                  >
                    删除所选
                  </Button>
                )}
              </Confirm>
            </div>
          )}
      <Modal
        open={!!recovering}
        onClose={() => !saving && setRecovering(undefined)}
        title="核对会议创建结果"
      >
        <div className="space-y-5">
          <p>先在原会议平台中核对「{recovering?.subject}」是否已创建。</p>
          <TextField
            label="平台会议或预约 ID"
            value={remoteId}
            onChange={setRemoteId}
            placeholder="已创建时，填写平台返回的 meeting_id"
          />
          <Button
            disabled={saving || !remoteId.trim()}
            onClick={() =>
              void act(async () => {
                await request(`/meetings/${recovering.id}/reconcile`, "POST", {
                  externalMeetingId: remoteId.trim(),
                });
                setRecovering(undefined);
              }, "已关联会议，后续同步已排队")
            }
          >
            关联已创建的会议
          </Button>
          <div className="border-t pt-4">
            <Confirm
              title="确认平台未创建会议"
              description="只有确认原平台中不存在此会议时才能释放账号，避免重复预约或账号时间冲突。"
              onConfirm={() =>
                act(async () => {
                  await request(`/meetings/${recovering.id}/release`, "POST", {
                    confirmedNotCreated: true,
                  });
                  setRecovering(undefined);
                }, "已释放预约")
              }
            >
              {(show) => (
                <Button variant="outline" disabled={saving} onClick={show}>
                  确认未创建，释放预约
                </Button>
              )}
            </Confirm>
          </div>
        </div>
      </Modal>
      <Modal
        open={detailId !== undefined}
        onClose={closeDetail}
        title={detailData?.subject || "日程详情"}
        description={
          detailData
            ? scheduleTimeSummary(detailData.startAt, detailData.endAt)
            : undefined
        }
        className="schedule-detail-modal"
        wide
        footer={
          <div className="schedule-detail-actions">
            <div className="schedule-detail-footer-actions">
              {detailData &&
                (selectedMeeting !== undefined
                  ? meetingActions(detailData, true)
                  : actions(detailData))}
            </div>
            <Button variant="outline" onClick={closeDetail}>
              关闭详情
            </Button>
          </div>
        }
      >
        {detailData ? (
          <ScheduleDetail
            data={detailData}
            meeting={selectedMeeting !== undefined}
            loading={detailQuery.isPending}
            failed={detailQuery.isError}
            retry={() => void detailQuery.refetch()}
          />
        ) : (
          <QueryState
            loading={detailQuery.isPending}
            error={detailQuery.isError}
            retry={() => void detailQuery.refetch()}
          >
            <></>
          </QueryState>
        )}
      </Modal>
    </div>
  );
}
