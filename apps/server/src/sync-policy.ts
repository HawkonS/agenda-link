import { z } from "zod";

export const syncPolicySchema = z.object({
  sourceConnectionId: z.string().default("feishu-directory"),
  targetConnectionId: z.string().default("tencent-meeting"),
  overwriteDepartments: z.boolean().default(false),
  overwriteUsers: z.boolean().default(false),
  preserveExistingPermissions: z.boolean().default(true),
  automaticMode: z.enum(["manual", "interval", "daily"]).default("manual"),
  intervalMinutes: z.number().int().min(1).max(10080).default(60),
  dailyTime: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .default("03:00"),
  disableMissingUsers: z.boolean().default(false),
});
// Patch fields have no defaults: saving one page must not reset the other page's rules.
export const syncPolicyPatchSchema = z
  .object({
    sourceConnectionId: z.string().min(1).max(100),
    targetConnectionId: z.string().min(1).max(100),
    overwriteDepartments: z.boolean(),
    overwriteUsers: z.boolean(),
    preserveExistingPermissions: z.boolean(),
    automaticMode: z.enum(["manual", "interval", "daily"]),
    intervalMinutes: z.number().int().min(1).max(10080),
    dailyTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    disableMissingUsers: z.boolean(),
  })
  .partial()
  .strict();
export type SyncPolicy = z.infer<typeof syncPolicySchema>;

/** Daily schedules use Beijing time regardless of the server's local timezone. */
export function nextSyncAt(
  policy: SyncPolicy,
  lastAttempt?: string,
  now = Date.now(),
): number | null {
  if (policy.automaticMode === "manual") return null;
  const parsed = Date.parse(lastAttempt || "");
  const last = Number.isFinite(parsed) ? parsed : now;
  if (policy.automaticMode === "interval")
    return Number.isFinite(parsed)
      ? last + policy.intervalMinutes * 60000
      : now;
  const beijingOffset = 8 * 3600000;
  const day = new Date(last + beijingOffset).toISOString().slice(0, 10);
  const today = Date.parse(`${day}T${policy.dailyTime}:00+08:00`);
  return !Number.isFinite(parsed) || today > last
    ? today
    : today + 24 * 3600000;
}
