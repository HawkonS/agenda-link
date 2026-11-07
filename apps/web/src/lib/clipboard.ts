import { toast } from "sonner";

export async function copyText(value: string, label: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const focused = document.activeElement as HTMLElement | null;
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      (focused?.closest('[role="dialog"]') || document.body).appendChild(
        textarea,
      );
      try {
        textarea.select();
        if (!document.execCommand("copy")) throw new Error("Copy failed");
      } finally {
        textarea.remove();
        focused?.focus({ preventScroll: true });
      }
    }
    toast.success(`${label}已复制`);
  } catch {
    toast.error(
      `复制失败，请手动选择${label === "日程说明" ? "说明内容" : label}`,
    );
  }
}
