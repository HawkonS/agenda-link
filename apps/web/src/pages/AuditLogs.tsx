import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CalendarX2,
  CircleAlert,
  LoaderCircle,
  SlidersHorizontal,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { request } from "../api";
import { usePage } from "../lib/hooks";
import {
  ManagementRecords,
  RuntimeLogs,
} from "../components/common/ManagementRecords";
import { OptionSelect } from "../components/common/OptionSelect";
import { Panel, SearchBox } from "../components/common/workspace";
import { useWorkspaceTabs } from "../lib/workspace-tabs";
import { auditFilterOptions } from "../lib/audit-actions";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { Button } from "../components/ui/button";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
function beijingDate(offset = 0) {
  return new Date(Date.now() + 8 * 3600000 + offset * 86400000)
    .toISOString()
    .slice(0, 10);
}
function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={label}>
          <CalendarDays />
          {value || label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <DayPicker
          mode="single"
          locale={zhCN}
          selected={value ? new Date(value + "T12:00:00") : undefined}
          onSelect={(d) => {
            if (d) {
              onChange(
                `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
              );
              setOpen(false);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
export default function AuditLogs() {
  const { activeTab } = useWorkspaceTabs();
  const [params] = useSearchParams();
  const [kind, setKind] = useState<"jobs" | "sync" | "audit">(
    params.get("tab") === "audit" ? "audit" : "jobs",
  );
  const [range, setRange] = useState("30"),
    [from, setFrom] = useState(beijingDate(-29)),
    [to, setTo] = useState(beijingDate());
  const [type, setType] = useState(""),
    [status, setStatus] = useState(""),
    [actor, setActor] = useState(""),
    [keyword, setKeyword] = useState(""),
    [search, setSearch] = useState(""),
    [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(keyword), 350);
    return () => clearTimeout(timer);
  }, [keyword]);
  const dateFilters = useMemo<Record<string, string>>(
    () => (range === "all" ? ({} as Record<string, string>) : { from, to }),
    [range, from, to],
  );
  const actors = usePage("record-actors", () =>
    request("/records/audit/actors"),
  );
  const stats = usePage(
    "record-statistics-" + JSON.stringify(dateFilters),
    () => request("/records/statistics?" + new URLSearchParams(dateFilters)),
    true,
  );
  const filters = useMemo(
    () => ({
      ...dateFilters,
      ...(type ? { type } : {}),
      ...(kind === "audit" && actor ? { actor } : {}),
      ...(status ? { status } : {}),
      ...(search ? { q: search } : {}),
    }),
    [dateFilters, type, status, actor, search],
  );
  if (activeTab === "logs")
    return (
      <div className="page-shell page-shell--table">
        <RuntimeLogs />
      </div>
    );
  const cards = [
    {
      label: "创建会议成功",
      value: stats.data?.created || 0,
      icon: CalendarDays,
      type: "meeting.provision",
    },
    {
      label: "取消会议成功",
      value: stats.data?.cancelled || 0,
      icon: CalendarX2,
      type: "meeting.cancel",
    },
    {
      label: "失败任务",
      value: stats.data?.failed || 0,
      icon: CircleAlert,
      status: "failed",
    },
    {
      label: "处理中任务",
      value: stats.data?.processing || 0,
      icon: LoaderCircle,
      status: "processing",
    },
  ];
  const filterCount =
    (type ? 1 : 0) +
    (kind === "audit" ? (actor ? 1 : 0) : status ? 1 : 0);
  const toolbar = (
    <div className="records-filter-row">
      <div className="records-search">
        <SearchBox
          value={keyword}
          onChange={setKeyword}
          placeholder="搜索主题、类型或错误信息"
        />
      </div>
      <div className="records-kind-tabs" role="group" aria-label="记录分类">
        {(
          [
            ["jobs", "任务记录"],
            ["sync", "同步记录"],
            ["audit", "操作记录"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`records-kind-tab ${kind === value ? "is-active" : ""}`}
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setType("");
              setStatus("");
              setActor("");
              setFiltersOpen(false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="records-filter-trigger"
          >
            <SlidersHorizontal />
            筛选
            {filterCount > 0 && (
              <span className="calendar-filter-count">{filterCount}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="records-filter-popover">
          <div className="records-filter-panel">
            <label className="records-filter-field">
              <span>记录类型</span>
              <OptionSelect
                label="记录类型"
                value={type}
                onChange={setType}
                options={[
                  { value: "", label: "全部类型" },
                  ...(kind === "jobs"
                    ? [
                        ["meeting.provision", "会议预约"],
                        ["meeting.cancel", "取消会议"],
                        ["calendar.provision", "同步日程"],
                        ["calendar.cancel", "取消日程"],
                        ["sync", "组织 / 用户同步"],
                        ["recording.sync", "获取录制"],
                        ["recording.delete", "删除录制"],
                      ]
                    : kind === "sync"
                      ? [
                          ["feishu.organization", "组织同步"],
                          ["feishu.users", "用户同步"],
                          ["feishu.all", "完整同步"],
                        ]
                      : auditFilterOptions.map((option) => [
                          option.value,
                          option.label,
                        ])
                  ).map(([value, label]) => ({ value: value!, label: label! })),
                ]}
              />
            </label>
            {kind === "audit" ? (
              <label className="records-filter-field">
                <span>操作者</span>
                <OptionSelect
                  label="操作者"
                  value={actor}
                  onChange={setActor}
                  options={[
                    { value: "", label: "全部操作者" },
                    ...((actors.data as any[]) || []).map((item: any) => ({
                      value: item.id,
                      label: `${item.name}${item.username ? ` @${item.username}` : ""}（${item.count}）`,
                    })),
                  ]}
                />
              </label>
            ) : (
              <label className="records-filter-field">
                <span>记录状态</span>
                <OptionSelect
                  label="记录状态"
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: "", label: "全部状态" },
                    { value: "queued", label: "排队中" },
                    { value: "running", label: "执行中" },
                    { value: "processing", label: "处理中" },
                    { value: "success", label: "成功" },
                    { value: "failed", label: "失败" },
                  ]}
                />
              </label>
            )}
            <div className="records-filter-actions">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setType("");
                  setStatus("");
                  setActor("");
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
    </div>
  );
  return (
    <div className="page-shell statistics-page">
      <Panel className="statistics-overview">
        <div className="management-toolbar">
          <span className="font-medium text-sm">会议与任务</span>
          <div className="flex flex-wrap gap-2">
            <OptionSelect
              label="统计时间"
              value={range}
              onChange={(v) => {
                setRange(v);
                if (v !== "all" && v !== "custom") {
                  setFrom(beijingDate(1 - Number(v)));
                  setTo(beijingDate());
                }
              }}
              options={[
                { value: "30", label: "最近 30 天" },
                { value: "1", label: "今天" },
                { value: "7", label: "最近 7 天" },
                { value: "all", label: "全部时间" },
                { value: "custom", label: "自定义日期" },
              ]}
            />
            {range === "custom" && (
              <>
                <DateFilter
                  label="开始日期"
                  value={from}
                  onChange={(v) => {
                    setFrom(v);
                    if (v > to) setTo(v);
                  }}
                />
                <DateFilter
                  label="结束日期"
                  value={to}
                  onChange={(v) => {
                    setTo(v);
                    if (v < from) setFrom(v);
                  }}
                />
              </>
            )}
          </div>
        </div>
        <div className="statistics-grid">
          {cards.map((card) => (
            <button
              key={card.label}
              className={`statistics-item ${(card.type && type === card.type) || (card.status && status === card.status) ? "selected" : ""}`}
              onClick={() => {
                setKind("jobs");
                setType(card.type || "");
                setStatus(card.status || "");
              }}
            >
              <span>{card.label}</span>
              <div>
                <strong>{stats.isLoading ? "—" : card.value}</strong>
                <card.icon />
              </div>
            </button>
          ))}
        </div>
        {stats.isError && (
          <div role="alert" className="px-4 pb-3 text-sm text-destructive">
            统计读取失败
          </div>
        )}
      </Panel>
      <ManagementRecords
        key={kind}
        kind={kind}
        filters={filters}
        toolbar={toolbar}
      />
    </div>
  );
}
