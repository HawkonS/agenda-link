import { test } from "node:test";
import assert from "node:assert/strict";
import { nextDate, resolveTimeZone, zonedDayStart } from "../src/timezone.js";

test("date helpers follow the configured time zone", () => {
  // 2026-11-03 00:00 Asia/Shanghai == 2026-11-02 16:00 UTC
  assert.equal(
    zonedDayStart("2026-11-03", "Asia/Shanghai"),
    Date.UTC(2026, 10, 2, 16),
  );
  assert.equal(zonedDayStart("2026-11-03", "UTC"), Date.UTC(2026, 10, 3));
  assert.equal(nextDate("2026-12-31"), "2027-01-01");
  assert.equal(resolveTimeZone("UTC"), "UTC");
  assert.equal(resolveTimeZone("Not/AZone"), "Asia/Shanghai");
  assert.equal(resolveTimeZone(""), "Asia/Shanghai");
});
