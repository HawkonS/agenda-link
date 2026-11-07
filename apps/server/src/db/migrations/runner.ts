import type Database from "better-sqlite3";
import type { ConfigurationService } from "../../config/configuration.service.js";

export type MigrationContext = {
  connection: Database.Database;
  configuration: ConfigurationService;
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  recordMeetingSuccess(
    id: number,
    event: "created" | "cancelled",
    at?: string,
  ): void;
};

export type Migration = {
  version: number;
  name: string;
  up(context: MigrationContext): void;
};

/**
 * 顺序执行未应用的迁移，每个迁移在独立事务里完成。
 * SQLite 的 schema_migrations 表就是版本账本。
 */
export function runMigrations(
  context: MigrationContext,
  migrations: Migration[],
  options: { ensure?: Migration } = {},
) {
  context.connection.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  if (options.ensure) {
    // 基线里的建表/加列是幂等的，每次启动都跑一遍，
    // 这样旧版本代码留下的库也能补齐新列，而不依赖版本号是否已记录。
    context.connection.transaction(() => {
      options.ensure!.up(context);
      context.connection
        .prepare(
          "INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)",
        )
        .run(options.ensure!.version);
    })();
  }
  const applied = new Set(
    (
      context.connection
        .prepare("SELECT version FROM schema_migrations")
        .all() as { version: number }[]
    ).map((row) => row.version),
  );
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    context.connection.transaction(() => {
      migration.up(context);
      context.connection
        .prepare(
          "INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)",
        )
        .run(migration.version);
    })();
  }
}

export function migrationVersion(
  connection: Database.Database,
): number {
  try {
    const row = connection
      .prepare("SELECT max(version) AS version FROM schema_migrations")
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}
