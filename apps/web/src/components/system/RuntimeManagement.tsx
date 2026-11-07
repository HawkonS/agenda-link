import { useEffect, useState } from "react";
import {
   Power,
  RefreshCw,
  RotateCw,
  Upload,
} from "lucide-react";
import { api, request } from "../../api";
import { useAction, usePage } from "../../lib/hooks";
import { time } from "../../lib/utils";
import { Button } from "../ui/button";
import { Confirm } from "../common/workspace";
const actions = [
  {
    action: "restart",
    label: "重启服务",
    icon: RotateCw,
    description: "重启期间网站会短暂断开，后台任务和维护进度会保留。",
  },
  {
    action: "stop",
    label: "停止服务",
    icon: Power,
    description:
      "网站与后台任务将完全停止，需通过 SSH 执行 tools/manage_service.sh start 才能重新启动。",
  },
  {
    action: "upgrade",
    label: "升级系统",
    icon: Upload,
    description:
      "先检查 Git 上游并预构建，再备份、升级与健康检查；失败时回滚。",
  },
];
function remembered() {
  try {
    return JSON.parse(localStorage.getItem("system-maintenance") || "null");
  } catch {
    return null;
  }
}
export function RuntimeManagement() {
  const [operation, setOperation] = useState<any>(remembered);
  const { saving, act } = useAction();
  const q = usePage(
    "runtime-status",
    async () =>
      (
        await api.get("/system/runtime", {
          headers: { "X-Silent-Request": "1" },
          timeout: 8000,
        })
      ).data,
    () =>
      operation && ["queued", "running"].includes(operation.status)
        ? 2000
        : 15000,
  );
  useEffect(() => {
    const op = q.data?.maintenance?.operation;
    if (q.data?.maintenance?.available && !op) {
      setOperation(null);
      localStorage.removeItem("system-maintenance");
    }
    if (op) {
      setOperation(op);
      localStorage.setItem("system-maintenance", JSON.stringify(op));
    }
  }, [q.data]);
  async function submit(action: string) {
    await act(
      async () => {
        const op = await request("/system/runtime/operations", "POST", {
          action,
        });
        setOperation(op);
        localStorage.setItem("system-maintenance", JSON.stringify(op));
      },
      action === "stop" ? "正在停止服务" : "维护任务已提交",
    );
  }
  const available = !!q.data?.maintenance?.available,
    busy = !!operation && ["queued", "running"].includes(operation.status),
    data = q.data;
  const duration = (seconds: number) =>
    `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
  return (
    <div className="runtime-page">
      {q.isError && (
        <div role="status" className="runtime-notice">
          {operation?.action === "stop"
            ? "服务已停止，重新启动请通过 SSH 执行 tools/manage_service.sh start。"
            : "服务暂时无法连接，正在等待恢复…"}
        </div>
      )}

      <section className="runtime-hero">
        <div className="runtime-hero-main">
          <div className="runtime-health">
            <span className={data?.api && data?.web ? "is-ok" : "is-warn"} />
            {data?.api && data?.web ? "服务运行正常" : "服务未就绪"}
          </div>
          <p className="runtime-meta">
            {data
              ? `版本 ${data.version} · ${
                  data.mode === "systemd" ? "系统服务" : "独立运行"
                } · 已运行 ${duration(data.uptime)}`
              : "正在读取运行状态…"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          <RefreshCw />
          刷新
        </Button>
      </section>

      <div className="runtime-metrics">
        {[
          ["API", data?.api ? "运行中" : "未就绪", Boolean(data?.api)],
          ["Web", data?.web ? "运行中" : "未就绪", Boolean(data?.web)],
          [
            "Worker",
            data?.worker?.enabled
              ? data.worker.busy
                ? "处理中"
                : "运行中"
              : "未运行",
            Boolean(data?.worker?.enabled),
          ],
          ["服务模式", data ? (data.mode === "systemd" ? "系统服务" : "独立运行") : "—"],
          ["端口", data ? `${data.ports.api} / ${data.ports.web}` : "—"],
          [
            "开机自启",
            available
              ? data.maintenance.enabled
                ? "已开启"
                : "已关闭"
              : "不支持",
          ],
        ].map(([label, value, ok]) => (
          <div className="runtime-metric" key={String(label)}>
            <span>{label}</span>
            <strong className={ok ? "is-ok" : ""}>{value}</strong>
          </div>
        ))}
      </div>

      <section className="runtime-card">
        <div className="runtime-card-header">
          <div>
            <h2>服务操作</h2>
            <p>维护操作会短暂影响网站和预约任务。</p>
          </div>
        </div>
        <div className="runtime-actions">
          {actions.map((item) => (
            <Confirm
              key={item.action}
              title={item.label}
              description={item.description}
              onConfirm={() => submit(item.action)}
            >
              {(show) => (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!available || saving || busy}
                  onClick={show}
                >
                  <item.icon />
                  {item.label}
                </Button>
              )}
            </Confirm>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={!available || saving || busy}
            onClick={() => void submit("check-update")}
          >
            <RefreshCw />
            检查更新
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!available || saving || busy}
            onClick={() =>
              void submit(data.maintenance.enabled ? "disable" : "enable")
            }
          >
            {data?.maintenance?.enabled ? "关闭开机自启" : "开启开机自启"}
          </Button>
        </div>
        {!available && (
          <div className="runtime-notice">
            {data?.maintenance?.reason || "正在获取服务状态"}
          </div>
        )}
        {operation && (
          <div className="maintenance-progress" aria-live="polite">
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{operation.stage}</strong>
              <span>{time(operation.finishedAt || operation.createdAt)}</span>
            </div>
            <code className="block mt-2 break-all">{operation.id}</code>
            {operation.targetVersion && (
              <p className="mt-2 break-all text-sm">
                目标版本：{operation.targetVersion}
              </p>
            )}
            {operation.error && (
              <p className="mt-3 whitespace-pre-wrap text-destructive">
                {operation.error}
              </p>
            )}
            {operation.output && <pre>{operation.output}</pre>}
          </div>
        )}
      </section>


    </div>
  );
}
