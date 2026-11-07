import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { feishuAvatarUrl } from "../src/platforms/shared/feishu/avatar.js";
import { DatabaseService } from "../src/database.service.js";
import { ConfigurationService } from "../src/config/configuration.service.js";
import { users } from "../src/db/schema.js";

test("Feishu directory and OAuth avatars choose a valid image URL", () => {
  assert.equal(
    feishuAvatarUrl({
      avatar: {
        avatar_240: "https://example.com/240.png",
        avatar_origin: "https://example.com/original.png",
      },
    }),
    "https://example.com/240.png",
  );
  assert.equal(
    feishuAvatarUrl({ avatar_url: " https://example.com/oauth.png " }),
    "https://example.com/oauth.png",
  );
  assert.equal(
    feishuAvatarUrl({
      avatar: {
        avatar_240: "javascript:alert(1)",
        avatar_72: "https://example.com/72.png",
      },
    }),
    "https://example.com/72.png",
  );
  assert.equal(
    feishuAvatarUrl({ avatar_url: "data:image/png;base64,abc" }),
    null,
  );
  assert.equal(feishuAvatarUrl({}), null);
});

test("upgrading an existing database backfills only missing avatars from scoped Feishu snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-avatar-"));
  const previous = process.env.AGENDA_LINK_WORKSPACE;
  process.env.AGENDA_LINK_WORKSPACE = root;
  const config = new ConfigurationService();
  let db = new DatabaseService(config);
  try {
    db.db
      .insert(users)
      .values([
        {
          username: "login",
          displayName: "登录用户",
          feishuLoginOpenId: "login-open",
          feishuUserId: "stable",
          role: "operation_admin",
          systemAccess: "blocked",
          meetingUserType: "advanced",
        },
        {
          username: "sync",
          displayName: "同步用户",
          feishuOpenId: "sync-open",
          systemAccess: "not_added",
        },
        {
          username: "kept",
          displayName: "已有头像",
          feishuLoginOpenId: "kept-open",
          avatarUrl: "https://example.com/keep.jpg",
        },
        {
          username: "different-app",
          displayName: "另一应用用户",
          feishuOpenId: "login-open",
        },
      ])
      .run();
    db.setState(
      "system-users.feishu-preview",
      JSON.stringify({
        people: [
          {
            open_id: "login-open",
            user_id: "stable",
            avatar: { avatar_240: "https://example.com/login.jpg" },
          },
          {
            open_id: "kept-open",
            avatar: { avatar_240: "https://example.com/stale.jpg" },
          },
        ],
      }),
    );
    db.setState(
      "sync.snapshot.users",
      JSON.stringify({
        people: [
          {
            open_id: "sync-open",
            avatar: { avatar_640: "https://example.com/sync.jpg" },
          },
        ],
      }),
    );
    db.connection.exec(
      "DELETE FROM schema_migrations WHERE version=2; ALTER TABLE users DROP COLUMN avatar_url",
    );
    // Simulate a database created before the avatar column was introduced.
    db.onModuleDestroy();
    db = new DatabaseService(config);
    const login = db.db
      .select()
      .from(users)
      .where(eq(users.username, "login"))
      .get()!;
    assert.equal(login.avatarUrl, "https://example.com/login.jpg");
    assert.equal(login.role, "operation_admin");
    assert.equal(login.systemAccess, "blocked");
    assert.equal("meetingUserType" in login,false);
    assert.equal(
      db.db.select().from(users).where(eq(users.username, "sync")).get()!
        .avatarUrl,
      "https://example.com/sync.jpg",
    );
    assert.equal(
      db.db
        .select()
        .from(users)
        .where(eq(users.username, "different-app"))
        .get()!.avatarUrl,
      null,
    );
    db.db
      .update(users)
      .set({ avatarUrl: "https://example.com/keep.jpg" })
      .where(eq(users.username, "kept"))
      .run();
    db.connection.exec("DELETE FROM schema_migrations WHERE version=2");
    db.onModuleDestroy();
    db = new DatabaseService(config);
    assert.equal(
      db.db.select().from(users).where(eq(users.username, "kept")).get()!
        .avatarUrl,
      "https://example.com/keep.jpg",
    );
  } finally {
    db.onModuleDestroy();
    if (previous === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
    else process.env.AGENDA_LINK_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
