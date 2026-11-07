import { useLocation, useSearchParams } from "react-router-dom";

const tabsByPath: Record<string, { id: string; label: string }[]> = {
  "/meetings":[{id:"booking",label:"预约会议"},{id:"records",label:"预约记录"}],
  "/sync": [
    { id: "directory", label: "组织架构" },
    { id: "policy", label: "同步策略" },
    { id: "runs", label: "运行记录" },
  ],
  "/user-sync": [
    { id: "directory", label: "飞书用户" },
    { id: "policy", label: "同步策略" },
    { id: "rules", label: "许可规则" },
    { id: "runs", label: "运行记录" },
  ],
  "/calendar": [
    { id: "calendar", label: "日历视图" },
    { id: "list", label: "列表视图" },
  ],
  "/settings": [
    { id: "operations", label: "运行管理" },
    { id: "configuration", label: "配置管理" },
    { id: "business", label: "业务设置" },
    { id: "backups", label: "数据库备份" },
  ],
  "/audit-logs": [
    { id: "statistics", label: "统计" },
    { id: "logs", label: "日志文件" },
  ],
  "/profile": [
    { id: "details", label: "个人资料" },
    { id: "identity", label: "平台身份" },
    { id: "security", label: "登录安全" },
  ],
};

export function useWorkspaceTabs() {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tabs =
    pathname === "/calendar-templates" && searchParams.has("edit")
      ? [
          { id: "content", label: "日程内容" },
          { id: "settings", label: "提醒与设置" },
        ]
      : tabsByPath[pathname] || [];
  const legacy: Record<string, string> =
    pathname === "/settings"
      ? {
          branding: "configuration",
          login: "configuration",
          recording: "business",
          connections: "business",
          runtime: "configuration",
        }
      : pathname === "/audit-logs"
        ? { audit: "statistics", jobs: "statistics" }
        : { meetings: "list" };
  const tabId = requested ? legacy[requested] || requested : requested;
  const activeTab = tabs.find((tab) => tab.id === tabId)?.id || tabs[0]?.id;
  function setActiveTab(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id === tabs[0]?.id) next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next, { replace: true });
  }
  return { tabs, activeTab, setActiveTab };
}
