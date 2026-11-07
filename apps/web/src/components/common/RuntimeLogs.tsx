import { useEffect, useRef, useState } from "react";
import { Copy, Download, FileText, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, request } from "../../api";
import { useAction, usePage } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { time } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OptionSelect } from "./OptionSelect";
import { Confirm, Panel, QueryState } from "./workspace";
type File = { name: string; size: number; modifiedAt: string; active: boolean };
export function RuntimeLogs() {
  const { isAdmin } = useSession();
  const { saving, act } = useAction();
  const files = usePage(
    "log-files",
    () => request("/system/logs") as Promise<File[]>,
  );
  const [name, setName] = useState<string | null>(null),
    [lines, setLines] = useState("200"),
    [interval, setIntervalValue] = useState("0"),
    [search, setSearch] = useState("");
  const [content, setContent] = useState<{
      text: string;
      truncated?: boolean;
    }>(),
    [loading, setLoading] = useState(false),
    [failed, setFailed] = useState(false),
    [reload, setReload] = useState(0);
  const generation = useRef(0);
  const previousName = useRef<string | null>(null);
  useEffect(() => {
    const id = ++generation.current;
    if (!name) {
      setContent(undefined);
      return;
    }
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    if (previousName.current !== name) setContent(undefined);
    previousName.current = name;
    async function read() {
      if (disposed) return;
      setLoading(true);
      setFailed(false);
      try {
        const { data } = await api.get(
          `/system/logs/${encodeURIComponent(name!)}?lines=${lines}`,
          { signal: controller.signal },
        );
        if (!disposed && generation.current === id) setContent(data);
      } catch (error) {
        if (!disposed) {
          setFailed(true);
          return;
        }
      } finally {
        if (!disposed) setLoading(false);
      }
      if (!disposed && Number(interval) > 0)
        timer = setTimeout(() => void read(), Number(interval) * 1000);
    }
    void read();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [name, lines, interval, reload]);
  const selected = (files.data || []).find((f) => f.name === name);
  const shown = search
    ? content?.text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(search.toLowerCase()))
        .join("\n")
    : content?.text;
  return (
    <Panel className="log-files-panel">
      <div className="management-toolbar">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4" />
          <strong className="truncate text-sm">{name || "日志文件"}</strong>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <OptionSelect
            label="日志行数"
            value={lines}
            onChange={setLines}
            options={[200, 500, 1000].map((v) => ({
              value: v,
              label: `末尾 ${v} 行`,
            }))}
          />
          <OptionSelect
            label="自动刷新"
            value={interval}
            onChange={setIntervalValue}
            options={[
              { value: "0", label: "自动刷新：关闭" },
              ...[5, 10, 30, 60].map((v) => ({
                value: String(v),
                label: `每 ${v} 秒刷新`,
              })),
            ]}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={loading || files.isFetching}
            onClick={() => {
              void files.refetch();
              if (name) setReload((v) => v + 1);
            }}
          >
            <RefreshCw />
            刷新
          </Button>
        </div>
      </div>
      <div className="log-files-layout">
        <aside className="log-file-list" aria-label="日志文件列表">
          <QueryState
            loading={files.isLoading}
            error={files.isError}
            retry={() => void files.refetch()}
          >
            {!(files.data || []).length ? (
              <p className="p-5 text-sm text-muted-foreground">暂无日志文件</p>
            ) : (
              (files.data || []).map((file) => (
                <button
                  key={file.name}
                  className={`log-file-item ${file.name === name ? "selected" : ""}`}
                  onClick={() => {
                    setName(file.name);
                    setSearch("");
                  }}
                >
                  <span className="flex gap-2 items-center">
                    <FileText className="h-4 w-4 shrink-0" />
                    <strong className="truncate font-medium">
                      {file.name}
                    </strong>
                  </span>
                  <span className="text-muted-foreground">
                    {(file.size / 1024).toFixed(1)} KB · {time(file.modifiedAt)}
                  </span>
                </button>
              ))
            )}
          </QueryState>
        </aside>
        <div className="log-content-region">
          {!name ? (
            <div className="management-empty">选择一个日志文件查看内容</div>
          ) : (
            <>
              <div className="log-content-toolbar">
                <Input
                  aria-label="搜索日志内容"
                  placeholder="搜索当前内容"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-xs"
                />
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="复制日志"
                    disabled={!content}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(content?.text || "")
                        .then(() => toast.success("日志已复制"))
                        .catch(() => toast.error("复制失败"))
                    }
                  >
                    <Copy />
                  </Button>
                  <Button asChild size="icon" variant="ghost">
                    <a
                      aria-label="下载日志"
                      href={`/api/system/logs/${encodeURIComponent(name)}/download`}
                    >
                      <Download />
                    </a>
                  </Button>
                  {isAdmin && (
                    <Confirm
                      title={selected?.active ? "清空活动日志" : "删除历史日志"}
                      description={
                        selected?.active
                          ? "清空当前内容，程序继续写入新日志。"
                          : "删除此历史日志文件。"
                      }
                      onConfirm={() =>
                        act(async () => {
                          await request(
                            `/system/logs/${encodeURIComponent(name)}`,
                            "DELETE",
                          );
                          if (selected?.active) setReload((v) => v + 1);
                          else setName(null);
                        }, "日志已处理")
                      }
                    >
                      {(show) => (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={
                            selected?.active ? "清空日志" : "删除日志"
                          }
                          disabled={saving}
                          onClick={show}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </Confirm>
                  )}
                </div>
              </div>
              {failed ? (
                <div role="alert" className="management-empty">
                  日志读取失败，请刷新后重试
                </div>
              ) : !content && loading ? (
                <div role="status" className="management-empty">
                  正在读取日志…
                </div>
              ) : (
                <pre className="log-content" aria-label="日志内容">
                  {shown || (search ? "没有匹配的内容" : "日志为空")}
                </pre>
              )}
              {content?.truncated && (
                <div className="log-tail-notice">
                  仅显示文件末尾，下载可获取完整日志
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
