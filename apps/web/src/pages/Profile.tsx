import { ValidatedForm } from "../components/common/ValidatedForm";
import { passwordSchema, profileSchema } from "../lib/form-schemas";
import { useEffect, useState } from "react";
import { Link2, Save, ShieldCheck, UserRound } from "lucide-react";
import { request } from "../api";
import { usePage, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { useWorkspaceTabs } from "../lib/workspace-tabs";
import { roleText } from "../lib/utils";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/common/UserAvatar";
import { Panel, QueryState, TextField } from "../components/common/workspace";
export default function Profile() {
  const { activeTab } = useWorkspaceTabs();
  const { reload } = useSession(),
    q = usePage("profile", () => request("/profile")),
    { saving, act } = useAction();
  const [form, setForm] = useState({ displayName: "", email: "" }),
    [password, setPassword] = useState({
      currentPassword: "",
      newPassword: "",
    });
  useEffect(() => {
    if (q.data)
      setForm({ displayName: q.data.displayName, email: q.data.email || "" });
  }, [q.data]);
  return (
    <div
      className="page-shell page-shell--profile"
      id="workspace-panel"
      role="tabpanel"
      aria-labelledby={`workspace-tab-${activeTab}`}
    >
      <QueryState
        loading={q.isLoading}
        error={q.isError}
        retry={() => void q.refetch()}
      >
        {activeTab === "details" && (
          <Panel title="个人资料" className="content-panel">
            <ValidatedForm
              values={form}
              schema={profileSchema}
              className="card-scroll p-5 space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await request("/profile", "PATCH", form);
                  await reload();
                }, "资料已保存");
              }}
            >
              <div className="flex items-center gap-3 pb-3 border-b">
                <UserAvatar
                  name={q.data?.displayName}
                  src={q.data?.avatarUrl}
                  className="h-12 w-12 text-lg"
                />
                <div>
                  <h2 className="font-semibold text-sm">
                    {q.data?.displayName}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {roleText[q.data?.role || "user"] === q.data?.displayName
                      ? `@${q.data?.username}`
                      : roleText[q.data?.role || "user"]}
                  </span>
                </div>
              </div>
              <TextField label="账号" value={q.data?.username} disabled />
              <TextField
                name="displayName"
                label="显示名称"
                value={form.displayName}
                onChange={(v) => setForm((f) => ({ ...f, displayName: v }))}
                required
              />
              <TextField
                name="email"
                label="邮箱"
                value={form.email}
                type="email"
                onChange={(v) => setForm((f) => ({ ...f, email: v }))}
              />
              <Button disabled={saving}>
                <Save />
                保存资料
              </Button>
            </ValidatedForm>
          </Panel>
        )}
        {activeTab === "identity" && (
          <Panel title="平台身份" className="content-panel">
            <div className="card-scroll p-5 space-y-5">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-muted">
                  <Link2 className="h-4 w-4" />
                </span>
                <div className="flex-1">
                  <p className="text-xs font-medium">飞书身份</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {q.data?.feishuLoginOpenId ? "已绑定飞书账号" : "尚未绑定"}
                  </p>
                </div>
                {!q.data?.feishuLoginOpenId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() =>
                      void act(async () => {
                        window.location.assign(
                          (await request("/auth/feishu/url?bind=true")).url,
                        );
                      })
                    }
                  >
                    绑定飞书
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-3 border-t pt-5">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-muted">
                  <UserRound className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs font-medium">平台身份</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {q.data?.platformIdentities?.map((p:any)=>`${p.connectionId}: ${p.externalId}`).join("、") || "尚未导入"}
                  </p>
                </div>
              </div>
            </div>
          </Panel>
        )}
        {activeTab === "security" && (
          <Panel
            title="登录安全"
            description="修改本地密码后需要重新登录"
            className="content-panel"
          >
            <ValidatedForm
              values={password}
              schema={passwordSchema}
              className="card-scroll p-5 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await request("/profile/password", "POST", password);
                  await reload();
                }, "密码已修改，请重新登录");
              }}
            >
              <TextField
                name="currentPassword"
                label="当前密码"
                type="password"
                value={password.currentPassword}
                onChange={(v) =>
                  setPassword((p) => ({ ...p, currentPassword: v }))
                }
                autoComplete="current-password"
                required
              />
              <TextField
                name="newPassword"
                label="新密码"
                type="password"
                minLength={12}
                value={password.newPassword}
                onChange={(v) => setPassword((p) => ({ ...p, newPassword: v }))}
                autoComplete="new-password"
                required
                hint="至少 12 位"
              />
              <Button variant="outline" disabled={saving}>
                <ShieldCheck />
                修改密码
              </Button>
            </ValidatedForm>
          </Panel>
        )}
      </QueryState>
    </div>
  );
}
