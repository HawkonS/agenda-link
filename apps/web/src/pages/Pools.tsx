import { OptionSelect } from "../components/common/OptionSelect";
import { ValidatedForm } from "../components/common/ValidatedForm";
import { accountSchema, poolSchema } from "../lib/form-schemas";
import { useEffect,useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Download,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { request } from "../api";
import { usePage, useAction } from "../lib/hooks";
import { cn, time, statusText } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  PageHeader,
  QueryState,
  DataTable,
  Modal,
  FormActions,
  TextField,
  MultiPicker,
  Toggle,
  Status,
  Confirm,
  SearchBox,
  SelectField,
  Loading,
  ErrorBanner,
  Empty,
} from "../components/common/workspace";

type MeetingAccount = {
  connectionId?:string;
  id: number;
  name: string;
  accountId: string;
  status: string;
  verifiedAt?: string | null;
  lastError?: string | null;
  hasOwnCredentials?: boolean;
};
type AccountPool = {
  connectionId?:string;
  id: number;
  name: string;
  description?: string;
  enabled: boolean;
  isDefault?: boolean;
  members: MeetingAccount[];
};
type TencentAccount = {
  accountId: string;
  name: string;
  departmentNames: string[];
  accountType: number;
  platformStatus: string;
  canImport: boolean;
  localId: number | null;
  localStatus: string | null;
};
const platformStatuses: Record<string, string> = {
  "1": "正常",
  "2": "已注销",
  "3": "未激活",
  "4": "平台已禁用",
  "5": "预注册",
};
const emptyPool = () => ({
  connectionId: "",
  name: "",
  description: "",
  accountIds: [] as number[],
  enabled: true,
  isDefault: false,
});
const emptyAccount = () => ({
  name: "",
  accountId: "",
  secretId: "",
  secretKey: "",
});

export default function Pools() {
  const [connectionId,setConnectionId]=useState("");
  const platforms=usePage("platforms",()=>request("/platforms"));
  const components=(Array.isArray(platforms.data)?platforms.data:[]).filter((p:any)=>p.capability==="meeting" && p.capabilities.accountPool);
  useEffect(()=>{if(!connectionId && components.length===1)setConnectionId(components[0].connectionId);},[platforms.data,connectionId]);
  useEffect(()=>{
    setActivePoolId(undefined);
    setAccountSearch("");
    setAccountStatus("");
  },[connectionId]);
  const activeComponent = components.find((p:any)=>p.connectionId===connectionId);
  const platformConfigured = Boolean(activeComponent?.configured);
  const q = usePage("pools", async () => {
      const [pools, accounts] = await Promise.all([
        request("/account-pools"),
        request("/meeting-accounts"),
      ]);
      return {
        pools: pools as AccountPool[],
        accounts: accounts as MeetingAccount[],
      };
    }),
    { saving, act } = useAction();
  const [pool, setPool] = useState(emptyPool()),
    [account, setAccount] = useState(emptyAccount());
  const [poolId, setPoolId] = useState<number>(),
    [accountId, setAccountId] = useState<number>();
  const [poolOpen, setPoolOpen] = useState(false),
    [accountOpen, setAccountOpen] = useState(false),
    [tencentOpen, setTencentOpen] = useState(false);
  const [activePoolId, setActivePoolId] = useState<number>();
  const [accountSearch, setAccountSearch] = useState(""),
    [accountStatus, setAccountStatus] = useState("");
  const [tencentAccounts, setTencentAccounts] = useState<
      TencentAccount[] | null
    >(null),
    [tencentError, setTencentError] = useState(false);
  const [selectedTencent, setSelectedTencent] = useState<string[]>([]),
    [tencentSearch, setTencentSearch] = useState(""),
    [tencentFilter, setTencentFilter] = useState("");
  const [targetPool, setTargetPool] = useState("");
  const pools=(q.data?.pools || []).filter(p=>!p.connectionId || p.connectionId===connectionId);
  const accounts=(q.data?.accounts || []).filter(a=>!a.connectionId || a.connectionId===connectionId);
  const activePool = pools.find((p) => p.id === activePoolId);
  const editingAccount = accounts.find((a) => a.id === accountId);
  const poolAccounts = activePool
    ? accounts.filter((a) => activePool.members.some((m) => m.id === a.id))
    : accounts;
  const visibleAccounts = poolAccounts.filter(
    (a) =>
      `${a.name} ${a.accountId}`
        .toLowerCase()
        .includes(accountSearch.trim().toLowerCase()) &&
      (!accountStatus ||
        (accountStatus === "unverified"
          ? !a.verifiedAt
          : a.status === accountStatus)),
  );
  const visibleTencent = (tencentAccounts || []).filter(
    (a) =>
      [a.name, a.accountId, ...a.departmentNames]
        .join(" ")
        .toLowerCase()
        .includes(tencentSearch.trim().toLowerCase()) &&
      (!tencentFilter ||
        (tencentFilter === "new"
          ? !a.localId
          : tencentFilter === "added"
            ? !!a.localId
            : !a.canImport)),
  );
  const selectableTencent = visibleTencent.filter((a) => a.canImport);
  const selectedAccounts = (tencentAccounts || []).filter((a) =>
    selectedTencent.includes(a.accountId),
  );
  const toggleTencent = (id: string, checked: boolean) =>
    setSelectedTencent((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((v) => v !== id),
    );
  async function readTencent() {
    setTencentAccounts(null);
    setTencentError(false);
    setSelectedTencent([]);
    const ok = await act(async () => {
      const data = await request(`/meeting-accounts/platform/${connectionId}`);
      setTencentAccounts(data.accounts || []);
    });
    setTencentError(!ok);
  }
  function openTencent() {
    setTencentSearch("");
    setTencentFilter("");
    setTargetPool(activePool?.enabled ? String(activePool.id) : "");
    setTencentOpen(true);
    void readTencent();
  }
  function openPool(row?: AccountPool) {
    setPoolId(row?.id);
    setPool(
      row
        ? {
            connectionId: row.connectionId || connectionId,
            name: row.name,
            description: row.description || "",
            enabled: row.enabled,
            isDefault: Boolean(row.isDefault),
            accountIds: row.members.map((a) => a.id),
          }
        : { ...emptyPool(), connectionId },
    );
    setPoolOpen(true);
  }
  function openAccount(row?: MeetingAccount) {
    setAccountId(row?.id);
    setAccount(
      row
        ? {
            name: row.name,
            accountId: row.accountId,
            secretId: "",
            secretKey: "",
          }
        : emptyAccount(),
    );
    setAccountOpen(true);
  }
  function selectPool(id?: number) {
    setActivePoolId(id);
    setAccountSearch("");
    setAccountStatus("");
  }
  const remove = (type: string, id: number) =>
    act(() => request(`/${type}/${id}`, "DELETE"), "已删除");
  const verify = (id: number) =>
    act(
      () => request(`/meeting-accounts/${id}/test`, "POST"),
      "已验证高级许可并启用",
    );
  return (
    <div className="page-shell page-shell--pool">
      <PageHeader title="账号资源" />
      {!platformConfigured && (
        <div className="sync-setup-banner" role="status">
          <span>请先在系统设置中配置腾讯会议账号平台，才能创建账号池。</span>
          <Button size="sm" variant="outline" asChild>
            <Link to="/settings?tab=business">去配置</Link>
          </Button>
        </div>
      )}
      <QueryState
        loading={q.isLoading}
        error={q.isError}
        retry={() => void q.refetch()}
      >
        <div className="pool-content">
          <div className="pool-workspace">
            <section className="surface pool-groups" aria-label="选择账号池">
              <div className="pool-groups-toolbar">
                <div className="pool-groups-heading">
                  <h2>账号分组</h2>
                  {components.length <= 1 && activeComponent && (
                    <span className="pool-platform-badge">
                      {activeComponent.name}
                    </span>
                  )}
                </div>
                <div className="pool-group-actions">
                  {activePool && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="编辑账号池"
                        title="编辑账号池"
                        onClick={() => openPool(activePool)}
                      >
                        <Pencil />
                      </Button>
                      <Confirm
                        title="删除账号池"
                        description="存在会议历史时请使用停用。删除后无法恢复。"
                        onConfirm={() => remove("account-pools", activePool.id)}
                      >
                        {(show) => (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`删除账号池 ${activePool.name}`}
                            title="删除账号池"
                            disabled={saving}
                            onClick={show}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </Confirm>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="创建账号池"
                    title={
                      platformConfigured
                        ? "创建账号池"
                        : "请先在系统设置中配置腾讯会议账号平台"
                    }
                    disabled={!platformConfigured}
                    onClick={() => openPool()}
                  >
                    <Plus />
                  </Button>
                </div>
              </div>
              {components.length > 1 && (
                <div className="pool-platform-row">
                  <OptionSelect
                    label="账号平台"
                    value={connectionId}
                    onChange={setConnectionId}
                    options={components.map((p: any) => ({
                      value: p.connectionId,
                      label: p.name + (p.configured ? "" : "（未配置）"),
                    }))}
                  />
                </div>
              )}
              <div className="pool-group-list">
                <button
                  type="button"
                  className={cn(
                    "pool-group all-accounts",
                    !activePool && "selected",
                  )}
                  aria-pressed={!activePool}
                  onClick={() => selectPool()}
                >
                  <span className="pool-all-icon">
                    <Users aria-hidden="true" />
                  </span>
                  <span className="pool-all-copy">
                    <strong>全部高级账号</strong>
                    <small>所有已同步账号</small>
                  </span>
                  <span className="pool-all-count">{accounts.length}</span>
                </button>
                {!!pools.length && (
                  <div className="pool-section-label">
                    <span>账号池</span>
                    <small>{pools.length}</small>
                  </div>
                )}
                {pools.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className={cn(
                      "pool-group",
                      activePool?.id === p.id && "selected",
                    )}
                    aria-pressed={activePool?.id === p.id}
                    onClick={() => selectPool(p.id)}
                  >
                    <div className="pool-group-name">
                      <Layers3 aria-hidden="true" />
                      <span className="pool-group-name-text">{p.name}</span>
                      {p.isDefault && <Status value="默认" />}
                      <ChevronRight aria-hidden="true" />
                    </div>
                    {p.description && (
                      <p className="pool-group-description">{p.description}</p>
                    )}
                    <div className="pool-group-meta">
                      <span>{p.members.length} 个账号</span>
                      <span className={p.enabled ? "pool-enabled" : ""}>
                        <i />
                        {p.enabled ? "启用" : "停用"}
                      </span>
                    </div>
                  </button>
                ))}
                {!pools.length && (
                  <p className="px-3 py-6 text-sm leading-6 text-muted-foreground">
                    创建账号池，将高级账号分组用于预约。
                  </p>
                )}
              </div>
            </section>
            <section
              className="surface min-w-0 overflow-hidden"
              aria-label="高级账号管理"
            >
              <h2 className="sr-only" aria-label="高级账号">
                {activePool?.name || "高级账号"}
              </h2>
              {activePool && !activePool.enabled && (
                <div className="pool-disabled-note">
                  <AlertCircle />
                  此账号池已停用，成员不会通过这个池参与预约分配。
                </div>
              )}
              <div
                className="sync-toolbar pool-account-toolbar"
                role="group"
                aria-label="高级账号筛选与操作"
              >
                <SearchBox
                  value={accountSearch}
                  onChange={setAccountSearch}
                  placeholder="搜索账号名称或 UserID"
                />
                <OptionSelect
                  className="pool-status-filter"
                  label="筛选账号状态"
                  value={accountStatus}
                  onChange={setAccountStatus}
                  options={[
                    { value: "", label: "全部状态" },
                    { value: "available", label: "可用" },
                    { value: "disabled", label: "停用" },
                    { value: "error", label: "异常" },
                    { value: "unverified", label: "未验证" },
                  ]}
                />
                <Button variant="ghost" size="sm" onClick={() => openAccount()}>
                  <Plus />
                  手动添加
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || !platformConfigured}
                  onClick={openTencent}
                  title={platformConfigured ? undefined : "请先在系统管理中配置腾讯会议连接"}
                >
                  <Download />
                  从会议平台获取
                </Button>
              </div>
              <DataTable
                rows={visibleAccounts}
                emptyTitle={
                  accountSearch || accountStatus
                    ? "没有匹配的账号"
                    : activePool
                      ? "账号池里还没有成员"
                      : "尚未添加高级账号"
                }
                emptyHint={
                  accountSearch || accountStatus
                    ? "试试其他关键词或状态。"
                    : platformConfigured
                      ? "从会议平台获取高级账号，选择后即可加入账号池。"
                      : "请先在系统管理中配置腾讯会议连接。"
                }
                emptyAction={
                  accountSearch || accountStatus ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setAccountSearch("");
                        setAccountStatus("");
                      }}
                    >
                      清除筛选
                    </Button>
                  ) : (
                    <Button size="sm" disabled={saving || !platformConfigured} onClick={openTencent}>
                      <Download />
                      从会议平台获取
                    </Button>
                  )
                }
                columns={[
                  {
                    key: "name",
                    title: "账号",
                    width: 190,
                    render: (a) => (
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <span className="account-avatar">
                          <UserRound aria-hidden="true" />
                        </span>
                        <span className="truncate font-medium" title={a.name}>
                          {a.name}
                        </span>
                      </div>
                    ),
                  },
                  {
                    key: "accountId",
                    title: "UserID",
                    width: 190,
                    render: (a) => (
                      <span className="block truncate text-xs" title={a.accountId}>
                        {a.accountId}
                      </span>
                    ),
                  },
                  {
                    key: "status",
                    title: "使用状态",
                    width: 120,
                    render: (a) => (
                      <span
                        className="whitespace-nowrap"
                        title={a.lastError || undefined}
                      >
                        <Status value={a.verifiedAt ? a.status : "pending"} />
                      </span>
                    ),
                  },
                  {
                    key: "pools",
                    title: activePool ? "许可验证" : "所属账号池",
                    width: 210,
                    render: (a) =>
                      activePool ? (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {a.verifiedAt ? time(a.verifiedAt) : "尚未验证"}
                        </span>
                      ) : (
                        (() => {
                          const memberPools = pools.filter((p) =>
                            p.members.some((m) => m.id === a.id),
                          );
                          return memberPools.length ? (
                            <button
                              type="button"
                              className="account-pool-link"
                              title={memberPools.map((p) => p.name).join("、")}
                              onClick={() => selectPool(memberPools[0]?.id)}
                            >
                              {memberPools.map((p) => p.name).join("、")}
                            </button>
                          ) : (
                            <span className="whitespace-nowrap text-xs text-muted-foreground">
                              未加入账号池
                            </span>
                          );
                        })()
                      ),
                  },
                  {
                    key: "actions",
                    title: "操作",
                    width: 100,
                    render: (a) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`管理账号 ${a.name}`}
                        onClick={() => openAccount(a)}
                      >
                        管理
                      </Button>
                    ),
                  },
                ]}
              />
            </section>
          </div>
        </div>
      </QueryState>

      <Modal
        open={tencentOpen}
        onClose={() => {
          if (!saving) setTencentOpen(false);
        }}
        title="从会议平台获取高级账号"
        description="选择企业中的高级账号，添加到本系统或直接加入账号池。"
        className="tencent-account-modal"
        bodyClassName="tencent-account-body"
      >
        {tencentError ? (
          <div className="p-6">
            <ErrorBanner
              message="获取失败，请检查会议平台平台连接及通讯录权限后重试。"
              retry={() => void readTencent()}
            />
          </div>
        ) : tencentAccounts === null ? (
          <Loading />
        ) : (
          <div className="tencent-import-layout">
            <div className="tencent-picker">
              <div className="tencent-picker-toolbar">
                <SearchBox
                  value={tencentSearch}
                  onChange={setTencentSearch}
                  placeholder="搜索账号名称、UserID 或部门"
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="重新获取"
                  disabled={saving}
                  onClick={() => void readTencent()}
                >
                  <RefreshCw />
                </Button>
              </div>
              <div className="tencent-picker-filter">
                <label className="flex items-center gap-2.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="workspace-checkbox"
                    aria-label="选择当前高级账号"
                    checked={
                      selectableTencent.length > 0 &&
                      selectableTencent.every((a) =>
                        selectedTencent.includes(a.accountId),
                      )
                    }
                    disabled={saving || !selectableTencent.length}
                    onChange={(e) =>
                      setSelectedTencent((current) =>
                        e.target.checked
                          ? [
                              ...new Set([
                                ...current,
                                ...selectableTencent.map((a) => a.accountId),
                              ]),
                            ]
                          : current.filter(
                              (id) =>
                                !selectableTencent.some(
                                  (a) => a.accountId === id,
                                ),
                            ),
                      )
                    }
                  />
                  选择当前结果
                </label>
                <OptionSelect
                  className="tencent-filter-select"
                  label="筛选平台账号"
                  value={tencentFilter}
                  onChange={setTencentFilter}
                  options={[
                    {
                      value: "",
                      label: `全部账号（${tencentAccounts.length}）`,
                    },
                    { value: "new", label: "未添加" },
                    { value: "added", label: "已添加" },
                    { value: "unavailable", label: "不可选" },
                  ]}
                />
              </div>
              <div className="tencent-account-list">
                {visibleTencent.map((a) => (
                  <label
                    key={a.accountId}
                    className={cn(
                      "tencent-account-row",
                      selectedTencent.includes(a.accountId) && "selected",
                      !a.canImport && "unavailable",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="workspace-checkbox"
                      aria-label={`选择平台账号 ${a.name}`}
                      checked={selectedTencent.includes(a.accountId)}
                      disabled={saving || !a.canImport}
                      onChange={(e) =>
                        toggleTencent(a.accountId, e.target.checked)
                      }
                    />
                    <span className="account-avatar">
                      <UserRound aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm font-medium">
                          {a.name}
                        </strong>
                        <span
                          className={cn(
                            "account-import-badge",
                            !a.localId && "new-account",
                          )}
                        >
                          {a.localId ? "已添加" : "未添加"}
                        </span>
                      </div>
                      <p className="account-userid">{a.accountId}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {a.departmentNames.join("、") || "企业根部门"}
                        {a.localStatus === "disabled" && (
                          <span className="ml-2">
                            <span aria-hidden="true">· </span>
                            <span>本地已停用</span>
                          </span>
                        )}
                        {!a.canImport && (
                          <span className="ml-2">
                            · {platformStatuses[a.platformStatus] || "状态未知"}
                            ，请在会议平台启用
                          </span>
                        )}
                      </p>
                    </div>
                  </label>
                ))}
                {!visibleTencent.length && (
                  <Empty
                    title={
                      tencentAccounts.length
                        ? "没有匹配的高级账号"
                        : "暂无高级账号"
                    }
                    hint={
                      tencentAccounts.length
                        ? "调整搜索关键词或筛选条件。"
                        : "请检查会议平台的企业账号及高级许可。"
                    }
                  />
                )}
              </div>
            </div>
            <aside
              className="tencent-selection"
              aria-label="已选账号及目标账号池"
            >
              <h3>
                已选账号 <span>{selectedTencent.length}</span>
              </h3>
              <div className="tencent-selected-list">
                {selectedAccounts.length ? (
                  selectedAccounts.map((a) => (
                    <div key={a.accountId} className="tencent-selected-item">
                      <Check aria-hidden="true" />
                      <span title={a.accountId}>{a.name}</span>
                      <button
                        type="button"
                        aria-label={`移除平台账号 ${a.name}`}
                        disabled={saving}
                        onClick={() => toggleTencent(a.accountId, false)}
                      >
                        <X />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="tencent-selection-empty">
                    <Users aria-hidden="true" />
                    <p>勾选左侧账号</p>
                    <span>可以同时选择多个</span>
                  </div>
                )}
              </div>
              <div className="tencent-target-pool">
                <SelectField
                  label="加入账号池"
                  value={targetPool}
                  onChange={setTargetPool}
                  options={[
                    { value: "", label: "仅添加，不加入账号池" },
                    ...pools.map((p) => ({
                      value: p.id,
                      label: p.name,
                      disabled: !p.enabled,
                    })),
                  ]}
                />
              </div>
              <p className="tencent-import-note">
                已添加的账号也可加入池；本地停用状态会保留。
              </p>
              {selectedTencent.length > 100 && (
                <p role="alert" className="text-xs text-destructive">
                  每次最多添加 100 个账号，请减少选择。
                </p>
              )}
            </aside>
          </div>
        )}
        <div className="tencent-import-footer">
          <span className="text-sm text-muted-foreground">
            已选{" "}
            <strong className="text-foreground">
              {selectedTencent.length}
            </strong>{" "}
            个账号
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setTencentOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={
                saving ||
                !selectedTencent.length ||
                selectedTencent.length > 100
              }
              onClick={() =>
                void act(
                  async () => {
                    await request(`/meeting-accounts/platform/${connectionId}/import`, "POST", {
                      accountIds: selectedTencent,
                      ...(targetPool ? { poolId: Number(targetPool) } : {}),
                    });
                    setTencentOpen(false);
                  },
                  targetPool ? "高级账号已添加并加入账号池" : "高级账号已添加",
                )
              }
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              添加所选账号
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={poolOpen}
        onClose={() => {
          if (!saving) setPoolOpen(false);
        }}
        title={poolId ? "编辑账号池" : "创建账号池"}
        description="设置名称，选择参与会议预约的高级账号。"
      >
        <ValidatedForm
          values={pool}
          schema={poolSchema}
          className="modal-form"
          footer={
            <FormActions saving={saving} onCancel={() => setPoolOpen(false)} />
          }
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request(
                "/account-pools" + (poolId ? `/${poolId}` : ""),
                poolId ? "PATCH" : "POST",
                { ...pool, connectionId: pool.connectionId || connectionId },
              );
              setPoolOpen(false);
            }, "账号池已保存");
          }}
        >
          {!poolId && components.length > 0 && (
            <SelectField
              name="connectionId"
              label="账号平台"
              value={pool.connectionId || connectionId}
              onChange={(value) => {
                setConnectionId(value);
                setPool((current) => ({ ...current, connectionId: value }));
              }}
              options={components.map((component: any) => ({
                value: component.connectionId,
                label:
                  component.name +
                  (component.configured ? "" : "（未配置）"),
                disabled: !component.configured,
              }))}
            />
          )}
          <TextField
            name="name"
            label="账号池名称"
            value={pool.name}
            onChange={(v) => setPool((p) => ({ ...p, name: v }))}
            required
            placeholder="例如：团队会议账号池"
          />
          <TextField
            name="description"
            label="说明"
            value={pool.description}
            onChange={(v) => setPool((p) => ({ ...p, description: v }))}
            placeholder="这个账号池主要用于哪些会议（选填）"
          />
          <MultiPicker
            unit="个账号"
            label="账号成员"
            selected={pool.accountIds}
            onChange={(v) => setPool((p) => ({ ...p, accountIds: v }))}
            options={accounts.map((a) => ({
              id: a.id,
              label: `${a.name} · ${a.verifiedAt ? statusText[a.status] || a.status : "未验证高级许可"}`,
              disabled: !a.verifiedAt,
            }))}
          />
          <div className="rounded-lg border bg-muted/40 p-4">
            <Toggle
              label="启用账号池"
              checked={pool.enabled}
              onChange={(v) =>
                setPool((p) => ({
                  ...p,
                  enabled: v,
                  isDefault: v && p.isDefault,
                }))
              }
              hint="停用后，此账号池不参与预约分配。"
            />
            <div className="mt-4 border-t pt-4">
              <Toggle
                label="设为预约默认账号池"
                checked={pool.isDefault}
                onChange={(v) => setPool((p) => ({ ...p, isDefault: v }))}
                hint="新建预约时会自动选中；每次只能有一个默认账号池。"
              />
            </div>
          </div>
        </ValidatedForm>
      </Modal>
      <Modal
        open={accountOpen}
        onClose={() => {
          if (!saving) setAccountOpen(false);
        }}
        title={accountId ? "管理高级账号" : "添加高级账号"}
        description="使用会议平台企业 UserID 登记主持账号。"
      >
        {editingAccount && (
          <div className="account-verification">
            <div>
              <Status
                value={
                  editingAccount.verifiedAt ? editingAccount.status : "pending"
                }
              />
              <p>
                {editingAccount.verifiedAt
                  ? `最近验证：${time(editingAccount.verifiedAt)}`
                  : "尚未验证高级许可"}
              </p>
              {editingAccount.lastError && (
                <p className="text-destructive">{editingAccount.lastError}</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void verify(editingAccount.id)}
            >
              <ShieldCheck />
              验证并启用
            </Button>
          </div>
        )}
        <ValidatedForm
          values={account}
          schema={accountSchema}
          className="modal-form"
          footer={
            <FormActions
              saving={saving}
              onCancel={() => setAccountOpen(false)}
            />
          }
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              async () => {
                const payload: Record<string, unknown> = { ...account };
                if (accountId) {
                  delete payload.accountId;
                  if (!payload.secretId && !payload.secretKey) {
                    delete payload.secretId;
                    delete payload.secretKey;
                  }
                }
                await request(
                  "/meeting-accounts" + (accountId ? `/${accountId}` : ""),
                  accountId ? "PATCH" : "POST",
                  payload,
                );
                setAccountOpen(false);
              },
              accountId ? "账号资料已保存" : "账号已保存，请验证高级许可",
            );
          }}
        >
          <TextField
            name="name"
            label="账号名称"
            value={account.name}
            onChange={(v) => setAccount((a) => ({ ...a, name: v }))}
            required
            placeholder="便于识别的账号名称"
          />
          <TextField
            name="accountId"
            label="平台账号 ID"
            value={account.accountId}
            onChange={(v) => setAccount((a) => ({ ...a, accountId: v }))}
            disabled={!!accountId}
            required
          />
          <details className="account-credentials">
            <summary>
              独立接口凭据<span>选填</span>
            </summary>
            <div className="space-y-4">
              <p className="text-xs leading-5 text-muted-foreground">
                默认使用平台连接凭据。编辑时两项留空会保留原值。
              </p>
              <TextField
                name="secretId"
                label="独立 Secret ID"
                value={account.secretId}
                onChange={(v) => setAccount((a) => ({ ...a, secretId: v }))}
              />
              <TextField
                name="secretKey"
                label="独立 Secret Key"
                type="password"
                autoComplete="off"
                value={account.secretKey}
                onChange={(v) => setAccount((a) => ({ ...a, secretKey: v }))}
              />
            </div>
          </details>
        </ValidatedForm>
        {editingAccount && (
          <div className="account-maintenance">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                void act(() =>
                  request(`/meeting-accounts/${editingAccount.id}`, "PATCH", {
                    status:
                      editingAccount.status === "available"
                        ? "disabled"
                        : "available",
                  }),
                )
              }
            >
              {editingAccount.status === "available" ? "停用账号" : "启用账号"}
            </Button>
            <Confirm
              title="删除高级账号"
              description="存在会议历史时请使用停用。删除后无法恢复。"
              onConfirm={async () => {
                const ok = await remove("meeting-accounts", editingAccount.id);
                if (ok) setAccountOpen(false);
                return ok;
              }}
            >
              {(show) => (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={saving}
                  onClick={show}
                >
                  <Trash2 />
                  删除账号
                </Button>
              )}
            </Confirm>
          </div>
        )}
      </Modal>
    </div>
  );
}
