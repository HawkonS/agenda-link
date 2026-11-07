import type { Migration } from "./runner.js";

/**
 * 基线：最初的建表与列补齐。
 * 对已经存在 schema_migrations=1 的旧库不会再执行。
 */
export const baseline: Migration = {
  version: 1,
  name: "baseline",
  up({ connection }) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS platform_connections(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL UNIQUE,enabled INTEGER NOT NULL DEFAULT 1,config_json TEXT NOT NULL DEFAULT '{}',last_error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor_id TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, email TEXT, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', feishu_open_id TEXT UNIQUE, feishu_user_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL, name TEXT NOT NULL, parent_external_id TEXT, path TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS user_departments (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE, PRIMARY KEY(user_id, department_id));
      CREATE TABLE IF NOT EXISTS sync_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, department_external_id TEXT, department_name TEXT, meeting_user_type TEXT NOT NULL DEFAULT 'advanced', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'feishu', status TEXT NOT NULL, departments_count INTEGER NOT NULL DEFAULT 0, users_count INTEGER NOT NULL DEFAULT 0, error TEXT, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS meeting_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, account_id TEXT NOT NULL, secret_id TEXT, secret_key TEXT, status TEXT NOT NULL DEFAULT 'available', last_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS account_pools (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS account_pool_members (pool_id INTEGER NOT NULL REFERENCES account_pools(id) ON DELETE CASCADE, account_id INTEGER NOT NULL REFERENCES meeting_accounts(id) ON DELETE CASCADE, PRIMARY KEY(pool_id, account_id));
      CREATE TABLE IF NOT EXISTS calendar_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, title_template TEXT NOT NULL, description_template TEXT, location_template TEXT, reminders_json TEXT, extensions_json TEXT, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, description TEXT, start_at TEXT NOT NULL, end_at TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', status TEXT NOT NULL DEFAULT 'scheduled', external_meeting_id TEXT, meeting_code TEXT, provider_response_json TEXT, meeting_url TEXT, calendar_event_id TEXT, account_pool_id INTEGER REFERENCES account_pools(id), meeting_account_id INTEGER REFERENCES meeting_accounts(id), created_by INTEGER REFERENCES users(id), cohost_enabled INTEGER NOT NULL DEFAULT 1, recording_enabled INTEGER NOT NULL DEFAULT 0, recording_ttl_days INTEGER NOT NULL DEFAULT 30, calendar_template_id INTEGER REFERENCES calendar_templates(id), extensions_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS meeting_attendees (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), email TEXT, display_name TEXT NOT NULL, feishu_open_id TEXT, is_cohost INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS recordings (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'scheduled', remote_url TEXT, object_url TEXT, expires_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload_json TEXT, error TEXT, run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);

    // 旧安装可能先于 createTables 建出这张表，这里统一补齐。
    connection.exec(
      `CREATE TABLE IF NOT EXISTS calendar_events(id INTEGER PRIMARY KEY AUTOINCREMENT,created_by INTEGER NOT NULL REFERENCES users(id),subject TEXT NOT NULL,description TEXT,start_at TEXT NOT NULL,end_at TEXT NOT NULL,calendar_event_id TEXT,calendar_id TEXT,request_key TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    );
    connection.exec(
      `CREATE TABLE IF NOT EXISTS platform_identities(id INTEGER PRIMARY KEY AUTOINCREMENT,provider_id TEXT NOT NULL,connection_id TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'person',external_id TEXT NOT NULL,stable_id TEXT,user_id INTEGER REFERENCES users(id),name TEXT NOT NULL,profile_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    );

    const additions: Record<string, Record<string, string>> = {
      users: {
        avatar_url: "TEXT",
        phone: "TEXT",
        feishu_login_open_id: "TEXT",
        system_access: "TEXT NOT NULL DEFAULT 'allowed'",
        source: "TEXT NOT NULL DEFAULT 'local'",
        last_seen_at: "TEXT",
        sync_error: "TEXT",
      },
      departments: {
        provider_id: "TEXT NOT NULL DEFAULT 'feishu'",
        connection_id: "TEXT NOT NULL DEFAULT 'feishu-directory'",
        tencent_department_id: "TEXT",
      },
      meeting_accounts: {
        verified_at: "TEXT",
        provider_id: "TEXT NOT NULL DEFAULT 'tencent'",
        connection_id: "TEXT NOT NULL DEFAULT 'tencent-meeting'",
      },
      account_pools: {
        is_default: "INTEGER NOT NULL DEFAULT 0",
        provider_id: "TEXT NOT NULL DEFAULT 'tencent'",
        connection_id: "TEXT NOT NULL DEFAULT 'tencent-meeting'",
      },
      calendar_templates: { is_default: "INTEGER NOT NULL DEFAULT 0" },
      sync_runs: { result_json: "TEXT" },
      meetings: {
        provider_id: "TEXT NOT NULL DEFAULT 'tencent'",
        connection_id: "TEXT NOT NULL DEFAULT 'tencent-meeting'",
        calendar_connection_id: "TEXT",
        host_external_id: "TEXT",
        host_name: "TEXT",
        calendar_status: "TEXT NOT NULL DEFAULT 'not_requested'",
        calendar_error: "TEXT",
        calendar_description_text: "TEXT",
        deleted_at: "TEXT",
        allocation_source: "TEXT NOT NULL DEFAULT 'pool'",
        calendar_id: "TEXT",
        meeting_code: "TEXT",
        provider_response_json: "TEXT",
        request_key: "TEXT",
        error: "TEXT",
        provision_step: "TEXT NOT NULL DEFAULT 'reserved'",
      },
      meeting_attendees: {
        feishu_user_id: "TEXT",
        external_id: "TEXT",
        cohost_status: "TEXT NOT NULL DEFAULT 'pending'",
        cohost_error: "TEXT",
      },
      recordings: {
        files_json: "TEXT",
        storage_type: "TEXT NOT NULL DEFAULT 'remote'",
        last_polled_at: "TEXT",
        delete_remote: "INTEGER NOT NULL DEFAULT 1",
      },
      jobs: { attempts: "INTEGER NOT NULL DEFAULT 0" },
      audit_logs: { updated_at: "TEXT NOT NULL DEFAULT ''" },
      calendar_events: {
        provider_id: "TEXT NOT NULL DEFAULT 'feishu'",
        connection_id: "TEXT NOT NULL DEFAULT 'feishu-calendar'",
        calendar_description_text: "TEXT",
        deleted_at: "TEXT",
        creation_uncertain: "INTEGER NOT NULL DEFAULT 0",
      },
    };
    for (const [table, columns] of Object.entries(additions)) {
      const known = (
        connection.prepare("PRAGMA table_info(" + table + ")").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      for (const [name, type] of Object.entries(columns))
        if (!known.includes(name))
          connection.exec(
            "ALTER TABLE " + table + " ADD COLUMN " + name + " " + type,
          );
    }

    connection.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_identity_scope ON platform_identities(connection_id,kind,external_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_department_scope ON departments(connection_id,external_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_account_scope ON meeting_accounts(connection_id,account_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feishu_login ON users(feishu_login_open_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_request ON meetings(request_key);
      CREATE INDEX IF NOT EXISTS idx_meetings_account_time ON meetings(meeting_account_id,start_at,end_at,status);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,window_start INTEGER NOT NULL,locked_until INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_login_attempts_expiry ON login_attempts(window_start);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id,expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status,run_at);
      CREATE INDEX IF NOT EXISTS idx_meetings_owner_start ON meetings(created_by,start_at);
      CREATE INDEX IF NOT EXISTS idx_meetings_status_end ON meetings(status,end_at);
      CREATE INDEX IF NOT EXISTS idx_attendees_user_meeting ON meeting_attendees(user_id,meeting_id);
      CREATE INDEX IF NOT EXISTS idx_recordings_status_poll ON recordings(status,last_polled_at);
      CREATE INDEX IF NOT EXISTS idx_calendar_owner ON calendar_events(created_by,start_at);
      CREATE INDEX IF NOT EXISTS idx_user_departments_department ON user_departments(department_id,user_id);
      UPDATE account_pools
      SET is_default = 0
      WHERE is_default = 1
        AND id NOT IN (SELECT MIN(id) FROM account_pools WHERE is_default = 1 GROUP BY connection_id);
      UPDATE calendar_templates
      SET is_default = 0
      WHERE is_default = 1
        AND id NOT IN (SELECT MIN(id) FROM calendar_templates WHERE is_default = 1);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_account_pools_default ON account_pools(connection_id,is_default) WHERE is_default = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_templates_default ON calendar_templates(is_default) WHERE is_default = 1;
    `);

    // 旧版演示链接不能被当成真实外部会议。
    connection
      .prepare(
        "UPDATE meetings SET status='failed',meeting_url=NULL,external_meeting_id=NULL,error='旧版演示数据，请重新预约' WHERE external_meeting_id LIKE 'demo-%'",
      )
      .run();
  },
};
