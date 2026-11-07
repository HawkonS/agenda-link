import {
  feishuAvatarUrl,
  type FeishuAvatarSource,
} from "../../platforms/shared/feishu/avatar.js";
import type { Migration } from "./runner.js";

/** 从历史同步快照里补回飞书头像。 */
export const avatarBackfill: Migration = {
  version: 2,
  name: "feishu-avatar-backfill",
  up({ connection, getState }) {
    for (const [key, openIdColumn] of [
      ["system-users.feishu-preview", "feishu_login_open_id"],
      ["sync.snapshot.users", "feishu_open_id"],
    ] as const) {
      const raw = getState(key);
      if (!raw) continue;
      let people: (FeishuAvatarSource & {
        open_id?: string;
        user_id?: string;
      })[];
      try {
        people = JSON.parse(raw).people;
      } catch {
        continue;
      }
      if (!Array.isArray(people)) continue;
      for (const person of people) {
        if (!person || typeof person !== "object") continue;
        const avatarUrl = feishuAvatarUrl(person);
        if (!avatarUrl) continue;
        const stableId =
          typeof person.user_id === "string" ? person.user_id : null;
        const row = (
          stableId
            ? connection
                .prepare("SELECT id FROM users WHERE feishu_user_id=?")
                .get(stableId)
            : undefined
        ) as { id: number } | undefined;
        if (row)
          connection
            .prepare(
              "UPDATE users SET avatar_url=? WHERE id=? AND (avatar_url IS NULL OR avatar_url='')",
            )
            .run(avatarUrl, row.id);
        else if (typeof person.open_id === "string" && person.open_id)
          connection
            .prepare(
              `UPDATE users SET avatar_url=? WHERE ${openIdColumn}=? AND (feishu_user_id IS NULL OR feishu_user_id=?) AND (avatar_url IS NULL OR avatar_url='')`,
            )
            .run(avatarUrl, person.open_id, stableId);
      }
    }
  },
};
