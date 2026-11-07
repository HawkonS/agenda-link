import type { Migration } from "./runner.js";

/** 管理记录、成功事件与默认业务状态。 */
export const managementRecords: Migration = {
  version: 3,
  name: "management-records",
  up({
    connection,
    configuration,
    getState,
    setState,
    recordMeetingSuccess,
  }) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS record_annotations (
        kind TEXT NOT NULL, record_id INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
        handled INTEGER NOT NULL DEFAULT 0, updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(kind,record_id));
      CREATE TABLE IF NOT EXISTS meeting_success_events (
        meeting_id INTEGER NOT NULL, event TEXT NOT NULL CHECK(event IN ('created','cancelled')),
        occurred_at TEXT NOT NULL, PRIMARY KEY(meeting_id,event));
      CREATE INDEX IF NOT EXISTS idx_success_events_date ON meeting_success_events(julianday(occurred_at),event);
      CREATE INDEX IF NOT EXISTS idx_jobs_date_filter ON jobs(julianday(created_at),type,status);
      CREATE INDEX IF NOT EXISTS idx_sync_date_filter ON sync_runs(julianday(started_at),source,status);
      CREATE INDEX IF NOT EXISTS idx_audit_date_filter ON audit_logs(julianday(created_at),action);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at,type,status);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at,action);
      CREATE INDEX IF NOT EXISTS idx_sync_started ON sync_runs(started_at,source,status);
    `);

    if (!getState("management.events.migrated")) {
      const rows = connection
        .prepare(
          "SELECT action,detail,created_at FROM audit_logs WHERE action IN ('meeting.provisioned','meeting.cancelled') ORDER BY id",
        )
        .all() as { action: string; detail: string; created_at: string }[];
      for (const row of rows) {
        try {
          const detail = JSON.parse(row.detail);
          const id = typeof detail === "number" ? detail : detail?.id;
          if (Number.isSafeInteger(id) && id > 0)
            recordMeetingSuccess(
              id,
              row.action === "meeting.provisioned" ? "created" : "cancelled",
              row.created_at,
            );
        } catch {
          /* 损坏的历史记录不能当作成功凭据。 */
        }
      }
      // 已保存的平台 ID 可以确认会议创建成功，包括后来被取消的。
      connection.exec(`INSERT OR IGNORE INTO meeting_success_events(meeting_id,event,occurred_at)
        SELECT id,'created',created_at FROM meetings WHERE external_meeting_id IS NOT NULL AND external_meeting_id<>'' AND external_meeting_id NOT LIKE 'demo-%';
        INSERT OR IGNORE INTO meeting_success_events(meeting_id,event,occurred_at)
        SELECT id,'cancelled',updated_at FROM meetings WHERE status='cancelled' AND external_meeting_id IS NOT NULL AND external_meeting_id NOT LIKE 'demo-%';`);
      setState("management.events.migrated", "true");
    }

    if (!getState("sync.policy")) {
      const minutes =
        Number(
          configuration.get("sync.interval-minutes") ||
            configuration.legacy("sync.interval-minutes"),
        ) || 0;
      setState(
        "sync.policy",
        JSON.stringify({
          automaticMode: minutes > 0 ? "interval" : "manual",
          intervalMinutes: minutes > 0 ? minutes : 60,
          disableMissingUsers:
            (configuration.get("sync.disable-missing") ||
              configuration.legacy("sync.disable-missing")) === "true",
        }),
      );
    }
    if (!getState("recording.settings"))
      setState(
        "recording.settings",
        JSON.stringify({
          ttlDays: configuration.getNumber("recording.ttl-days", 30),
          deleteRemote:
            configuration.get("recording.delete-remote") !== "false",
        }),
      );

    connection.exec(`
      CREATE TRIGGER IF NOT EXISTS meeting_created_success AFTER UPDATE OF external_meeting_id ON meetings
      WHEN NEW.external_meeting_id IS NOT NULL AND NEW.external_meeting_id<>'' AND NEW.external_meeting_id NOT LIKE 'demo-%'
      BEGIN INSERT OR IGNORE INTO meeting_success_events VALUES(NEW.id,'created',CURRENT_TIMESTAMP); END;
      CREATE TRIGGER IF NOT EXISTS meeting_insert_success AFTER INSERT ON meetings
      WHEN NEW.external_meeting_id IS NOT NULL AND NEW.external_meeting_id<>'' AND NEW.external_meeting_id NOT LIKE 'demo-%'
      BEGIN INSERT OR IGNORE INTO meeting_success_events VALUES(NEW.id,'created',NEW.created_at); END;
      CREATE TRIGGER IF NOT EXISTS meeting_cancelled_success AFTER UPDATE OF status ON meetings
      WHEN NEW.status='cancelled' AND NEW.external_meeting_id IS NOT NULL AND NEW.external_meeting_id NOT LIKE 'demo-%'
      BEGIN INSERT OR IGNORE INTO meeting_success_events VALUES(NEW.id,'cancelled',CURRENT_TIMESTAMP); END;
    `);
    configuration.retireBusinessProperties();
  },
};
