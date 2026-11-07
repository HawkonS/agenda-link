import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
export function usePage<T>(
  key: string,
  load: () => Promise<T>,
  poll: boolean | ((data: T | undefined) => number | false) = false,
) {
  return useQuery({
    queryKey: [key],
    queryFn: load,
    refetchInterval:
      typeof poll === "function"
        ? (query) => poll(query.state.data)
        : poll
          ? 10000
          : false,
  });
}
export function useAction() {
  const [saving, setSaving] = useState(false);
  const client = useQueryClient();
  async function act(fn: () => Promise<unknown>, message?: string) {
    if (saving) return false;
    setSaving(true);
    try {
      await fn();
      if (message) toast.success(message);
      await client.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== "branding",
      });
      return true;
    } catch (e) {
      if (!(e as any)?.isAxiosError)
        toast.error(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { saving, act };
}
