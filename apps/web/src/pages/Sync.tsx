import { ManagementRecords } from "../components/common/ManagementRecords";
import { DepartmentTree } from "../components/sync/DepartmentTree";
import { OptionSelect } from "../components/common/OptionSelect";
import { ValidatedForm } from "../components/common/ValidatedForm";
import {
  personSchema,
  ruleSchema,
  syncPolicyFormSchema,
} from "../lib/form-schemas";
import { useEffect, useState } from "react";
import { Download, FolderTree, Plus, RefreshCw, Save } from "lucide-react";
import { Link } from "react-router-dom";
import { useWorkspaceTabs } from "../lib/workspace-tabs";
import { request } from "../api";
import { UserAvatar } from "../components/common/UserAvatar";
import { usePage, useAction } from "../lib/hooks";
import { time } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  Panel,
  QueryState,
  DataTable,
  Modal,
  FormActions,
  Field,
  TextField,
  SelectField,
  Toggle,
  Status,
  Confirm,
  SearchBox,
  TableSelectionHeader,
} from "../components/common/workspace";
const ruleEmpty = () => ({
  name: "",
  departmentExternalId: "",
  departmentName: "",
  meetingUserType: "advanced",
  enabled: true,
});
export function DirectorySync({ scope }: { scope: "organization" | "users" }) {
  const organization = scope === "organization";
  const { activeTab } = useWorkspaceTabs();
  const platforms = usePage("platforms", () => request("/platforms"));
  const platformList = Array.isArray(platforms.data) ? platforms.data : [];
  const sourceConfigured = Boolean(
    platformList.find(
      (p: any) =>
        p.capability === "directory" &&
        p.connectionId === "feishu-directory",
    )?.configured,
  );
  const q = usePage(
    `sync-${scope}`,
    async () => {
      const [preview, rules, policy] = await Promise.all([
        request(`/sync/directory?scope=${scope}`),
        request("/sync/rules"),
        request("/sync/policy"),
      ]);
      return { preview, rules, policy };
    },
    true,
  );
  const syncTargets = platformList.filter(
    (p: any) =>
      p.capability === "directory" &&
      p.connectionId !== "feishu-directory" &&
      Array.isArray(p.syncFrom) &&
      p.syncFrom.includes("feishu-directory"),
  );
  const target =
    syncTargets.find(
      (p: any) =>
        p.connectionId ===
        (q.data?.policy?.targetConnectionId || "tencent-meeting"),
    ) || syncTargets[0];
  const targetName = target?.name || "目标平台";
  const targetConfigured = Boolean(target?.configured);
  const { saving, act } = useAction();
  const [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [department, setDepartment] = useState("");
  const [overwrite, setOverwrite] = useState(false),
    [preserve, setPreserve] = useState(true),
    [initialized, setInitialized] = useState(false);
  const [schedule, setSchedule] = useState({
    automaticMode: "manual",
    intervalMinutes: "60",
    dailyHour: "03",
    dailyMinute: "00",
    disableMissingUsers: false,
  });
  const [ruleOpen, setRuleOpen] = useState(false),
    [ruleId, setRuleId] = useState<number>(),
    [rule, setRule] = useState(ruleEmpty()),
    [person, setPerson] = useState<any>();
  useEffect(() => {
    if (q.data?.policy && !initialized) {
      setOverwrite(
        Boolean(
          organization
            ? q.data.policy.overwriteDepartments
            : q.data.policy.overwriteUsers,
        ),
      );
      setPreserve(q.data.policy.preserveExistingPermissions !== false);
      const policy = q.data.policy;
      const [dailyHour, dailyMinute] = (policy.dailyTime || "03:00").split(":");
      setSchedule({
        automaticMode: policy.automaticMode || "manual",
        intervalMinutes: String(policy.intervalMinutes || 60),
        dailyHour,
        dailyMinute,
        disableMissingUsers: !!policy.disableMissingUsers,
      });
      setInitialized(true);
    }
  }, [q.data, initialized, organization]);
  const preview = q.data?.preview || {},
    departments = preview.departments || [],
    people = preview.people || [];
  const rows = organization
    ? departments.filter((d: any) =>
        `${d.name} ${d.path || ""}`.includes(search),
      )
    : people.filter(
        (p: any) =>
          (!department || p.department_ids.includes(department)) &&
          `${p.name} ${p.phone || p.mobile || ""} ${p.email || ""} ${p.departmentNames?.join(" ") || ""}`.includes(
            search,
          ),
      );
  const key = (row: any) =>
    organization ? row.open_department_id : row.open_id;
  const selectedSet = new Set(selected);
  const resultIds = new Set<string>(rows.map(key));
  const selectedResults = rows.filter((row: any) =>
    selectedSet.has(key(row)),
  ).length;
  function select(id: string, checked: boolean) {
    setSelected((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((x) => x !== id),
    );
  }
  async function read() {
    await act(async () => {
      const data = await request("/sync/feishu/read", "POST", { scope }, 180_000);
      setSelected((organization ? data.departments : data.people).map(key));
    }, "飞书数据已读取，请核对并选择要同步的记录");
  }
  function editRule(row?: any) {
    setRuleId(row?.id);
    setRule(
      row
        ? {
            ...ruleEmpty(),
            ...row,
            departmentExternalId: row.departmentExternalId || "",
            departmentName: row.departmentName || "",
          }
        : ruleEmpty(),
    );
    setRuleOpen(true);
  }

  const submit = () =>
    act(
      () =>
        request(`/sync/${scope}`, "POST", {
          selectedIds: selected,
          fetchedAt: preview.fetchedAt,
          overwriteDepartments: organization ? overwrite : false,
          overwriteUsers: !organization ? overwrite : false,
          preserveExistingPermissions: preserve,
        }),
      "同步已排队，结果会显示在下方记录中",
    );
  const readButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={saving || !sourceConfigured}
      onClick={() => void read()}
      title={
        !sourceConfigured
          ? "请先在系统管理中配置飞书通讯录连接"
          : preview.fetchedAt
            ? `最近读取：${time(preview.fetchedAt)}`
            : undefined
      }
    >
      <Download />
      从飞书读取{organization ? "组织" : "用户"}
    </Button>
  );
  async function changeTarget(nextTarget: string) {
    await act(async () => {
      await request("/sync/policy", "PATCH", {
        targetConnectionId: nextTarget,
      });
      await q.refetch();
    }, "同步目标已更新");
  }
  const routeBar = (
    <div className="sync-route-bar">
      <span className="sync-route-label">数据来源</span>
      <strong>飞书</strong>
      <span className="sync-route-arrow" aria-hidden="true">→</span>
      <span className="sync-route-label">同步目标</span>
      {syncTargets.length > 0 ? (
        <OptionSelect
          className="sync-target-select"
          label="同步目标"
          value={target?.connectionId || ""}
          onChange={(value) => void changeTarget(value)}
          options={syncTargets.map((item: any) => ({
            value: item.connectionId,
            label: item.name + (item.configured ? "" : "（未配置）"),
          }))}
        />
      ) : (
        <span className="sync-route-empty">暂未接入可用的同步目标</span>
      )}
    </div>
  );
  const syncButton = (
    <Confirm
      title={`同步 ${selected.length} ${organization ? "个部门" : "位人员"}到${targetName}`}
      description={
        organization
          ? overwrite
            ? "将新增缺失部门，并覆盖已关联部门的名称和上级关系。"
            : "将新增缺失部门，已有部门保持原样。"
          : `将新增缺失人员，并把已有账号移动到飞书对应部门；姓名和联系方式${overwrite ? "会被飞书资料覆盖" : "保持原样"}；已有许可${preserve ? "保持原样" : "将按规则覆盖，可能发生降级"}。`
      }
      onConfirm={submit}
    >
      {(show) => (
        <Button
          size="sm"
          disabled={
            saving || !selected.length || !preview.fetchedAt || !targetConfigured
          }
          onClick={show}
          title={
            !preview.fetchedAt
              ? "请先从飞书读取"
              : !selected.length
                ? "请先勾选要同步的记录"
                : undefined
          }
        >
          <RefreshCw />
          同步所选
        </Button>
      )}
    </Confirm>
  );
  const setupBanner =
    !sourceConfigured || !targetConfigured ? (
      <div className="sync-setup-banner" role="status">
        <span>
          {!sourceConfigured
            ? "飞书通讯录尚未配置，无法读取组织架构。"
            : syncTargets.length === 0
              ? "尚未接入可用的同步目标。"
              : `${targetName}尚未配置，读取后也无法同步。`}
        </span>
        <Button size="sm" variant="outline" asChild>
          <Link to="/settings?tab=business">去配置</Link>
        </Button>
      </div>
    ) : null;
  const scheduleChanged =
    schedule.automaticMode !== (q.data?.policy?.automaticMode || "manual") ||
    schedule.intervalMinutes !==
      String(q.data?.policy?.intervalMinutes || 60) ||
    `${schedule.dailyHour}:${schedule.dailyMinute}` !==
      (q.data?.policy?.dailyTime || "03:00");
  function updateSchedule<K extends keyof typeof schedule>(
    field: K,
    value: (typeof schedule)[K],
  ) {
    setSchedule((current) => ({ ...current, [field]: value }));
  }
  async function savePolicy(event: React.FormEvent) {
    event.preventDefault();
    await act(
      () =>
        request("/sync/policy", "PATCH", {
          ...(organization
            ? { overwriteDepartments: overwrite }
            : {
                overwriteUsers: overwrite,
                preserveExistingPermissions: preserve,
                disableMissingUsers: schedule.disableMissingUsers,
              }),
          automaticMode: schedule.automaticMode,
          intervalMinutes:
            /^\d+$/.test(schedule.intervalMinutes) &&
            Number(schedule.intervalMinutes) >= 1 &&
            Number(schedule.intervalMinutes) <= 10080
              ? Number(schedule.intervalMinutes)
              : q.data?.policy?.intervalMinutes || 60,
          dailyTime: `${schedule.dailyHour}:${schedule.dailyMinute}`,
        }),
      "同步策略已保存",
    );
  }
  return (
    <div className="page-shell sync-page-shell">
      <QueryState
        loading={q.isLoading}
        error={q.isError}
        retry={() => void q.refetch()}
      >
        <div
          id="workspace-panel"
          role="tabpanel"
          aria-labelledby={`workspace-tab-${activeTab}`}
          className="sync-tab-panel"
        >
          {activeTab === "directory" && (
            <>
              {routeBar}
              {setupBanner}
              <Panel className="sync-data-panel">
                {organization ? (
                  <DepartmentTree
                    departments={departments}
                    selected={selected}
                    onSelectionChange={setSelected}
                    actions={
                      <div className="flex gap-2">
                        {readButton}
                        {syncButton}
                      </div>
                    }
                  />
                ) : (
                  <>
                    <div className="sync-toolbar">
                      <SearchBox
                        value={search}
                        onChange={setSearch}
                        placeholder={
                          organization
                            ? "搜索部门名称或路径"
                            : "搜索姓名、手机号或部门"
                        }
                      />
                      {!organization && (
                        <OptionSelect
                          className="department-filter"
                          label="筛选所属部门"
                          value={department}
                          onChange={setDepartment}
                          options={[
                            { value: "", label: "全部部门" },
                            ...departments.map((d: any) => ({
                              value: d.open_department_id,
                              label: d.path || d.name,
                            })),
                          ]}
                        />
                      )}
                      {readButton}
                      {syncButton}
                    </div>
                    <DataTable
                      rows={rows}
                      emptyTitle="先读取飞书用户"
                      emptyHint="请在系统设置中配置飞书同步机器人及通讯录权限，再点击右上角的读取按钮。"
                      columns={[
                        {
                          key: "select",
                          title: "选择",
                          width: 56,
                          header: (pageRows: any[], allRows: any[]) => (
                            <TableSelectionHeader
                              pageIds={pageRows.map(key)}
                              allIds={allRows.map(key)}
                              selectedIds={selectedSet}
                              onChange={(next) =>
                                setSelected([...next] as string[])
                              }
                            />
                          ),
                          render: (p: any) => (
                            <input
                              type="checkbox"
                              aria-label={`选择 ${p.name}`}
                              checked={selectedSet.has(key(p))}
                              onChange={(e) => select(key(p), e.target.checked)}
                            />
                          ),
                        },
                        {
                          key: "name",
                          title: "姓名",
                          width: 190,
                          render: (p: any) => (
                            <div className="flex items-center gap-2 whitespace-nowrap">
                              <UserAvatar name={p.name} src={p.avatarUrl} />
                              <strong className="truncate text-sm">{p.name}</strong>
                            </div>
                          ),
                        },
                        {
                          key: "phone",
                          title: "手机号",
                          width: 150,
                          render: (p: any) => (
                            <span className="whitespace-nowrap text-xs">
                              {p.phone || p.mobile || "—"}
                            </span>
                          ),
                        },
                        {
                          key: "department",
                          title: "所属部门",
                          width: 170,
                          render: (p: any) => (
                            <span className="block truncate text-xs" title={p.departmentNames?.join("、") || ""}>
                              {p.departmentNames?.join("、") || "—"}
                            </span>
                          ),
                        },
                        {
                          key: "tencent",
                          title: `${targetName}账号`,
                          width: 150,
                          render: (p: any) => (
                            <span className="whitespace-nowrap text-xs">
                              {p.tencentUserId || "—"}
                            </span>
                          ),
                        },
                        {
                          key: "permission",
                          title: "权限",
                          width: 88,
                          render: (p: any) =>
                            p.tencentUserId ? (
                              <span
                                className={`whitespace-nowrap text-xs ${p.meetingUserType === "advanced" ? "text-primary" : "text-muted-foreground"}`}
                              >
                                {p.meetingUserType === "advanced" ? "高级" : "普通"}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            ),
                        },
                        {
                          key: "error",
                          title: "说明",
                          width: 160,
                          render: (p: any) => (
                            <span className="block truncate text-xs text-red-600" title={p.syncError || ""}>
                              {p.syncError || "—"}
                            </span>
                          ),
                        },
                        {
                          key: "actions",
                          title: "操作",
                          width: 120,
                          render: (p: any) => (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setPerson({
                                  id: p.id,
                                  name: p.name,
                                  phone: p.phone || p.mobile || "",
                                  email: p.email || "",
                                  tencentUserId: p.tencentUserId || "",
                                })
                              }
                            >
                              补充资料
                            </Button>
                          ),
                        },
                      ]}
                    />
                  </>
                )}
              </Panel>
            </>
          )}
          {activeTab === "policy" && (
            <Panel className="sync-policy-panel">
              <ValidatedForm
                className="sync-policy-form"
                values={schedule}
                schema={syncPolicyFormSchema}
                onSubmit={savePolicy}
                footer={
                  <div className="sync-policy-actions">
                    <Button variant="outline" type="submit" disabled={saving}>
                      <Save />
                      保存策略
                    </Button>
                    <Confirm
                      title={`同步 ${selected.length} ${organization ? "个部门" : "位人员"}到${targetName}`}
                      description={
                        organization
                          ? overwrite
                            ? "将新增缺失部门，并覆盖已关联部门的名称和上级关系。"
                            : "将新增缺失部门，已有部门保持原样。"
                          : `将新增缺失人员，并把已有账号移动到飞书对应部门；姓名和联系方式${overwrite ? "会被飞书资料覆盖" : "保持原样"}；已有许可${preserve ? "保持原样" : "将按规则覆盖，可能发生降级"}。`
                      }
                      onConfirm={submit}
                    >
                      {(show) => (
                        <Button
                          type="button"
                          disabled={saving || !selected.length || !targetConfigured}
                          onClick={show}
                        >
                          <RefreshCw />
                          同步到{targetName}
                        </Button>
                      )}
                    </Confirm>
                  </div>
                }
              >
                <div className="card-scroll sync-policy-content">
                  <fieldset disabled={saving}>
                    <section className="sync-policy-section">
                      <h2>同步规则</h2>
                      <SelectField
                        label={
                          organization ? `${targetName}已有部门` : `${targetName}已有人员资料`
                        }
                        value={overwrite ? "overwrite" : "merge"}
                        onChange={(v) => setOverwrite(v === "overwrite")}
                        options={[
                          {
                            value: "merge",
                            label: organization
                              ? "只新增缺失部门，保留已有部门"
                              : "新增缺失人员，已有人员只同步部门",
                          },
                          {
                            value: "overwrite",
                            label: organization
                              ? "覆盖已有部门名称与上级关系"
                              : "同步部门，并用飞书姓名和联系方式覆盖已有资料",
                          },
                        ]}
                      />
                      {!organization && (
                        <Toggle
                          label={`保留${targetName}已有用户权限`}
                          checked={preserve}
                          onChange={setPreserve}
                        />
                      )}
                    </section>
                    <section className="sync-policy-section">
                      <h2>自动同步</h2>
                      <SelectField
                        name="automaticMode"
                        label="自动同步组织与用户"
                        value={schedule.automaticMode}
                        onChange={(v) => updateSchedule("automaticMode", v)}
                        options={[
                          { value: "manual", label: "关闭自动同步" },
                          { value: "interval", label: "按间隔执行" },
                          { value: "daily", label: "每天定时执行" },
                        ]}
                      />
                      {schedule.automaticMode === "interval" && (
                        <TextField
                          name="intervalMinutes"
                          label="同步间隔（分钟）"
                          type="number"
                          min={1}
                          max={10080}
                          value={schedule.intervalMinutes}
                          onChange={(v) => updateSchedule("intervalMinutes", v)}
                        />
                      )}
                      {schedule.automaticMode === "daily" && (
                        <Field label="执行时间（北京时间）">
                          <div className="sync-schedule-time">
                            <OptionSelect
                              label="执行小时"
                              value={schedule.dailyHour}
                              onChange={(v) => updateSchedule("dailyHour", v)}
                              options={Array.from({ length: 24 }, (_, h) => ({
                                value: String(h).padStart(2, "0"),
                                label: `${String(h).padStart(2, "0")} 时`,
                              }))}
                            />
                            <span>:</span>
                            <OptionSelect
                              label="执行分钟"
                              value={schedule.dailyMinute}
                              onChange={(v) => updateSchedule("dailyMinute", v)}
                              options={Array.from({ length: 60 }, (_, m) => ({
                                value: String(m).padStart(2, "0"),
                                label: `${String(m).padStart(2, "0")} 分`,
                              }))}
                            />
                          </div>
                        </Field>
                      )}
                      {!organization && (
                        <Toggle
                          label="自动停用缺失人员"
                          checked={schedule.disableMissingUsers}
                          onChange={(v) =>
                            updateSchedule("disableMissingUsers", v)
                          }
                          hint="仅在飞书通讯录授权范围完整时开启。"
                        />
                      )}
                      {schedule.automaticMode !== "manual" && (
                        <dl className="sync-next-run">
                          <dt>下次执行</dt>
                          <dd>
                            {scheduleChanged
                              ? "保存后更新"
                              : q.data?.policy?.nextRunAt
                                ? new Date(
                                    q.data.policy.nextRunAt,
                                  ).toLocaleString("zh-CN", {
                                    timeZone: "Asia/Shanghai",
                                    hour12: false,
                                  })
                                : "—"}
                          </dd>
                        </dl>
                      )}
                    </section>
                  </fieldset>
                </div>
              </ValidatedForm>
            </Panel>
          )}
          {activeTab === "rules" && !organization && (
            <Panel
              className="sync-data-panel"
              title="新用户许可规则"
              description="已有许可默认保留。这些规则决定新建人员的许可，按列表顺序匹配；未匹配则为普通用户。"
              actions={
                <Button variant="outline" size="sm" onClick={() => editRule()}>
                  <Plus />
                  新增规则
                </Button>
              }
            >
              <DataTable
                rows={q.data?.rules || []}
                emptyTitle="新建人员默认使用普通许可"
                emptyHint="需要给特定部门分配高级许可时，添加一条规则。"
                columns={[
                  { key: "name", title: "规则", render: (r: any) => r.name },
                  {
                    key: "department",
                    title: "匹配部门",
                    render: (r: any) =>
                      r.departmentName ||
                      departments.find(
                        (d: any) =>
                          d.open_department_id === r.departmentExternalId,
                      )?.name ||
                      r.departmentExternalId ||
                      "全部人员",
                  },
                  {
                    key: "type",
                    title: "新建许可",
                    render: (r: any) =>
                      r.meetingUserType === "advanced"
                        ? "高级用户"
                        : "普通用户",
                  },
                  {
                    key: "enabled",
                    title: "状态",
                    render: (r: any) => (
                      <Status value={r.enabled ? "active" : "disabled"} />
                    ),
                  },
                  {
                    key: "actions",
                    title: "操作",
                    render: (r: any) => (
                      <div className="row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => editRule(r)}
                        >
                          编辑
                        </Button>
                        <Confirm
                          title="删除许可规则"
                          description="未匹配其他规则的新建人员会使用普通用户许可。"
                          onConfirm={() =>
                            act(
                              () => request(`/sync/rules/${r.id}`, "DELETE"),
                              "规则已删除",
                            )
                          }
                        >
                          {(show) => (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={saving}
                              onClick={show}
                            >
                              删除
                            </Button>
                          )}
                        </Confirm>
                      </div>
                    ),
                  },
                ]}
              />
              <p className="sync-rule-note text-xs text-muted-foreground flex items-center gap-2 border-t px-5 py-3 shrink-0">
                <FolderTree className="h-4 w-4" />
                首次同步人员前，请先
                <Link
                  className="text-primary underline underline-offset-4"
                  to="/sync"
                >
                  同步组织架构
                </Link>
                。
              </p>
            </Panel>
          )}
          {activeTab === "runs" && (
            <ManagementRecords kind="sync" scope={scope} />
          )}
        </div>
      </QueryState>
      <Modal
        open={ruleOpen}
        onClose={() => !saving && setRuleOpen(false)}
        title="设置新用户许可"
        description={`选择一个飞书部门，并设置新建${targetName}人员时使用的许可。`}
      >
        <ValidatedForm
          values={rule}
          schema={ruleSchema}
          className="modal-form"
          footer={
            <FormActions saving={saving} onCancel={() => setRuleOpen(false)} />
          }
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request(
                `/sync/rules${ruleId ? `/${ruleId}` : ""}`,
                ruleId ? "PATCH" : "POST",
                rule,
              );
              setRuleOpen(false);
            }, "许可规则已保存");
          }}
        >
          <TextField
            name="name"
            label="规则名称"
            value={rule.name}
            onChange={(v) => setRule({ ...rule, name: v })}
            required
          />
          <SelectField
            name="departmentExternalId"
            label="飞书部门"
            value={rule.departmentExternalId}
            onChange={(v) =>
              setRule({ ...rule, departmentExternalId: v, departmentName: "" })
            }
            options={[
              { value: "", label: "全部部门" },
              ...departments.map((d: any) => ({
                value: d.open_department_id,
                label: d.path || d.name,
              })),
            ]}
          />
          {rule.departmentName && (
            <TextField
              name="departmentName"
              label="历史部门名称条件"
              value={rule.departmentName}
              onChange={(v) => setRule({ ...rule, departmentName: v })}
              hint="旧规则保留此条件；选择部门后会改为按部门匹配。"
            />
          )}
          <SelectField
            name="meetingUserType"
            label="新用户许可"
            value={rule.meetingUserType}
            onChange={(v) => setRule({ ...rule, meetingUserType: v })}
            options={[
              { value: "ordinary", label: "普通用户" },
              { value: "advanced", label: "高级用户（需要企业有可用许可）" },
            ]}
          />
          <Toggle
            label="启用规则"
            checked={rule.enabled}
            onChange={(v) => setRule({ ...rule, enabled: v })}
          />
        </ValidatedForm>
      </Modal>
      <Modal
        open={!!person}
        onClose={() => !saving && setPerson(undefined)}
        title={`维护 ${person?.name || ""} 的同步资料`}
        description={`补充飞书未提供的手机号，或绑定已有${targetName}企业账号。不会修改系统身份与登录权限。`}
      >
        <ValidatedForm
          values={{
            phone: person?.phone || "",
            email: person?.email || "",
            tencentUserId: person?.tencentUserId || "",
          }}
          schema={personSchema}
          className="modal-form"
          footer={
            <FormActions
              saving={saving}
              onCancel={() => setPerson(undefined)}
            />
          }
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request(`/sync/people/${person.id}`, "PATCH", {
                phone: person.phone,
                email: person.email,
                tencentUserId: person.tencentUserId,
              });
              setPerson(undefined);
            }, "资料已保存");
          }}
        >
          <TextField
            name="phone"
            label="手机号"
            value={person?.phone || ""}
            onChange={(v) => setPerson({ ...person, phone: v })}
          />
          <TextField
            name="email"
            label="邮箱"
            type="email"
            value={person?.email || ""}
            onChange={(v) => setPerson({ ...person, email: v })}
          />
          <TextField
            name="tencentUserId"
            label={`${targetName}企业 UserID`}
            value={person?.tencentUserId || ""}
            onChange={(v) => setPerson({ ...person, tencentUserId: v })}
            hint="留空时在下次同步中按手机号识别。填写后会验证账号，并读取实际许可。"
          />
        </ValidatedForm>
      </Modal>
    </div>
  );
}
export default function Sync() {
  return <DirectorySync scope="organization" />;
}
