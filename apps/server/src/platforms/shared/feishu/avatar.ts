export type FeishuAvatarSource = {
  avatar?: {
    avatar_72?: string;
    avatar_240?: string;
    avatar_640?: string;
    avatar_origin?: string;
  };
  avatar_url?: string;
};

export function feishuAvatarUrl(person: FeishuAvatarSource): string | null {
  for (const value of [
    person.avatar?.avatar_240,
    person.avatar?.avatar_640,
    person.avatar?.avatar_72,
    person.avatar?.avatar_origin,
    person.avatar_url,
  ]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        return url.href;
    } catch {}
  }
  return null;
}
