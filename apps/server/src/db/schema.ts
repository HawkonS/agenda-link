import {
  integer,
  sqliteTable,
  text,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
};

export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const platformConnections = sqliteTable("platform_connections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  configJson: text("config_json").notNull().default("{}"),
  lastError: text("last_error"),
  ...timestamps,
});

export const platformIdentities = sqliteTable("platform_identities", {
  id: integer("id").primaryKey({autoIncrement:true}),
  providerId: text("provider_id").notNull(),
  connectionId: text("connection_id").notNull(),
  kind: text("kind").notNull().default("person"),
  externalId: text("external_id").notNull(),
  stableId: text("stable_id"),
  userId: integer("user_id").references(() => users.id),
  name: text("name").notNull(),
  profileJson: text("profile_json").notNull().default("{}"),
  ...timestamps,
}, table => [uniqueIndex("idx_platform_identity_scope").on(table.connectionId,table.kind,table.externalId)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  actorId: text("actor_id"),
  detail: text("detail"),
  ...timestamps,
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  email: text("email"),
  passwordHash: text("password_hash"),
  role: text("role", { enum: ["system_admin", "operation_admin", "user"] })
    .notNull()
    .default("user"),
  feishuOpenId: text("feishu_open_id").unique(),
  feishuLoginOpenId: text("feishu_login_open_id").unique(),
  systemAccess: text("system_access", {
    enum: ["allowed", "blocked", "not_added"],
  })
    .notNull()
    .default("allowed"),
  feishuUserId: text("feishu_user_id").unique(),
  phone: text("phone"),
  source: text("source").notNull().default("local"),
  lastSeenAt: text("last_seen_at"),
  syncError: text("sync_error"),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  ...timestamps,
});

export const departments = sqliteTable("departments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId:text("provider_id").notNull().default("feishu"),
  connectionId:text("connection_id").notNull().default("feishu-directory"),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  parentExternalId: text("parent_external_id"),
  tencentDepartmentId: text("tencent_department_id"),
  path: text("path"),
  ...timestamps,
},table=>[uniqueIndex("idx_department_scope").on(table.connectionId,table.externalId)]);

export const userDepartments = sqliteTable("user_departments", {
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  departmentId: integer("department_id")
    .notNull()
    .references(() => departments.id, { onDelete: "cascade" }),
});

export const syncRules = sqliteTable("sync_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  departmentExternalId: text("department_external_id"),
  departmentName: text("department_name"),
  meetingUserType: text("meeting_user_type", { enum: ["ordinary", "advanced"] })
    .notNull()
    .default("advanced"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull().default("feishu"),
  status: text("status", { enum: ["running", "success", "failed"] }).notNull(),
  departmentsCount: integer("departments_count").notNull().default(0),
  usersCount: integer("users_count").notNull().default(0),
  error: text("error"),
  resultJson: text("result_json"),
  startedAt: text("started_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
});

export const meetingAccounts = sqliteTable("meeting_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  providerId: text("provider_id").notNull().default("tencent"),
  connectionId: text("connection_id").notNull().default("tencent-meeting"),
  accountId: text("account_id").notNull(),
  secretId: text("secret_id"),
  secretKey: text("secret_key"),
  status: text("status", { enum: ["available", "disabled", "error"] })
    .notNull()
    .default("available"),
  lastError: text("last_error"),
  verifiedAt: text("verified_at"),
  ...timestamps,
}, table => [uniqueIndex("idx_meeting_account_scope").on(table.connectionId,table.accountId)]);

export const accountPools = sqliteTable("account_pools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  providerId: text("provider_id").notNull().default("tencent"),
  connectionId: text("connection_id").notNull().default("tencent-meeting"),
  description: text("description"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  ...timestamps,
});

export const accountPoolMembers = sqliteTable("account_pool_members", {
  poolId: integer("pool_id")
    .notNull()
    .references(() => accountPools.id, { onDelete: "cascade" }),
  accountId: integer("account_id")
    .notNull()
    .references(() => meetingAccounts.id, { onDelete: "cascade" }),
});

export const calendarTemplates = sqliteTable("calendar_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  titleTemplate: text("title_template").notNull(),
  descriptionTemplate: text("description_template"),
  locationTemplate: text("location_template"),
  remindersJson: text("reminders_json"),
  extensionsJson: text("extensions_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  ...timestamps,
});

export const meetings = sqliteTable("meetings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: text("provider_id").notNull().default("tencent"),
  connectionId: text("connection_id").notNull().default("tencent-meeting"),
  calendarConnectionId: text("calendar_connection_id"),
  hostExternalId: text("host_external_id"),
  hostName: text("host_name"),
  calendarStatus: text("calendar_status").notNull().default("not_requested"),
  calendarError: text("calendar_error"),
  deletedAt: text("deleted_at"),
  subject: text("subject").notNull(),
  description: text("description"),
  calendarDescriptionText: text("calendar_description_text"),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  status: text("status", {
    enum: [
      "provisioning",
      "scheduled",
      "failed",
      "unknown",
      "cancelling",
      "cancel_failed",
      "cancelled",
      "finished",
    ],
  })
    .notNull()
    .default("provisioning"),
  externalMeetingId: text("external_meeting_id"),
  meetingCode: text("meeting_code"),
  providerResponseJson: text("provider_response_json"),
  meetingUrl: text("meeting_url"),
  calendarEventId: text("calendar_event_id"),
  calendarId: text("calendar_id"),
  requestKey: text("request_key").unique(),
  error: text("error"),
  provisionStep: text("provision_step").notNull().default("reserved"),
  accountPoolId: integer("account_pool_id").references(() => accountPools.id),
  allocationSource: text("allocation_source", {
    enum: ["personal", "invitee", "pool", "configured"],
  })
    .notNull()
    .default("pool"),
  meetingAccountId: integer("meeting_account_id").references(
    () => meetingAccounts.id,
  ),
  createdBy: integer("created_by").references(() => users.id),
  cohostEnabled: integer("cohost_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  recordingEnabled: integer("recording_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  recordingTtlDays: integer("recording_ttl_days").notNull().default(30),
  calendarTemplateId: integer("calendar_template_id").references(
    () => calendarTemplates.id,
  ),
  extensionsJson: text("extensions_json"),
  ...timestamps,
});

export const meetingCalendarTargets = sqliteTable("meeting_calendar_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  meetingId: integer("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull(),
  calendarId: text("calendar_id"),
  eventId: text("event_id"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  ...timestamps,
});

export const meetingAttendees = sqliteTable("meeting_attendees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  meetingId: integer("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id),
  email: text("email"),
  displayName: text("display_name").notNull(),
  feishuOpenId: text("feishu_open_id"),
  feishuUserId: text("feishu_user_id"),
  externalId: text("external_id"),
  isCohost: integer("is_cohost", { mode: "boolean" }).notNull().default(true),
  cohostStatus: text("cohost_status").notNull().default("pending"),
  cohostError: text("cohost_error"),
});

export const recordings = sqliteTable("recordings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  meetingId: integer("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  status: text("status", {
    enum: [
      "scheduled",
      "processing",
      "ready",
      "expired",
      "failed",
      "unavailable",
      "deleting",
      "delete_failed",
      "deleted",
    ],
  })
    .notNull()
    .default("scheduled"),
  remoteUrl: text("remote_url"),
  objectUrl: text("object_url"),
  filesJson: text("files_json"),
  storageType: text("storage_type").notNull().default("remote"),
  lastPolledAt: text("last_polled_at"),
  deleteRemote: integer("delete_remote", { mode: "boolean" })
    .notNull()
    .default(true),
  expiresAt: text("expires_at"),
  error: text("error"),
  ...timestamps,
});

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  status: text("status", { enum: ["queued", "running", "success", "failed"] })
    .notNull()
    .default("queued"),
  payloadJson: text("payload_json"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  runAt: text("run_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  ...timestamps,
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
});
export const calendarEvents = sqliteTable("calendar_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: text("provider_id").notNull().default("feishu"),
  connectionId: text("connection_id").notNull().default("feishu-calendar"),
  deletedAt: text("deleted_at"),
  creationUncertain: integer("creation_uncertain", { mode: "boolean" })
    .notNull()
    .default(false),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  subject: text("subject").notNull(),
  description: text("description"),
  calendarDescriptionText: text("calendar_description_text"),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  calendarEventId: text("calendar_event_id"),
  calendarId: text("calendar_id"),
  requestKey: text("request_key").notNull().unique(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  ...timestamps,
});
export const schema = {
  sessions,
  calendarEvents,
  systemState,
  platformConnections,
  platformIdentities,
  auditLogs,
  users,
  departments,
  userDepartments,
  syncRules,
  syncRuns,
  meetingAccounts,
  accountPools,
  accountPoolMembers,
  calendarTemplates,
  meetings,
  meetingAttendees,
  recordings,
  jobs,
};

export const recordAnnotations = sqliteTable(
  "record_annotations",
  {
    kind: text("kind").notNull(),
    recordId: integer("record_id").notNull(),
    note: text("note").notNull().default(""),
    handled: integer("handled", { mode: "boolean" }).notNull().default(false),
    updatedBy: integer("updated_by"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.kind, table.recordId] })],
);
export const meetingSuccessEvents = sqliteTable(
  "meeting_success_events",
  {
    meetingId: integer("meeting_id").notNull(),
    event: text("event").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.meetingId, table.event] })],
);
