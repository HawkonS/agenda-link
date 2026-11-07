import { useQuery } from "@tanstack/react-query";
import { Copy, Download, FileVideo, Play, RefreshCw } from "lucide-react";
import { request } from "../../api";
import { copyText } from "../../lib/clipboard";
import { useAction } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { time } from "../../lib/utils";
import { Button } from "../ui/button";
import { Confirm, ErrorBanner, Status } from "./workspace";

type Recording = {
  id: number;
  canDelete: boolean;
  remoteDeletionSupported: boolean;
  status: string;
  expiresAt: string | null;
  error: string | null;
  files: {
    id: string;
    extension: string;
    viewUrl?: string;
    downloadable: boolean;
  }[];
};
const labels: Record<string, string> = {
  scheduled: "等待开会",
  processing: "等待云录制",
  ready: "已就绪",
  failed: "同步失败",
  unavailable: "暂无云录制",
  expired: "已到期",
  deleting: "删除中",
  delete_failed: "删除失败",
  deleted: "已删除",
};

export function ScheduleRecordings({
  meetingId,
  subject,
  endAt,
  enabled,
}: {
  meetingId: number;
  subject: string;
  endAt: string;
  enabled: boolean;
}) {
  const { isOperator, isAdmin } = useSession();
  const { saving, act } = useAction();
  const q = useQuery<Recording[]>({
    queryKey: ["schedule-recordings", meetingId],
    queryFn: () => request(`/meetings/${meetingId}/recordings`),
    refetchInterval: 10000,
  });
  return (
    <section className="schedule-recordings" aria-label="云录制">
      <div className="schedule-recordings-heading">
        <h3>
          <FileVideo aria-hidden="true" />
          云录制
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={q.isFetching || saving}
          onClick={() => void q.refetch()}
        >
          <RefreshCw className={q.isFetching ? "animate-spin" : ""} />
          刷新
        </Button>
      </div>
      {q.isPending ? (
        <p className="schedule-recordings-empty" role="status">
          加载录制…
        </p>
      ) : q.isError ? (
        <ErrorBanner message="云录制加载失败" retry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <p className="schedule-recordings-empty">
          {!enabled
            ? "未开启云录制"
            : Date.parse(endAt) > Date.now()
              ? "会议结束后显示云录制"
              : "暂无云录制"}
        </p>
      ) : (
        q.data.map((recording) => {
          const files =
            recording.status === "ready"
              ? recording.files.filter(
                  (file) => file.viewUrl || file.downloadable,
                )
              : [];
          return (
            <div className="schedule-recording" key={recording.id}>
              <div className="schedule-recording-meta">
                <Status
                  value={recording.status}
                  label={labels[recording.status]}
                />
                {recording.expiresAt && (
                  <span>保留至 {time(recording.expiresAt)}</span>
                )}
              </div>
              {recording.status === "expired" &&
                !recording.remoteDeletionSupported && (
                  <p className="schedule-recordings-empty">
                    本系统录制入口已停用；平台录制文件未删除。
                  </p>
                )}
              {!!files.length && (
                <ul className="schedule-recording-files">
                  {files.map((file, index) => (
                    <li key={file.id}>
                      {files.length > 1 && file.viewUrl && (
                        <span className="schedule-recording-file-name">
                          录制文件{files.length > 1 ? ` ${index + 1}` : ""}
                          {file.extension && (
                            <span>{file.extension.toUpperCase()}</span>
                          )}
                        </span>
                      )}
                      <div className="schedule-recording-address-row">
                        {!file.viewUrl && (
                          <span className="schedule-recording-file-name">
                            录制文件{files.length > 1 ? ` ${index + 1}` : ""}
                            {file.extension && (
                              <span>{file.extension.toUpperCase()}</span>
                            )}
                          </span>
                        )}
                        {file.viewUrl && (
                          <a
                            className="schedule-recording-address"
                            href={file.viewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="播放"
                            title={file.viewUrl}
                          >
                            <Play aria-hidden="true" />
                            <span>{file.viewUrl}</span>
                          </a>
                        )}
                        <div className="schedule-recording-file-actions">
                          {file.viewUrl && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`复制播放地址${files.length > 1 ? ` ${index + 1}` : ""}`}
                              onClick={() =>
                                void copyText(file.viewUrl!, "播放地址")
                              }
                            >
                              <Copy />
                            </Button>
                          )}
                          {file.downloadable && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`下载录制${files.length > 1 ? ` ${index + 1}` : ""}`}
                              disabled={saving}
                              onClick={() =>
                                void act(async () => {
                                  const result = await request(
                                    `/recordings/${recording.id}/download?fileId=${encodeURIComponent(file.id)}`,
                                  );
                                  window.location.assign(result.url);
                                })
                              }
                            >
                              <Download />
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {recording.error && <ErrorBanner message={recording.error} />}
              {(isOperator || (isAdmin && recording.canDelete)) && (
                <div className="schedule-recording-actions">
                  {isOperator &&
                    ![
                      "expired",
                      "deleted",
                      "deleting",
                      "delete_failed",
                    ].includes(recording.status) &&
                    Date.parse(endAt) <= Date.now() && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() =>
                          void act(
                            () =>
                              request(
                                `/recordings/${recording.id}/retry`,
                                "POST",
                              ),
                            "已开始同步云录制",
                          )
                        }
                      >
                        同步录制
                      </Button>
                    )}
                  {isAdmin && recording.canDelete && (
                    <Confirm
                      title="删除平台云录制"
                      description={`将删除「${subject}」在原会议平台中的云录制文件，播放和下载地址也会失效。`}
                      onConfirm={() =>
                        act(
                          () =>
                            request(`/recordings/${recording.id}`, "DELETE"),
                          "云录制删除已排队",
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
                          {recording.status === "delete_failed"
                            ? "重试删除"
                            : "删除录制"}
                        </Button>
                      )}
                    </Confirm>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
