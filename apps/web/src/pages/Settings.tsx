import { Navigate, useSearchParams } from "react-router-dom";
import { useWorkspaceTabs } from "../lib/workspace-tabs";
import { RuntimeManagement } from "../components/system/RuntimeManagement";
import { ConfigurationEditor } from "../components/system/ConfigurationEditor";
import { BusinessSettings } from "../components/system/BusinessSettings";
import { BackupManagement } from "../components/system/BackupManagement";
export default function Settings() {
  const [params] = useSearchParams();
  const { activeTab } = useWorkspaceTabs();
  if (["jobs", "logs"].includes(params.get("tab") || ""))
    return <Navigate to={`/audit-logs?tab=${params.get("tab")}`} replace />;
  if (params.get("tab") === "sync")
    return <Navigate to="/sync?tab=policy" replace />;
  return (
    <div className="page-shell page-shell--settings">
      <h1 className="sr-only">系统设置</h1>
      <div
        className={`settings-section-body settings-section-body--${activeTab}`}
        id="workspace-panel"
        role="tabpanel"
        aria-labelledby={`workspace-tab-${activeTab}`}
      >
        {activeTab === "operations" ? (
          <RuntimeManagement />
        ) : activeTab === "configuration" ? (
          <ConfigurationEditor />
        ) : activeTab === "backups" ? (
          <BackupManagement />
        ) : (
          <BusinessSettings />
        )}
      </div>
    </div>
  );
}
