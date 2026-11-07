const labels: Record<string, string> = {
  personal: "本人高级账号",
  invitee: "受邀人高级账号",
  pool: "账号池",
  configured:"默认归属人",
};
export const hostSourceLabel = (source: string) => labels[source] || "主持账号";

export type HostPreview =
  | {
      available: true;
      allocationSource: "personal" | "invitee" | "pool" | "configured";
      hostAccountId: string;
      hostAccountName: string;
      accountPoolId: number | null;
      accountPoolName: string | null;
    }
  | { available: false; reason: string };

export function hostPreference(selection: string): {
  hostMode?: "pool" | "person";
  hostUserId?: number;
} {
  if (selection === "pool") return { hostMode: "pool" };
  if (selection.startsWith("person:"))
    return { hostMode: "person", hostUserId: Number(selection.slice(7)) };
  return {};
}
