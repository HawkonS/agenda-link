import { lazy, Suspense } from "react";
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useSearchParams,
} from "react-router-dom";
import { useSession } from "./lib/session";
import { Loading } from "./components/common/workspace";
const AppShell = lazy(() => import("./components/layout/AppShell"));
const Login = lazy(() => import("./pages/Login"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Meetings = lazy(() => import("./pages/MeetingWorkspace"));
const Calendar = lazy(() => import("./pages/Calendar"));
const Profile = lazy(() => import("./pages/Profile"));
const SystemUsers = lazy(() => import("./pages/SystemUsers"));
const UserSync = lazy(() => import("./pages/UserSync"));
const Sync = lazy(() => import("./pages/Sync"));
const Pools = lazy(() => import("./pages/Pools"));
const Templates = lazy(() => import("./pages/Templates"));
const AuditLogs = lazy(() => import("./pages/AuditLogs"));
const Settings = lazy(() => import("./pages/Settings"));
function CalendarRoute() {
  const [params] = useSearchParams();
  return params.has("create") ? (
    <Navigate to="/meetings?create=1" replace />
  ) : (
    <Calendar />
  );
}
function Guard({ role }: { role?: "operator" | "admin" }) {
  const { user, loading, isAdmin, isOperator } = useSession();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if ((role === "admin" && !isAdmin) || (role === "operator" && !isOperator))
    return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
export default function App() {
  const { user, loading } = useSession();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route
          path="/login"
          element={
            loading ? (
              <Loading />
            ) : user ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <Login />
            )
          }
        />
        <Route element={<Guard />}>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="meetings" element={<Meetings />} />
            <Route path="calendar" element={<CalendarRoute />} />
            <Route
              path="recordings"
              element={<Navigate to="/calendar?tab=list" replace />}
            />
            <Route path="profile" element={<Profile />} />
            <Route element={<Guard role="operator" />}>
              <Route path="directory" element={<Navigate to="/sync" replace />} />
              <Route path="user-sync" element={<UserSync />} />
              <Route path="sync" element={<Sync />} />
              <Route path="account-pools" element={<Pools />} />
              <Route path="calendar-templates" element={<Templates />} />
              <Route path="audit-logs" element={<AuditLogs />} />
            </Route>
            <Route element={<Guard role="admin" />}>
              <Route path="system-users" element={<SystemUsers />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
