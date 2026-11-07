import { Database } from "lucide-react";
import { request } from "../../api";
import { useAction, usePage } from "../../lib/hooks";
import { Button } from "../ui/button";
import { DataTable } from "../common/workspace";

export function BackupManagement() {
  const backups = usePage("database-backups", () => request("/system/backups"));
  const { saving, act } = useAction();
  const rows = backups.data || [];
  return (
    <div className="backup-page">
      <section className="backup-intro">
        <span className="backup-intro-icon" aria-hidden="true">
          <Database />
        </span>
        <div>
          <h2>数据库备份</h2>
          <p>升级或维护前创建一份可下载的数据库快照。</p>
        </div>
        <Button
          size="sm"
          disabled={saving}
          onClick={() =>
            void act(
              () => request("/system/backups", "POST"),
              "数据库备份已创建",
            )
          }
        >
          <Database />
          创建备份
        </Button>
      </section>
      <section className="settings-card backup-table-card">
        <div className="backup-list-heading">
          <h3>备份文件</h3>
          <span>{rows.length} 个</span>
        </div>
        <DataTable
          rows={rows}
          pagination={false}
          emptyTitle="暂无备份文件"
          emptyHint="需要保留当前数据时，创建一份数据库快照。"
          columns={[
            {
              key: "name",
              title: "备份文件",
              width: 420,
              render: (r: any) => r.name,
            },
            {
              key: "size",
              title: "大小",
              width: 140,
              render: (r: any) => `${(r.size / 1024).toFixed(1)} KB`,
            },
            {
              key: "actions",
              title: "操作",
              width: 120,
              render: (r: any) => (
                <div className="row-actions">
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={`/api/system/backups/${encodeURIComponent(r.name)}`}
                    >
                      下载
                    </a>
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </section>
    </div>
  );
}
