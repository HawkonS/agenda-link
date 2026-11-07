import { WorkspaceTabStrip } from "./WorkspaceTabStrip";
import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  CalendarDays,
  FolderTree,
  Home,
  KeyRound,
  Layers3,
  LogOut,
  Menu,
  ScrollText,
  Settings2,
  Users,
  UsersRound,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "../../lib/session";
import { cn, roleText } from "../../lib/utils";
import { Button } from "../ui/button";
import { BUILD_NUMBER, BUILD_TIME, formatBuildTime } from "../../lib/build-info";
import { UserAvatar } from "../common/UserAvatar";
import { useWorkspaceTabs } from "../../lib/workspace-tabs";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
const groups: {
  title: string;
  role?: "operator" | "admin";
  items: {
    path: string;
    label: string;
    icon: LucideIcon;
    role?: "admin" | "operator";
  }[];
}[] = [
  {
    title: "协作",
    items: [
      { path: "/dashboard", label: "首页概览", icon: Home },
      { path: "/meetings", label: "会议管理", icon: Video },
      { path: "/calendar", label: "日程管理", icon: CalendarDays },
    ],
  },
  {
    title: "运营",
    role: "operator",
    items: [
      { path: "/sync", label: "组织同步", icon: FolderTree },
      { path: "/user-sync", label: "人员同步", icon: UsersRound },
      { path: "/account-pools", label: "账号资源", icon: Layers3 },
      { path: "/calendar-templates", label: "日程模板", icon: CalendarDays },
    ],
  },
  {
    title: "系统",
    role: "operator",
    items: [
      {
        path: "/system-users",
        label: "账号权限",
        icon: KeyRound,
        role: "admin",
      },
      { path: "/audit-logs", label: "日志统计", icon: ScrollText },
      { path: "/settings", label: "系统设置", icon: Settings2, role: "admin" },
    ],
  },
];
export default function AppShell() {
  const { user, isAdmin, isOperator, branding, logout } = useSession(),
    location = useLocation();
  const {
    tabs: contextTabs,
    activeTab: activeContextTab,
    setActiveTab: setContextTab,
  } = useWorkspaceTabs();
  const [mobile, setMobile] = useState(false),
    [signingOut, setSigningOut] = useState(false);
  const visible = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => i.role !== "admin" || isAdmin),
    }))
    .filter(
      (g) =>
        !g.role ||
        (g.role === "admin" && isAdmin) ||
        (g.role === "operator" && isOperator),
    );
  const currentGroup = visible.find((g) =>
    g.items.some((i) => i.path === location.pathname),
  );
  const current =
    currentGroup?.items.find((i) => i.path === location.pathname)?.label ||
    (location.pathname === "/sync"
      ? "组织同步"
      : location.pathname === "/user-sync"
        ? "人员同步"
        : "我的信息");
  async function leave() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  }
  const brand = (
    <Link
      to="/dashboard"
      className="app-brand"
      onClick={() => setMobile(false)}
    >
      <img src={branding.logo || "/logo.svg"} alt="" />
      <strong title={branding.name}>{branding.name}</strong>
    </Link>
  );
  const navigation = (
    <>
      <div className="sidebar-brand">{brand}</div>
      <nav className="sidebar-nav" aria-label="主导航">
        {visible.map((g) => (
          <section key={g.title}>
            <div className="nav-caption">{g.title}</div>
            <div className="grid gap-1">
              {g.items.map((i) => (
                <NavLink
                  key={i.path}
                  to={i.path}
                  onClick={() => setMobile(false)}
                  className={({ isActive }) =>
                    cn(
                      "nav-link",
                      isActive && "active",
                    )
                  }
                >
                  <i.icon aria-hidden="true" />
                  <span>{i.label}</span>
                </NavLink>
              ))}
            </div>
          </section>
        ))}
      </nav>
      <div className="sidebar-build">
        <div>{BUILD_NUMBER}</div>
        <div>最后更新: {formatBuildTime(BUILD_TIME)}</div>
      </div>
    </>
  );
  return (
    <div className="app-shell">
      <aside className="app-sidebar">{navigation}</aside>
      <Dialog open={mobile} onOpenChange={setMobile}>
        <DialogContent
          placement="custom"
          className="mobile-navigation data-[state=open]:animate-none data-[state=closed]:animate-none"
          aria-describedby={undefined}
          hideClose
        >
          <DialogTitle className="sr-only">导航菜单</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="mobile-navigation-close"
            aria-label="收起导航"
            onClick={() => setMobile(false)}
          >
            <X />
          </Button>
          {mobile && navigation}
        </DialogContent>
      </Dialog>
      <div className="app-workspace">
        <header className="app-topbar">
          <div className="topbar-leading">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="打开导航"
              onClick={() => setMobile(true)}
            >
              <Menu />
            </Button>
            <div className="lg:hidden min-w-0">{brand}</div>
            <div className="topbar-context">
              {contextTabs.length > 0 ? (
                <WorkspaceTabStrip label={current} activeId={activeContextTab}>
                  {contextTabs.map((tab, index) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      id={`workspace-tab-${tab.id}`}
                      aria-controls="workspace-panel"
                      aria-selected={activeContextTab === tab.id}
                      tabIndex={activeContextTab === tab.id ? 0 : -1}
                      className="topbar-context-tab"
                      onClick={() => setContextTab(tab.id)}
                      onKeyDown={(event) => {
                        const next =
                          event.key === "ArrowRight"
                            ? (index + 1) % contextTabs.length
                            : event.key === "ArrowLeft"
                              ? (index + contextTabs.length - 1) %
                                contextTabs.length
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? contextTabs.length - 1
                                  : undefined;
                        if (next === undefined) return;
                        event.preventDefault();
                        setContextTab(contextTabs[next]!.id);
                        const target =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            "[role=tab]",
                          )[next];
                        target?.focus();
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </WorkspaceTabStrip>
              ) : (
                <span className="topbar-page-tag">{current}</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <Link to="/profile" className="topbar-profile">
              <UserAvatar
                name={user?.displayName || user?.username}
                src={user?.avatarUrl}
              />
              <div className="hidden sm:block">
                <span className="block text-sm font-medium">
                  {user?.displayName || user?.username}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {roleText[user?.role || "user"] ===
                  (user?.displayName || user?.username)
                    ? `@${user?.username}`
                    : roleText[user?.role || "user"]}
                </span>
              </div>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              disabled={signingOut}
              onClick={() => void leave()}
            >
              <LogOut />
            </Button>
          </div>
        </header>
        <main className="app-main app-main--fixed">
          <div className="page-container">
            <Outlet />
          </div>
          {branding.footer && (
            <footer className="app-footer">{branding.footer}</footer>
          )}
        </main>
      </div>
    </div>
  );
}
