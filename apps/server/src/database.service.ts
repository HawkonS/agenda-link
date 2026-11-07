import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { ConfigurationService } from "./config/configuration.service.js";
import * as schema from "./db/schema.js";
import { migrations, runMigrations } from "./db/migrations/index.js";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  connection!: Database.Database;
  db!: BetterSQLite3Database<typeof schema>;
  private readonly jobListeners = new Set<() => void>();
  private configuration!: ConfigurationService;

  onJobsAvailable(listener: () => void): () => void {
    this.jobListeners.add(listener);
    return () => this.jobListeners.delete(listener);
  }

  /** Notify after committing a queued job; SQLite remains the durable queue. */
  notifyJobs(): void {
    for (const listener of this.jobListeners) listener();
  }

  constructor(
    @Inject(ConfigurationService) configuration: ConfigurationService,
  ) {
    this.configuration = configuration;
    this.open(configuration.databasePath);
  }

  reopen(databasePath: string): void {
    if (this.connection.name === databasePath) return;
    this.connection.close();
    this.open(databasePath);
  }

  private open(databasePath: string) {
    this.connection = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    this.db = drizzle(this.connection, { schema });
    runMigrations(
      {
        connection: this.connection,
        configuration: this.configuration,
        getState: (key) => this.getState(key),
        setState: (key, value) => this.setState(key, value),
        recordMeetingSuccess: (id, event, at) =>
          this.recordMeetingSuccess(id, event, at),
      },
      migrations,
      { ensure: migrations[0] },
    );
  }

  recordMeetingSuccess(
    id: number,
    event: "created" | "cancelled",
    at = new Date().toISOString(),
  ) {
    this.connection
      .prepare(
        "INSERT OR IGNORE INTO meeting_success_events(meeting_id,event,occurred_at) VALUES(?,?,?)",
      )
      .run(id, event, at);
  }

  recordingSettings(): { ttlDays: number; deleteRemote: boolean } {
    return JSON.parse(
      this.getState("recording.settings") ||
        '{"ttlDays":30,"deleteRemote":true}',
    );
  }

  bookingDefaults(): {
    meetingConnectionId: string;
    calendarConnectionIds: string[];
  } {
    const value = JSON.parse(
      this.getState("booking.defaults") ||
        '{"meetingConnectionId":"","calendarConnectionIds":[]}',
    );
    return {
      meetingConnectionId:
        typeof value.meetingConnectionId === "string"
          ? value.meetingConnectionId
          : "",
      calendarConnectionIds: Array.isArray(value.calendarConnectionIds)
        ? value.calendarConnectionIds.filter(
            (id: unknown): id is string => typeof id === "string",
          )
        : [],
    };
  }

  cleanupSecurityState(now = Date.now()) {
    this.connection.transaction(() => {
      this.connection
        .prepare("DELETE FROM sessions WHERE expires_at<=?")
        .run(new Date(now).toISOString());
      this.connection
        .prepare(
          "DELETE FROM login_attempts WHERE window_start<? AND locked_until<=?",
        )
        .run(now - 86400000, now);
      this.connection
        .prepare(
          "DELETE FROM system_state WHERE key LIKE 'oauth:%' AND CAST(value AS INTEGER)<=?",
        )
        .run(now);
    })();
  }

  setState(key: string, value: string): void {
    this.db.run(
      sql`INSERT INTO system_state (key, value, updated_at) VALUES (${key}, ${value}, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    );
  }

  getState(key: string): string | undefined {
    const row = this.connection
      .prepare("SELECT value FROM system_state WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    return row?.value;
  }

  addAuditLog(action: string, detail: string, actorId?: string): void {
    if (action === "meeting.provisioned" || action === "meeting.cancelled") {
      const value = JSON.parse(detail);
      const id = typeof value === "number" ? value : value.id;
      this.recordMeetingSuccess(
        id,
        action === "meeting.provisioned" ? "created" : "cancelled",
      );
    }
    this.connection
      .prepare(
        "INSERT INTO audit_logs (action, actor_id, detail) VALUES (?, ?, ?)",
      )
      .run(action, actorId ?? null, detail);
  }

  onModuleDestroy(): void {
    this.jobListeners.clear();
    this.connection.close();
  }
}
