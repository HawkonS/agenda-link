import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { DatabaseService } from "../src/database.service.js";
import { migrationVersion } from "../src/db/migrations/index.js";

test("migrations are versioned, repair legacy schemas and stay idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-migrations-"));
  process.env.AGENDA_LINK_WORKSPACE = root;
  let db: DatabaseService | undefined;
  try {
    db = new DatabaseService(new ConfigurationService());
    const versions = () =>
      (
        db!.connection
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as { version: number }[]
      ).map((row) => row.version);
    assert.deepEqual(versions(), [1, 2, 3, 4]);
    assert.equal(migrationVersion(db.connection), 4);
    assert.ok(
      db.connection
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_success_events'",
        )
        .get(),
    );
    assert.ok(
      db.connection
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_annotations'",
        )
        .get(),
    );
    assert.ok(
      db.connection
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_calendar_targets'",
        )
        .get(),
    );

    // 模拟旧代码留下的库：版本记录和实际结构都可能落后。
    db.connection.exec(
      "DELETE FROM schema_migrations WHERE version >= 2; ALTER TABLE users DROP COLUMN avatar_url",
    );
    db.onModuleDestroy();
    db = undefined;

    db = new DatabaseService(new ConfigurationService());
    assert.deepEqual(versions(), [1, 2, 3, 4]);
    const columns = (
      db.connection.prepare("PRAGMA table_info(users)").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    assert.ok(columns.includes("avatar_url"));

    // 再次启动不应重复记录或报错。
    db.onModuleDestroy();
    db = new DatabaseService(new ConfigurationService());
    assert.deepEqual(versions(), [1, 2, 3, 4]);
    assert.equal(
      (
        db.connection
          .prepare(
            "SELECT count(*) AS n FROM schema_migrations WHERE version=3",
          )
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    db?.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
    delete process.env.AGENDA_LINK_WORKSPACE;
  }
});
