import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Save, RefreshCw } from "lucide-react";
import { request } from "../../api";
import { useAction, usePage } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import {
  settingsSchema,
  settingsFormValues,
  settingFieldName,
} from "../../lib/form-schemas";
import { ValidatedForm } from "../common/ValidatedForm";
import { QueryState, TextField, Toggle } from "../common/workspace";
import { Button } from "../ui/button";
const groups = [
  { value: "network", label: "网络与访问" },
  { value: "storage", label: "目录与运行" },
  { value: "login", label: "飞书登录" },
  { value: "branding", label: "品牌外观" },
  { value: "security", label: "安全" },
];
const fields: Record<
  string,
  { label: string; group: string; type?: string; required?: boolean }
> = {
  "app.port": {
    label: "API 端口",
    group: "network",
    type: "number",
    required: true,
  },
  "app.bind-address": {
    label: "API 监听地址",
    group: "network",
    required: true,
  },
  "web.port": {
    label: "Web 端口",
    group: "network",
    type: "number",
    required: true,
  },
  "web.bind-address": {
    label: "Web 监听地址",
    group: "network",
    required: true,
  },
  "app.base-url": { label: "浏览器访问基址", group: "network" },
  "app.timezone": {
    label: "时区（IANA，如 Asia/Shanghai）",
    group: "network",
  },
  "web.trust-proxy": {
    label: "信任本机反向代理",
    group: "network",
    type: "boolean",
  },
  "storage.data-dir": {
    label: "数据目录（只读）",
    group: "storage",
    required: true,
  },
  "logging.dir": { label: "日志目录", group: "storage", required: true },
  "worker.interval-seconds": {
    label: "后台巡检间隔（秒）",
    group: "storage",
    type: "number",
    required: true,
  },
  "feishu.login.app-id": { label: "登录应用 App ID", group: "login" },
  "feishu.login.app-secret": {
    label: "登录应用 App Secret",
    group: "login",
    type: "password",
  },
  "feishu.login.redirect-uri": { label: "OAuth 回调 URL", group: "login" },
  "feishu.login.tenant-key": { label: "Tenant Key", group: "login" },
  "platform.name": { label: "平台名称", group: "branding", required: true },
  "platform.title": { label: "平台全称（登录页标题）", group: "branding" },
  "platform.logo": { label: "Logo", group: "branding" },
  "platform.favicon": { label: "Favicon", group: "branding" },
  "platform.primary-color": {
    label: "品牌主色",
    group: "branding",
    required: true,
  },
  "auth.cookie-secure": {
    label: "仅使用 HTTPS Cookie",
    group: "security",
    type: "boolean",
  },
  "security.api-rate-limit": {
    label: "API 每分钟请求上限",
    group: "security",
    type: "number",
  },
  "security.auth-rate-limit": {
    label: "登录接口每分钟上限",
    group: "security",
    type: "number",
  },
  "security.expensive-rate-limit": {
    label: "高开销接口每分钟上限",
    group: "security",
    type: "number",
  },
};
const restartKeys = [
  "app.port",
  "app.bind-address",
  "web.port",
  "web.bind-address",
  "web.trust-proxy",
  "app.base-url",
  "logging.dir",
  "worker.interval-seconds",
  "auth.cookie-secure",
  "security.api-rate-limit",
  "security.auth-rate-limit",
  "security.expensive-rate-limit",
];
export function ConfigurationEditor() {
  const [params] = useSearchParams();
  const [section, setSection] = useState(
    ["branding", "login"].includes(params.get("tab") || "")
      ? params.get("tab")!
      : "network",
  );
  const q = usePage("file-configuration", () =>
    request("/system/configuration"),
  );
  const [values, setValues] = useState<Record<string, string>>({}),
    [original, setOriginal] = useState<Record<string, string>>({}),
    [revision, setRevision] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const { saving, act } = useAction();
  const { reloadBranding } = useSession();
  useEffect(() => {
    if (q.data && !revision) {
      setValues(q.data.values);
      setOriginal(q.data.values);
      setRevision(q.data.revision);
      setPending(q.data.pendingRestart);
    }
  }, [q.data, revision]);
  const dirty = Object.keys(values).some((k) => values[k] !== original[k]);
  async function save() {
    await act(async () => {
      const changed = Object.fromEntries(
        Object.entries(values).filter(([k, v]) => v !== original[k]),
      );
      const result = await request("/system/configuration", "PATCH", {
        revision,
        values: changed,
      });
      setValues(result.values);
      setOriginal(result.values);
      setRevision(result.revision);
      setPending(result.pendingRestart);
      await reloadBranding();
    }, "配置已保存");
  }
  return (
    <div className="settings-panel">
      <div
        className="section-tabs settings-subtabs"
        role="tablist"
        aria-label="配置分组"
      >
        {groups.map((group) => (
          <button
            key={group.value}
            type="button"
            role="tab"
            aria-selected={section === group.value}
            tabIndex={section === group.value ? 0 : -1}
            className="section-tab"
            onClick={() => setSection(group.value)}
          >
            {group.label}
          </button>
        ))}
      </div>
      {pending.length > 0 && (
        <div role="status" className="configuration-pending">
          <span>
            待重启生效：{pending.map((k) => fields[k]?.label || k).join("、")}
          </span>
          <Link to="/settings?tab=operations">前往运行管理</Link>
        </div>
      )}
      <div className="settings-card">
        <QueryState
          loading={q.isLoading}
          error={q.isError}
          retry={() => void q.refetch()}
        >
          <ValidatedForm
            id="configuration-form"
            className="configuration-fields"
            values={settingsFormValues(values)}
            schema={settingsSchema}
            onInvalidField={(name) => {
              const key = Object.keys(fields).find(
                (k) => settingFieldName(k) === name,
              );
              if (key) setSection(fields[key]!.group);
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {Object.entries(fields)
              .filter(([, meta]) => meta.group === section)
              .map(([key, meta]) => (
                <div key={key} className="configuration-field">
                  {meta.type === "boolean" ? (
                    <Toggle
                      label={meta.label}
                      checked={values[key] === "true"}
                      onChange={(v) =>
                        setValues((s) => ({ ...s, [key]: String(v) }))
                      }
                    />
                  ) : (
                    <TextField
                      label={meta.label}
                      name={settingFieldName(key)}
                      value={values[key] || ""}
                      type={meta.type || "text"}
                      required={meta.required}
                      disabled={key === "storage.data-dir"}
                      autoComplete="off"
                      onChange={(v) => setValues((s) => ({ ...s, [key]: v }))}
                    />
                  )}
                  <div className="configuration-meta">
                    <code>{key}</code>
                    <span>
                      {key === "storage.data-dir"
                        ? "停机迁移"
                        : restartKeys.includes(key)
                          ? "重启生效"
                          : "立即生效"}
                    </span>
                  </div>
                  {pending.includes(key) && (
                    <p className="text-sm text-amber-700">
                      运行中：{q.data?.effective?.[key] || "未设置"}
                    </p>
                  )}
                </div>
              ))}
            {section === "security" && (
              <div className="rounded-lg border p-4 text-sm">
                内部加密密钥：
                {q.data?.encryptionKeyConfigured ? "已配置" : "未配置"}
              </div>
            )}
            {section === "branding" && (
              <div className="flex gap-5 items-center">
                <img
                  className="h-10 w-10 object-contain"
                  alt="Logo 预览"
                  src={
                    /^https?:\/\//.test(values["platform.logo"] || "") ||
                    values["platform.logo"] === "/logo.svg"
                      ? values["platform.logo"]
                      : "/api/system/branding/logo"
                  }
                />
              </div>
            )}
          </ValidatedForm>
        </QueryState>
        <div className="settings-card-actions">        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={q.isFetching || saving}
            onClick={() =>
              void act(async () => {
                const result = await q.refetch();
                if (result.data) {
                  setValues(result.data.values);
                  setOriginal(result.data.values);
                  setRevision(result.data.revision);
                  setPending(result.data.pendingRestart);
                }
              })
            }
          >
            <RefreshCw />
            重新读取
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving}
            form="configuration-form"
          >
            <Save />
            保存配置变更
          </Button>
        </div>
        </div>
      </div>
    </div>
  );
}
