import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Bell,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  Eye,
  Loader2,
  MapPin,
  Plus,
  Pencil,
  Sparkles,
  Star,
  Trash2,
  Video,
} from "lucide-react";
import {
  RemindersField,
  ExtensionFields,
} from "../components/common/ScheduleFields";
import { ValidatedForm } from "../components/common/ValidatedForm";
import { TemplateField } from "../components/templates/TemplateField";
import { templateSchema } from "../lib/form-schemas";
import { useWorkspaceTabs } from "../lib/workspace-tabs";
import { request } from "../api";
import { usePage, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import {
  calendarPresets,
  readableTemplate,
  storedTemplate,
  previewTemplate,
} from "../lib/calendar-template";
import { Button } from "../components/ui/button";
import { OptionSelect } from "../components/common/OptionSelect";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  PageHeader,
  Panel,
  QueryState,
  TextField,
  Toggle,
  Status,
  Confirm,
  ErrorBanner,
  Modal,
  DataTable,
  SearchBox,
} from "../components/common/workspace";

type Editor = {
  name: string;
  title: string;
  description: string;
  location: string;
  reminders: number[];
  extras: { key: string; value: string }[];
  enabled: boolean;
  isDefault: boolean;
};
type TemplateRow = {
  id: number;
  name: string;
  titleTemplate: string;
  descriptionTemplate: string | null;
  locationTemplate: string | null;
  remindersJson: string | null;
  extensionsJson: string | null;
  enabled: boolean;
  isDefault: boolean;
};
const initial = (): Editor => ({
  name: calendarPresets[0]!.name,
  title: calendarPresets[0]!.title,
  description: calendarPresets[0]!.description,
  location: calendarPresets[0]!.location,
  reminders: [...calendarPresets[0]!.reminders],
  extras: [],
  enabled: true,
  isDefault: false,
});
const fromRow = (row: TemplateRow, duplicate = false): Editor => ({
  name: row.name + (duplicate ? "（副本）" : ""),
  title: readableTemplate(row.titleTemplate),
  description: readableTemplate(row.descriptionTemplate ?? ""),
  location: readableTemplate(row.locationTemplate || ""),
  reminders: JSON.parse(row.remindersJson || "[10]"),
  extras: Object.entries(JSON.parse(row.extensionsJson || "{}")).map(
    ([key, value]) => ({ key, value: String(value) }),
  ),
  enabled: Boolean(row.enabled),
  isDefault: !duplicate && Boolean(row.isDefault),
});
const describeReminders = (minutes: number[]) =>
  minutes.length
    ? minutes
        .map((n) =>
          n === 0
            ? "开始时"
            : n >= 60 && n % 60 === 0
              ? `提前 ${n / 60} 小时`
              : `提前 ${n} 分钟`,
        )
        .join("、")
    : "不提醒";

function CalendarPreview({
  form,
  platformName,
}: {
  form: Editor;
  platformName: string;
}) {
  return (
    <div className="template-preview">
      <div className="template-preview-caption">
        <CalendarDays />
        日程预览<span>示例数据</span>
      </div>
      <h2>{previewTemplate(form.title, platformName) || "未填写日程标题"}</h2>
      <div className="template-preview-meta">
        <Clock3 />
        <span>10月16日 周五 · 14:00 — 15:00</span>
      </div>
      {form.location && (
        <div className="template-preview-meta">
          <MapPin />
          <span>{previewTemplate(form.location, platformName)}</span>
        </div>
      )}
      <div className="template-preview-meta">
        <Bell />
        <span>{describeReminders(form.reminders)}</span>
      </div>
      <div className="template-preview-description">
        {previewTemplate(form.description, platformName) || (
          <span className="text-muted-foreground">未填写日程说明</span>
        )}
      </div>
      {form.extras.some((x) => x.key || x.value) && (
        <dl className="template-preview-extras">
          {form.extras.map(
            (x, i) =>
              (x.key || x.value) && (
                <div key={i}>
                  <dt>{x.key || "未填名称"}</dt>
                  <dd>{x.value || "—"}</dd>
                </div>
              ),
          )}
        </dl>
      )}
      <div className="template-preview-meeting">
        <Video />
        <div>
          <strong>会议平台</strong>
          <span>会议号和入会链接将在预约成功后生成</span>
        </div>
      </div>
      <p className="template-preview-note">
        以“产品周会”为例。实际日程使用本次预约的主题、时间和会议信息。
      </p>
    </div>
  );
}

export default function Templates() {
  const q = usePage<TemplateRow[]>("templates", () =>
    request("/calendar-templates"),
  );
  const { saving, act } = useAction(),
    { branding } = useSession();
  const [params, setParams] = useSearchParams(),
    { activeTab, setActiveTab } = useWorkspaceTabs();
  const editKey = params.get("edit"),
    editing = editKey !== null;
  const id = editKey && /^\d+$/.test(editKey) ? Number(editKey) : undefined;
  const initializedEditor = useRef<string | null>(null);
  const extrasRef = useRef<HTMLDetailsElement>(null);
  const [form, setForm] = useState<Editor>(initial),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [presetOpen, setPresetOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false),
    [previewForm, setPreviewForm] = useState<Editor>(initial);
  useEffect(() => {
    if (!editing) {
      initializedEditor.current = null;
      return;
    }
    if (!q.isSuccess || initializedEditor.current === editKey) return;
    const row = q.data.find((row) => row.id === id);
    setForm(row ? fromRow(row) : initial());
    setError(
      editKey !== "new" && !row
        ? "模板不存在或已被删除，请返回列表重新选择。"
        : "",
    );
    initializedEditor.current = editKey;
  }, [editKey, editing, id, q.data, q.isSuccess]);
  function edit(row?: TemplateRow, duplicate = false) {
    const nextKey = row && !duplicate ? String(row.id) : "new";
    initializedEditor.current = nextKey;
    setForm(row ? fromRow(row, duplicate) : initial());
    setError("");
    setParams({ edit: nextKey });
  }
  function set<K extends keyof Editor>(key: K, value: Editor[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (editKey !== "new" && !q.data?.some((row) => row.id === id)) {
      setError("模板已不存在，请返回列表。");
      return;
    }
    const extensions: Record<string, string> = {};
    for (const extra of form.extras) {
      const key = extra.key.trim();
      if (!key && !extra.value.trim()) continue;
      if (!key || Object.hasOwn(extensions, key)) {
        setError(!key ? "请为补充信息填写名称" : `补充信息名称“${key}”重复`);
        setActiveTab("settings");
        return;
      }
      extensions[key] = extra.value;
    }
    await act(async () => {
      await request(
        `/calendar-templates${id ? `/${id}` : ""}`,
        id ? "PATCH" : "POST",
        {
          name: form.name,
          titleTemplate: storedTemplate(form.title),
          descriptionTemplate: storedTemplate(form.description),
          locationTemplate: storedTemplate(form.location),
          reminders: form.reminders,
          extensions,
          enabled: form.enabled,
          isDefault: form.isDefault,
        },
      );
      setParams({});
    }, "日程模板已保存");
  }
  const rows = (q.data || []).filter(
    (row) =>
      (statusFilter !== "enabled" || row.enabled) &&
      (statusFilter !== "disabled" || !row.enabled) &&
      `${row.name} ${row.titleTemplate} ${row.descriptionTemplate || ""}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
  );
  const preview = (
    <CalendarPreview
      form={editing ? form : previewForm}
      platformName={branding.name}
    />
  );
  const previewModal = (
    <Modal
      open={previewOpen}
      onClose={() => setPreviewOpen(false)}
      title="日程预览"
      bodyClassName="template-preview-modal"
    >
      {preview}
    </Modal>
  );

  if (editing)
    return (
      <div className="page-shell page-shell--template-editor">
        <PageHeader title={id ? "编辑日程模板" : "创建日程模板"} />
        <QueryState
          loading={q.isLoading}
          error={q.isError}
          retry={() => void q.refetch()}
        >
          <div className="template-editor-layout">
            <ValidatedForm
              values={form}
              schema={templateSchema}
              onSubmit={save}
              onInvalidField={(name) => {
                setActiveTab(
                  ["reminders", "extras", "enabled", "isDefault"].includes(name)
                    ? "settings"
                    : "content",
                );
                if (name === "extras" && extrasRef.current)
                  extrasRef.current.open = true;
              }}
              className="template-editor-form"
            >
              <Panel className="template-editor-panel">
                <div className="template-editor-toolbar">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => setParams({})}
                  >
                    <ArrowLeft />
                    返回列表
                  </Button>
                  <div className="template-editor-toolbar-actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="template-preview-button"
                      onClick={() => setPreviewOpen(true)}
                    >
                      <Eye />
                      预览
                    </Button>
                    <Popover open={presetOpen} onOpenChange={setPresetOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={saving}
                        >
                          <Sparkles />
                          套用样式
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="template-preset-picker"
                        align="end"
                        aria-label="选择常用样式"
                      >
                        {calendarPresets.map((preset) => (
                          <button
                            type="button"
                            key={preset.name}
                            onClick={() => {
                              setForm((current) => ({
                                ...current,
                                title: preset.title,
                                description: preset.description,
                                location: preset.location,
                                reminders: [...preset.reminders],
                              }));
                              setPresetOpen(false);
                            }}
                          >
                            <CalendarDays />
                            <span>
                              <strong>{preset.name}</strong>
                              <small>{preset.hint}</small>
                            </span>
                          </button>
                        ))}
                        <p>
                          替换标题、说明、地点和提醒，保留模板名称及其他设置。
                        </p>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
                <fieldset
                  disabled={saving}
                  className="card-scroll template-editor-body"
                >
                  {error && <ErrorBanner message={error} />}
                  <div
                    hidden={activeTab === "settings"}
                    className="template-editor-section"
                    role="tabpanel"
                    aria-label="日程内容"
                  >
                    <div className="form-grid">
                      <TextField
                        name="name"
                        label="模板名称"
                        value={form.name}
                        onChange={(v) => set("name", v)}
                        required
                        placeholder="例如：研发周会"
                      />
                      <TemplateField
                        name="location"
                        label="日程地点"
                        value={form.location}
                        onChange={(v) => set("location", v)}
                      />
                    </div>
                    <TemplateField
                      name="title"
                      label="日程标题"
                      value={form.title}
                      onChange={(v) => set("title", v)}
                      required
                    />
                    <TemplateField
                      name="description"
                      label="日程说明"
                      value={form.description}
                      onChange={(v) => set("description", v)}
                      multiline
                    />
                    <p className="template-field-note">
                      【会议主题】、【会议号】等变量会自动替换。将光标放在需要的位置，再点击“插入变量”。
                    </p>
                  </div>
                  <div
                    hidden={activeTab !== "settings"}
                    className="template-editor-section"
                    role="tabpanel"
                    aria-label="提醒与设置"
                  >
                    <section className="template-settings-block">
                      <h3>日程提醒</h3>
                      <RemindersField
                        value={form.reminders}
                        onChange={(v) => set("reminders", v)}
                      />
                    </section>
                    <section className="template-settings-block">
                      <h3>使用设置</h3>
                      <Toggle
                        label="启用此模板"
                        checked={form.enabled}
                        onChange={(v) =>
                          setForm((current) => ({
                            ...current,
                            enabled: v,
                            isDefault: v && current.isDefault,
                          }))
                        }
                        hint="启用后，预约人可以选择此模板。"
                      />
                      <Toggle
                        label="设为预约默认模板"
                        checked={form.isDefault}
                        onChange={(v) =>
                          setForm((current) => ({
                            ...current,
                            isDefault: v,
                            enabled: v || current.enabled,
                          }))
                        }
                        hint="新预约自动选中此模板；设置默认时会自动启用。"
                      />
                    </section>
                    <details ref={extrasRef} className="template-extras">
                      <summary>
                        补充信息 <span>项目、联系人等选填内容</span>
                      </summary>
                      <div className="pt-4">
                        <ExtensionFields
                          name="extras"
                          value={form.extras}
                          onChange={(v) => set("extras", v)}
                        />
                      </div>
                    </details>
                  </div>
                </fieldset>
                <div className="template-editor-footer">
                  <span>
                    {form.isDefault ? (
                      <>
                        <Check />
                        默认模板
                      </>
                    ) : form.enabled ? (
                      "保存后可在预约中选择"
                    ) : (
                      "此模板已停用"
                    )}
                  </span>
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={saving}
                      onClick={() => setParams({})}
                    >
                      取消
                    </Button>
                    <Button type="submit" disabled={saving}>
                      {saving && <Loader2 className="animate-spin" />}保存模板
                    </Button>
                  </div>
                </div>
              </Panel>
            </ValidatedForm>
            <aside className="template-preview-desktop" aria-label="日程预览">
              {preview}
            </aside>
          </div>
        </QueryState>
        {previewModal}
      </div>
    );
  return (
    <div className="page-shell page-shell--templates page-shell--table">
      <PageHeader title="日程模板" />
      <Panel className="table-panel template-list-panel">
        <div
          className="template-list-toolbar"
          role="group"
          aria-label="日程模板筛选与操作"
        >
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="搜索模板名称或内容"
          />
          <OptionSelect
            className="template-status-filter"
            label="筛选模板状态"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "", label: "全部状态" },
              { value: "enabled", label: "已启用" },
              { value: "disabled", label: "已停用" },
            ]}
          />
          <Button size="sm" onClick={() => edit()}>
            <Plus />
            创建模板
          </Button>
        </div>
        <div className="table-panel-body">
          <QueryState
            loading={q.isLoading}
            error={q.isError}
            retry={() => void q.refetch()}
          >
            <DataTable
              rows={rows}
              emptyTitle={
                search || statusFilter ? "没有找到匹配的模板" : "暂无日程模板"
              }
              emptyHint={
                search || statusFilter
                  ? "试试其他关键词或状态。"
                  : "创建一个模板，预约时即可复用日程内容。"
              }
              columns={[
                {
                  key: "name",
                  title: "模板",
                  className: "template-cell-center",
                  render: (row) => (
                    <div className="template-table-name">
                      <span className="template-table-icon">
                        <CalendarDays />
                      </span>
                      <strong className="truncate">{row.name}</strong>
                    </div>
                  ),
                },
                {
                  key: "title",
                  title: "日程标题示例",
                  className: "template-cell-center",
                  render: (row) => (
                    <span className="template-table-title">
                      {previewTemplate(row.titleTemplate, branding.name)}
                    </span>
                  ),
                },
                {
                  key: "reminders",
                  title: "提醒",
                  className: "template-cell-center",
                  render: (row) => (
                    <span className="text-muted-foreground">
                      {describeReminders(
                        JSON.parse(row.remindersJson || "[10]"),
                      )}
                    </span>
                  ),
                },
                {
                  key: "status",
                  title: "状态",
                  className: "template-cell-center",
                  render: (row) => (
                    <Status value={row.enabled ? "active" : "disabled"} />
                  ),
                },
                {
                  key: "default",
                  title: "默认",
                  width: 72,
                  className: "template-default-column",
                  render: (row) =>
                    row.isDefault ? (
                      <span
                        className="template-default-mark"
                        title="当前默认模板"
                        aria-label="当前默认模板"
                      >
                        <Star
                          className="template-default-star is-default"
                          fill="currentColor"
                        />
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="template-default-toggle"
                        aria-label={`设 ${row.name} 为默认模板`}
                        title={
                          row.enabled
                            ? "设为默认模板"
                            : "停用模板不能设为默认"
                        }
                        disabled={!row.enabled || saving}
                        onClick={() =>
                          void act(
                            () =>
                              request(
                                `/calendar-templates/${row.id}/default`,
                                "POST",
                              ),
                            "已设为默认模板",
                          )
                        }
                      >
                        <Star className="template-default-star" />
                      </button>
                    ),
                },
                {
                  key: "actions",
                  title: "操作",
                  width: 272,
                  className: "template-cell-center template-actions-column",
                  render: (row) => (
                    <div className="row-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => edit(row)}
                        aria-label="编辑"
                        title={`编辑 ${row.name}`}
                      >
                        <Pencil className="template-action-icon" />
                        <span className="template-action-label">编辑</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="预览"
                        title={`预览 ${row.name}`}
                        onClick={() => {
                          setPreviewForm(fromRow(row));
                          setPreviewOpen(true);
                        }}
                      >
                        <Eye className="template-action-icon" />
                        <span className="template-action-label">预览</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`复制 ${row.name}`}
                        title="复制模板"
                        onClick={() => edit(row, true)}
                      >
                        <Copy />
                      </Button>
                      <Confirm
                        title="删除日程模板"
                        description="已有会议引用的模板请使用停用。删除后无法恢复。"
                        onConfirm={() =>
                          act(
                            () =>
                              request(
                                `/calendar-templates/${row.id}`,
                                "DELETE",
                              ),
                            "模板已删除",
                          )
                        }
                      >
                        {(show) => (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground"
                            aria-label={`删除 ${row.name}`}
                            title="删除模板"
                            disabled={saving}
                            onClick={show}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </Confirm>
                    </div>
                  ),
                },
              ]}
            />
          </QueryState>
        </div>
      </Panel>
      {previewModal}
    </div>
  );
}
