import { baseline } from "./001-baseline.js";
import { avatarBackfill } from "./002-avatar-backfill.js";
import { managementRecords } from "./003-management.js";
import { meetingCalendars } from "./004-meeting-calendars.js";
import type { Migration } from "./runner.js";

/** 新增迁移时在这里追加，版本号必须递增且不要复用。 */
export const migrations: Migration[] = [
  baseline,
  avatarBackfill,
  managementRecords,
  meetingCalendars,
];

export { migrationVersion, runMigrations } from "./runner.js";
export type { Migration, MigrationContext } from "./runner.js";
