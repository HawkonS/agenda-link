import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { request } from "../../api";
import { useAction, usePage } from "../../lib/hooks";
import { auditLabel } from "../../lib/audit-actions";
import { useSession } from "../../lib/session";
import { time } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Confirm,
  DataTable,
  Modal,
  Panel,
  QueryState,
  SelectionControl,
  Status,
  type Column,
} from "./workspace";

type RecordRow = Record<string, any> & { id: number };
type RecordPage = {
  items: RecordRow[];
  total: number;
  throughId: number;
  page: number;
  pageSize: number;
};
const types: Record<string, string> = {
  "meeting.provision": "会议预约",
  "meeting.cancel": "取消会议",
  "calendar.provision": "同步日程",
  "calendar.cancel": "取消日程",
  sync: "组织 / 用户同步",
  "feishu.organization": "组织同步",
  "feishu.users": "用户同步",
  "feishu.all": "完整同步",
  feishu: "飞书同步",
};
function syncResult(row: RecordRow) {
  try {
    return JSON.parse(row.resultJson || "{}");
  } catch {
    return {};
  }
}
export function ManagementRecords({
  kind,
  scope,
  filters = {},
  toolbar,
}: {
  kind: "audit" | "sync" | "jobs";
  scope?: "organization" | "users";
  filters?: Record<string, string>;
  toolbar?: React.ReactNode;
}) {
  const filterKey = JSON.stringify(filters);
  useEffect(() => setPage(1), [filterKey]);
  const { isAdmin } = useSession();
  const [page, setPage] = useState(1),
    [detail, setDetail] = useState<RecordRow>(),
    [selected, setSelected] = useState<Set<number>>(() => new Set());
  useEffect(() => setSelected(new Set()), [filterKey, page, kind]);
  const [clearThrough, setClearThrough] = useState(0);
  const q = usePage(
    `records-${kind}-${scope || "all"}-${page}-${JSON.stringify(filters)}`,
    () =>
      request(
        `/records/${kind}?${new URLSearchParams({ page: String(page), ...(scope ? { scope } : {}), ...filters })}`,
      ) as Promise<RecordPage>,
    true,
  );
  const { saving, act } = useAction();
  const data = q.data,
    current = data?.page || page,
    pages = Math.max(1, Math.ceil((data?.total || 0) / 20));
  const title = { audit: "操作记录", sync: "同步记录", jobs: "后台任务" }[kind];
  const canSelect = isAdmin && kind !== "audit";
  const selectable = (data?.items || []).filter(
    (row) => !["running", "queued"].includes(row.status),
  );
  const allSelectableSelected =
    selectable.length > 0 && selectable.every((row) => selected.has(row.id));
  const columns: Column<RecordRow>[] =
    kind === "audit"
      ? [
          {
            key: "time",
            title: "操作时间",
            width: 180,
            render: (r) => time(r.createdAt),
          },
          {
            key: "action",
            title: "事件",
            width: 190,
            render: (r) => auditLabel(r.action || ""),
          },
          {
            key: "actor",
            title: "操作者",
            width: 130,
            render: (r) => r.actorName || r.actorId || "系统",
          },
          {
            key: "detail",
            title: "详情",
            width: 240,
            render: (r) => (
              <span className="block truncate" title={auditDetailText(r.detail)}>
                {auditDetailText(r.detail)}
              </span>
            ),
          },
        ]
      : [
          { key: "id", title: "编号", width: 72, render: (r) => `#${r.id}` },
          {
            key: "type",
            title: kind === "jobs" ? "任务类型" : "来源",
            width: 150,
            render: (r) => types[r.type || r.source] || r.type || r.source,
          },
          {
            key: "status",
            title: "状态",
            width: 96,
            render: (r) => <Status value={r.status} />,
          },
          ...(kind === "sync"
            ? [
                {
                  key: "result",
                  title: "同步结果",
                  width: 200,
                  render: (r: RecordRow) => {
                    const result = syncResult(r);
                    const parts = [
                      result.created ? `新增 ${result.created}` : "",
                      result.updated ? `更新 ${result.updated}` : "",
                      result.pendingActivation
                        ? `待激活 ${result.pendingActivation}`
                        : "",
                      result.failed ? `失败 ${result.failed}` : "",
                    ].filter(Boolean);
                    return parts.length ? parts.join(" · ") : "无变化";
                  },
                },
              ]
            : [
                {
                  key: "attempts",
                  title: "尝试",
                  width: 64,
                  render: (r: RecordRow) => r.attempts,
                },
              ]),
          ...(kind === "jobs"
            ? [
                {
                  key: "actor",
                  title: "操作者",
                  width: 120,
                  render: (r: RecordRow) =>
                    r.actorName || r.actorUsername || "系统",
                },
              ]
            : []),
          {
            key: "time",
            title: kind === "jobs" ? "更新时间" : "开始时间",
            width: 180,
            render: (r) => time(r.updatedAt || r.startedAt),
          },
          {
            key: "error",
            title: "说明",
            width: 180,
            render: (r) => (
              <span className="block truncate" title={r.error}>
                {r.error || "—"}
              </span>
            ),
          },
        ];
  if (canSelect)
    columns.unshift({
      key: "select",
      title: "选择",
      width: 48,
      render: (r) => (
        <input
          type="checkbox"
          aria-label={`选择记录 #${r.id}`}
          disabled={["running", "queued"].includes(r.status)}
          checked={selected.has(r.id)}
          onChange={(event) =>
            setSelected((current) => {
              const next = new Set(current);
              if (event.target.checked) next.add(r.id);
              else next.delete(r.id);
              return next;
            })
          }
        />
      ),
    });
  columns.push({
    key: "actions",
    title: "操作",
    width: isAdmin ? (kind === "jobs" ? 210 : 140) : 90,
    render: (r) => (
      <div className="row-actions">
        <Button size="sm" variant="ghost" onClick={() => setDetail(r)}>
          详情
        </Button>
        {isAdmin && kind === "jobs" && r.status === "failed" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() =>
              void act(
                () => request(`/system/jobs/${r.id}/retry`, "POST"),
                "任务已重新排队",
              )
            }
          >
            重试
          </Button>
        )}
        {isAdmin && kind !== "audit" && !["running", "queued"].includes(r.status) && (
          <Confirm
            title="删除记录"
            description="删除这条历史记录，不影响已执行的业务结果。"
            onConfirm={() =>
              act(
                () => request(`/records/${kind}/${r.id}`, "DELETE"),
                "记录已删除",
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
                删除
              </Button>
            )}
          </Confirm>
        )}
      </div>
    ),
  });
  const recordActions = (
    <div className="flex flex-wrap items-center gap-2">
      {canSelect && (
        <SelectionControl
          count={selected.size}
          total={selectable.length}
          unit="条"
          ariaLabel="选择当前页记录"
          checked={allSelectableSelected}
          indeterminate={
            selected.size > 0 && selected.size < selectable.length
          }
          disabled={selectable.length === 0}
          onChange={(checked) =>
            setSelected(
              checked ? new Set(selectable.map((row) => row.id)) : new Set(),
            )
          }
        />
      )}
      {canSelect && selected.size > 0 && (
        <Confirm
          title={`删除 ${selected.size} 条记录`}
          description="只删除选中的历史记录，不影响已执行的业务结果。"
          onConfirm={() =>
            act(async () => {
              for (const id of selected)
                await request(`/records/${kind}/${id}`, "DELETE");
              setSelected(new Set());
            }, "所选记录已删除")
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
              删除所选
            </Button>
          )}
        </Confirm>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={q.isFetching}
        onClick={() => void q.refetch()}
      >
        <RefreshCw />
        刷新
      </Button>
      {isAdmin && kind !== "audit" && (
        <Confirm
          title={`清理${title}`}
          description="清理当前范围内已完成和失败的历史记录，保留排队中、执行中以及本次读取后新增的记录。清理操作本身会记入审计日志。"
          onConfirm={() =>
            act(async () => {
              await request(`/records/${kind}/clear`, "POST", {
                throughId: clearThrough,
                ...(scope ? { scope } : {}),
                ...(Object.keys(filters).length ? { filters } : {}),
              });
              setPage(1);
            }, "历史记录已清理")
          }
        >
          {(show) => (
            <Button
              size="sm"
              variant="outline"
              disabled={saving || !data?.total}
              onClick={() => {
                setClearThrough(data?.throughId || 0);
                show();
              }}
            >
              <Trash2 />
              清理记录
            </Button>
          )}
        </Confirm>
      )}
    </div>
  );
  return (
    <>
      <Panel
        className="table-panel records-panel"
        title={toolbar ? undefined : title}
        actions={toolbar ? undefined : recordActions}
      >
        {toolbar && (
          <div className="table-panel-toolbar records-toolbar-compact">
            {toolbar}
            {recordActions}
          </div>
        )}
        <div className="table-panel-body">
          <QueryState
            loading={q.isLoading}
            error={q.isError}
            retry={() => void q.refetch()}
          >
            <DataTable
              rows={data?.items || []}
              columns={columns}
              pagination={false}
              emptyTitle={`暂无${title}`}
            />
          </QueryState>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <span className="text-sm text-muted-foreground">
            共 {data?.total || 0} 条
          </span>
          <div className="flex items-center gap-3">
            <Button
              size="icon"
              variant="outline"
              aria-label="上一页"
              disabled={current <= 1 || q.isFetching}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-sm">
              {current} / {pages}
            </span>
            <Button
              size="icon"
              variant="outline"
              aria-label="下一页"
              disabled={current >= pages || q.isFetching}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </Panel>
      <Modal
        open={!!detail}
        onClose={() => setDetail(undefined)}
        title="记录详情"
        wide
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {detail.status && <Status value={detail.status} />}
            </div>
            {(detail.subject || detail.accountName) && (
              <dl className="grid grid-cols-[90px_1fr] gap-3 text-sm">
                <dt>会议主题</dt>
                <dd>{detail.subject || "—"}</dd>
                <dt>发起账号</dt>
                <dd>{detail.accountName || "—"}</dd>
              </dl>
            )}
            {detail.error && (
              <p className="whitespace-pre-wrap break-words text-destructive">
                {detail.error}
              </p>
            )}
            <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted-foreground">编号</dt>
              <dd>#{detail.id}</dd>
              <dt className="text-muted-foreground">
                {kind === "audit" ? "操作" : "类型"}
              </dt>
              <dd className="break-all">
                {kind === "audit"
                  ? auditLabel(detail.action || "")
                  : types[detail.type || detail.source] ||
                    detail.type ||
                    detail.source}
              </dd>
              <dt className="text-muted-foreground">时间</dt>
              <dd>{time(detail.createdAt || detail.startedAt)}</dd>
              {kind === "audit" && (
                <>
                  <dt className="text-muted-foreground">操作者</dt>
                  <dd>{detail.actorName || detail.actorId || "系统"}</dd>
                  <dt className="text-muted-foreground">内容</dt>
                  <dd className="whitespace-pre-wrap break-all">
                    {auditDetailText(detail.detail)}
                  </dd>
                </>
              )}
              {kind === "sync" &&
                Object.entries({
                  新增: "created",
                  更新: "updated",
                  跳过: "skipped",
                  待激活: "pendingActivation",
                  权限保留: "permissionsPreserved",
                  失败: "failed",
                }).map(([label, key]) => (
                  <div className="contents" key={key}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{syncResult(detail)[key] || 0}</dd>
                  </div>
                ))}
              {kind === "jobs" && (
                <>
                  <dt className="text-muted-foreground">操作者</dt>
                  <dd>{detail.actorName || detail.actorUsername || "系统"}</dd>
                  <dt className="text-muted-foreground">尝试次数</dt>
                  <dd>{detail.attempts}</dd>
                  <dt className="text-muted-foreground">更新时间</dt>
                  <dd>{time(detail.updatedAt)}</dd>
                </>
              )}
            </dl>
          </div>
        )}
      </Modal>
    </>
  );
}

export { RuntimeLogs } from "./RuntimeLogs";

function auditDetailText(value?: string | null) {
  if (!value) return "—";
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = Object.entries(parsed)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      if (parts.length) return parts.join(" · ");
    }
  } catch {
    /* 不是 JSON 就按原文显示 */
  }
  return value;
}
