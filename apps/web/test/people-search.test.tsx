import { describe, expect, it } from "vitest";
import { matchesPeopleSearch } from "../src/lib/people-search";

describe("people search", () => {
  it.each([
    "",
    "  ",
    "李",
    "小明",
    "lxm",
    "LXM",
    "ＬＸＭ",
    " lxm ",
    "lixiaoming",
    "xiaoming",
    "l x m",
  ])("matches Chinese names, pinyin and initials: %s", (query) =>
    expect(matchesPeopleSearch("李小明（我）", query)).toBe(true),
  );
  it("keeps account IDs and Chinese metadata searchable", () => {
    expect(matchesPeopleSearch("张三（meeting-host-12）", "HOST-12")).toBe(
      true,
    );
    expect(matchesPeopleSearch("李四（尚未同步腾讯身份）", "未同步")).toBe(
      true,
    );
  });
  it("does not match unrelated names or input", () => {
    expect(matchesPeopleSearch("张三", "lxm")).toBe(false);
    expect(matchesPeopleSearch("李小明", "nobody")).toBe(false);
    expect(matchesPeopleSearch("", "lxm")).toBe(false);
  });
});
