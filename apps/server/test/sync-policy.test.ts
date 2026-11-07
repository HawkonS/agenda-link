import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextSyncAt,
  syncPolicySchema,
  syncPolicyPatchSchema,
} from "../src/sync-policy.js";

const at = (time: string) => Date.parse(time);
test("sync schedule validates strict partial patches without inserting defaults", () => {
  assert.deepEqual(
    syncPolicyPatchSchema.parse({ overwriteDepartments: true }),
    { overwriteDepartments: true },
  );
  assert.deepEqual(syncPolicyPatchSchema.parse({}), {});
  for (const value of [
    { intervalMinutes: 0 },
    { intervalMinutes: 10081 },
    { intervalMinutes: 1.5 },
    { dailyTime: "24:00" },
    { dailyTime: "03:60" },
    { dailyTime: "3:00" },
    { automaticMode: "cron" },
    { role: "system_admin" },
  ]) {
    assert.equal(
      syncPolicyPatchSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  }
});

test("disabled and interval schedules respect their saved execution boundary", () => {
  const now = at("2030-01-01T00:00:00Z");
  assert.equal(nextSyncAt(syncPolicySchema.parse({}), undefined, now), null);
  const policy = syncPolicySchema.parse({
    automaticMode: "interval",
    intervalMinutes: 30,
  });
  assert.equal(nextSyncAt(policy, undefined, now), now);
  assert.equal(nextSyncAt(policy, "invalid", now), now);
  assert.equal(
    nextSyncAt(policy, "2029-12-31T23:45:00Z", now),
    now + 15 * 60000,
  );
});

test("daily schedules use Beijing time, run once per day and catch up once after downtime", () => {
  const policy = syncPolicySchema.parse({
    automaticMode: "daily",
    dailyTime: "03:00",
  });
  assert.equal(
    nextSyncAt(policy, undefined, at("2030-01-01T16:00:00Z")),
    at("2030-01-01T19:00:00Z"),
  );
  assert.equal(
    nextSyncAt(policy, "2030-01-01T18:59:59Z"),
    at("2030-01-01T19:00:00Z"),
  );
  assert.equal(
    nextSyncAt(policy, "2030-01-01T19:00:00Z"),
    at("2030-01-02T19:00:00Z"),
  );
  assert.equal(
    nextSyncAt(policy, "2030-01-01T20:00:00Z", at("2030-01-05T21:00:00Z")),
    at("2030-01-02T19:00:00Z"),
  );
  // A successful catch-up records the current attempt, preventing a loop through missed days.
  assert.equal(
    nextSyncAt(policy, "2030-01-05T21:00:00Z"),
    at("2030-01-06T19:00:00Z"),
  );
  assert.equal(
    nextSyncAt(policy, "2030-12-31T19:00:00Z"),
    at("2031-01-01T19:00:00Z"),
  );
  assert.equal(
    nextSyncAt(policy, "2032-02-28T19:00:00Z"),
    at("2032-02-29T19:00:00Z"),
  );
});
