import { ValidatedForm } from "../components/common/ValidatedForm";
import { userSchema } from "../lib/form-schemas";
import { useState } from "react";
import { Download, Plus, Users } from "lucide-react";
import { request } from "../api";
import { UserAvatar } from "../components/common/UserAvatar";
import { useAction, usePage } from "../lib/hooks";
import { roleText } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  PageHeader,
  Panel,
  QueryState,
  DataTable,
  Modal,
  FormActions,
  TextField,
  SelectField,
  SearchBox,
  Confirm,
} from "../components/common/workspace";
import { OptionSelect } from "../components/common/OptionSelect";
const empty = () => ({
  username: "",
  displayName: "",
  email: "",
  phone: "",
  password: "",
  role: "user",
  systemAccess: "allowed",
});
const roles = [
  { value: "user", label: "普通用户" },
  { value: "operation_admin", label: "运营管理员" },
  { value: "system_admin", label: "系统管理员" },
];
export default function SystemUsers() {
  const q = usePage("system-users", () => request("/system-users"));
  const { saving, act } = useAction();
  const [search, setSearch] = useState(""),
    [roleFilter, setRoleFilter] = useState(""),
    [loginFilter, setLoginFilter] = useState(""),
    [bindingFilter, setBindingFilter] = useState(""),
    [open, setOpen] = useState(false),
    [id, setId] = useState<number>(),
    [form, setForm] = useState(empty());
  const [preview, setPreview] = useState<any>(),
    [previewOpen, setPreviewOpen] = useState(false),
    [previewSearch, setPreviewSearch] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [importRole, setImportRole] = useState("user"),
    [bindTarget, setBindTarget] = useState<any>();
  const rows = (q.data || [])
    .filter((p: any) =>
      `${p.displayName} ${p.username} ${p.email || ""} ${p.phone || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .filter((p: any) => !roleFilter || p.role === roleFilter)
    .filter((p: any) => {
      if (!loginFilter) return true;
      const allowed =
        p.systemAccess === "allowed" && p.status !== "disabled";
      return loginFilter === "allowed" ? allowed : !allowed;
    })
    .filter((p: any) => {
      if (!bindingFilter) return true;
      return bindingFilter === "bound"
        ? Boolean(p.feishuLoginOpenId)
        : !p.feishuLoginOpenId;
    });
  function edit(row?: any) {
    setId(row?.id);
    setForm(
      row
        ? {
            ...empty(),
            ...row,
            email: row.email || "",
            phone: row.phone || "",
            password: "",
          }
        : empty(),
    );
    setOpen(true);
  }
  function set(k: keyof ReturnType<typeof empty>, value: string) {
    setForm((current) => ({ ...current, [k]: value }));
  }
  async function read(target?: any) {
    setBindTarget(target);
    setPreviewSearch("");
    setSelected([]);
    setImportRole("user");
    const ok = await act(async () =>
      setPreview(await request("/system-users/feishu-preview", "POST")),
    );
    if (ok) setPreviewOpen(true);
  }
  const candidates = (preview?.people || []).filter((p: any) =>
    `${p.name} ${p.email || ""} ${p.mobile || ""} ${p.departmentNames?.join(" ") || ""}`.includes(
      previewSearch,
    ),
  );
  const selectable = candidates.filter(
    (p: any) =>
      !p.status?.is_resigned &&
      !p.status?.is_frozen &&
      p.systemAccess === "not_added",
  );
  return (
    <div className="page-shell page-shell--table">
      <PageHeader title="账号权限" />
      <Panel
        className="table-panel"
        title="系统用户"
        description="只有已启用的用户才能登录系统。运营通讯录同步不会自动开放登录权限。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void read()}
            >
              <Download />
              从飞书添加
            </Button>
            <Button size="sm" onClick={() => edit()}>
              <Plus />
              手动添加
            </Button>
          </div>
        }
      >
        <div className="table-panel-toolbar system-users-toolbar">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="搜索姓名、账号、手机号或邮箱"
          />
          <div className="system-users-filters">
            <OptionSelect
              label="权限筛选"
              value={roleFilter}
              onChange={setRoleFilter}
              options={[
                { value: "", label: "全部权限" },
                ...roles,
              ]}
            />
            <OptionSelect
              label="登录状态筛选"
              value={loginFilter}
              onChange={setLoginFilter}
              options={[
                { value: "", label: "全部登录状态" },
                { value: "allowed", label: "允许登录" },
                { value: "disabled", label: "已停用" },
              ]}
            />
            <OptionSelect
              label="飞书绑定筛选"
              value={bindingFilter}
              onChange={setBindingFilter}
              options={[
                { value: "", label: "全部绑定状态" },
                { value: "bound", label: "已绑定" },
                { value: "unbound", label: "未绑定" },
              ]}
            />
            {(roleFilter || loginFilter || bindingFilter || search) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setRoleFilter("");
                  setLoginFilter("");
                  setBindingFilter("");
                }}
              >
                清空筛选
              </Button>
            )}
          </div>
        </div>
        <div className="table-panel-body">
          <QueryState
            loading={q.isLoading}
            error={q.isError}
            retry={() => void q.refetch()}
          >
            <DataTable
              rows={rows}
              emptyTitle="还没有可登录的用户"
              emptyHint="手动添加账号，或从配置文件中的飞书登录应用读取人员并授权。"
              columns={[
                {
                  key: "user",
                  title: "用户",
                  width: 170,
                  render: (p: any) => (
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <UserAvatar name={p.displayName} src={p.avatarUrl} />
                      <strong className="truncate text-sm" title={p.displayName}>
                        {p.displayName}
                      </strong>
                    </div>
                  ),
                },
                {
                  key: "username",
                  title: "账号",
                  width: 140,
                  render: (p: any) => (
                    <span className="block truncate text-xs" title={p.username}>
                      {p.username}
                    </span>
                  ),
                },
                {
                  key: "phone",
                  title: "手机号",
                  width: 145,
                  render: (p: any) => (
                    <span className="whitespace-nowrap text-xs">
                      {p.phone || "—"}
                    </span>
                  ),
                },
                {
                  key: "email",
                  title: "邮箱",
                  width: 190,
                  render: (p: any) => (
                    <span className="block truncate text-xs" title={p.email || ""}>
                      {p.email || "—"}
                    </span>
                  ),
                },
                {
                  key: "role",
                  title: "权限",
                  width: 112,
                  render: (p: any) => (
                    <span className="whitespace-nowrap text-xs">{roleText[p.role]}</span>
                  ),
                },
                {
                  key: "status",
                  title: "登录",
                  width: 112,
                  render: (p: any) => (
                    <span
                      className={`whitespace-nowrap text-xs ${p.systemAccess === "allowed" && p.status === "active" ? "text-emerald-700" : "text-muted-foreground"}`}
                    >
                      {p.systemAccess === "blocked"
                        ? "已停用"
                        : p.status === "disabled"
                          ? "飞书账号已停用"
                          : "允许登录"}
                    </span>
                  ),
                },
                {
                  key: "feishu",
                  title: "飞书",
                  width: 92,
                  render: (p: any) => (
                    <span
                      className={
                        p.feishuLoginOpenId
                          ? "text-emerald-700 text-xs"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {p.feishuLoginOpenId ? "已绑定" : "未绑定"}
                    </span>
                  ),
                },
                {
                  key: "actions",
                  title: "操作",
                  width: 190,
                  render: (p: any) => (
                    <div className="row-actions">
                      <Button variant="ghost" size="sm" onClick={() => edit(p)}>
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() => void read(p)}
                      >
                        {p.feishuLoginOpenId ? "修改绑定" : "绑定飞书"}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </QueryState>
        </div>
      </Panel>
      <Modal
        open={open}
        onClose={() => !saving && setOpen(false)}
        title={id ? "编辑系统用户" : "手动添加用户"}
        description="系统身份只控制本平台的使用权限，不会改变接入平台许可。"
        wide
      >
        <ValidatedForm
          values={form}
          schema={userSchema(!!id)}
          className="modal-form"
          footer={
            <FormActions saving={saving} onCancel={() => setOpen(false)} />
          }
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const payload: any = {
                username: form.username,
                displayName: form.displayName,
                email: form.email,
                phone: form.phone,
                password: form.password,
                role: form.role,
                systemAccess: form.systemAccess,
              };
              if (id) {
                delete payload.username;
                if (!payload.password) delete payload.password;
              }
              await request(
                `/system-users${id ? `/${id}` : ""}`,
                id ? "PATCH" : "POST",
                payload,
              );
              setOpen(false);
            }, "用户已保存");
          }}
        >
          <fieldset disabled={saving} className="space-y-4">
            <TextField
              name="username"
              label="登录账号"
              value={form.username}
              onChange={(v) => set("username", v)}
              disabled={!!id}
              required
              hint="使用字母、数字、下划线或邮箱。"
            />
            <div className="form-grid">
              <TextField
                name="displayName"
                label="姓名"
                value={form.displayName}
                onChange={(v) => set("displayName", v)}
                required
              />
              <TextField
                name="phone"
                label="手机号"
                value={form.phone}
                onChange={(v) => set("phone", v)}
              />
              <TextField
                name="email"
                label="邮箱"
                type="email"
                value={form.email}
                onChange={(v) => set("email", v)}
              />
              <SelectField
                name="role"
                label="系统身份"
                value={form.role}
                onChange={(v) => set("role", v)}
                options={roles}
              />
            </div>
            <TextField
              name="password"
              label={id ? "重置密码（留空不改）" : "初始密码"}
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={form.password}
              onChange={(v) => set("password", v)}
              required={!id}
              hint="至少 12 个字符。飞书登录用户也可以设置本地密码。"
            />
            <SelectField
              name="systemAccess"
              label="登录权限"
              value={form.systemAccess}
              onChange={(v) => set("systemAccess", v)}
              options={[
                { value: "allowed", label: "允许登录" },
                { value: "blocked", label: "停用，禁止登录" },
              ]}
            />
          </fieldset>
        </ValidatedForm>
      </Modal>
      <Modal
        open={previewOpen}
        onClose={() => !saving && setPreviewOpen(false)}
        title={
          bindTarget
            ? `为 ${bindTarget.displayName} 绑定飞书`
            : "从飞书添加系统用户"
        }
        description="数据来自配置文件中的飞书登录应用，需要该应用拥有通讯录读取权限。"
        wide
        className="user-import-modal"
        bodyClassName="user-import-body"
      >
        <div className="user-import-content">
          <SearchBox
            value={previewSearch}
            onChange={setPreviewSearch}
            placeholder="搜索飞书姓名、部门或手机号"
          />
          {!bindTarget && (
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label="选择所有可添加人员"
                  checked={
                    selectable.length > 0 &&
                    selectable.every((p: any) => selected.includes(p.open_id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [
                            ...new Set([
                              ...selected,
                              ...selectable.map((p: any) => p.open_id),
                            ]),
                          ]
                        : selected.filter(
                            (id) =>
                              !selectable.some((p: any) => p.open_id === id),
                          ),
                    )
                  }
                />
                选择当前结果
              </label>
              <span className="text-xs text-muted-foreground">
                已选择 {selected.length} 人
              </span>
            </div>
          )}
          <div className="user-import-table">
            <DataTable
              rows={candidates}
              emptyTitle="没有可见的飞书用户"
              emptyHint="请检查登录应用的通讯录权限与可见范围。"
              columns={[
                {
                  key: "select",
                  title: bindTarget ? "绑定" : "选择",
                  width: 72,
                  render: (p: any) =>
                    bindTarget ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          saving ||
                          (p.systemAccess !== "not_added" &&
                            p.systemUserId !== bindTarget.id)
                        }
                        onClick={() =>
                          void act(async () => {
                            await request(
                              `/system-users/${bindTarget.id}/feishu-binding`,
                              "POST",
                              { openId: p.open_id },
                            );
                            setPreviewOpen(false);
                          }, "飞书身份已绑定")
                        }
                      >
                        绑定
                      </Button>
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`添加 ${p.name}`}
                        disabled={
                          p.systemAccess !== "not_added" ||
                          p.status?.is_resigned ||
                          p.status?.is_frozen
                        }
                        checked={selected.includes(p.open_id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, p.open_id]
                              : selected.filter((id) => id !== p.open_id),
                          )
                        }
                      />
                    ),
                },
                {
                  key: "name",
                  title: "姓名",
                  width: 170,
                  render: (p: any) => (
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <UserAvatar name={p.name} src={p.avatarUrl} />
                      <strong className="truncate text-xs">{p.name}</strong>
                    </div>
                  ),
                },
                {
                  key: "phone",
                  title: "手机号",
                  width: 145,
                  render: (p: any) => (
                    <span className="whitespace-nowrap text-xs">
                      {p.mobile || "—"}
                    </span>
                  ),
                },
                {
                  key: "department",
                  title: "所属部门",
                  width: 260,
                  render: (p: any) => (
                    <span className="text-xs">
                      {p.departmentNames?.join("、") || "—"}
                    </span>
                  ),
                },
                {
                  key: "state",
                  title: "系统状态",
                  width: 130,
                  render: (p: any) => (
                    <span className="text-xs text-muted-foreground">
                      {p.systemAccess === "allowed"
                        ? "已添加"
                        : p.systemAccess === "blocked"
                          ? "已停用"
                          : "未添加"}
                    </span>
                  ),
                },
              ]}
            />
          </div>
          {bindTarget ? (
            bindTarget.feishuLoginOpenId && (
              <Confirm
                title="解除飞书绑定"
                description="解除后该用户不能再使用此飞书身份登录。本地密码登录仍按登录权限控制。"
                onConfirm={() =>
                  act(async () => {
                    await request(
                      `/system-users/${bindTarget.id}/feishu-binding`,
                      "POST",
                      { openId: null },
                    );
                    setPreviewOpen(false);
                  }, "飞书绑定已解除")
                }
              >
                {(show) => (
                  <Button variant="outline" disabled={saving} onClick={show}>
                    解除当前绑定
                  </Button>
                )}
              </Confirm>
            )
          ) : (
            <>
              <SelectField
                label="添加后的系统身份"
                value={importRole}
                onChange={setImportRole}
                options={roles}
              />
              <p className="text-xs text-muted-foreground">
                只添加选中的人员。已存在用户的身份和停用状态保持不变。
              </p>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => setPreviewOpen(false)}
                >
                  取消
                </Button>
                <Button
                  disabled={saving || !selected.length}
                  onClick={() =>
                    void act(async () => {
                      await request("/system-users/feishu-import", "POST", {
                        selectedIds: selected,
                        role: importRole,
                      });
                      setPreviewOpen(false);
                    }, "选中人员已获得系统登录权限")
                  }
                >
                  <Users />
                  添加 {selected.length} 位用户
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
