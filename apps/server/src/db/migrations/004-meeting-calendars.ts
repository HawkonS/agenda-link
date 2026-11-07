import type { Migration } from "./runner.js";

/** 一个会议可以关联多个日程平台，每个平台各有一条事件记录。 */
export const meetingCalendars: Migration = {
  version: 4,
  name: "meeting-calendars",
  up({ connection }) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS meeting_calendar_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL,
        calendar_id TEXT,
        event_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_calendar_targets_meeting
        ON meeting_calendar_targets(meeting_id);
      INSERT OR IGNORE INTO meeting_calendar_targets
        (meeting_id, connection_id, calendar_id, event_id, status, error, created_at, updated_at)
      SELECT id, calendar_connection_id, calendar_id, calendar_event_id,
        CASE WHEN calendar_event_id IS NOT NULL AND calendar_event_id <> '' THEN 'synced' ELSE calendar_status END,
        calendar_error, created_at, updated_at
      FROM meetings
      WHERE calendar_connection_id IS NOT NULL AND calendar_connection_id <> '';
    `);
  },
};
