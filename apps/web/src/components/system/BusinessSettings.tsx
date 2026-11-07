import { z } from "zod";
const recordingSchema = z.object({
  ttlDays: z
    .string()
    .refine(
      (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 365,
      "请填写 1–365 天",
    ),
});
import { useEffect, useState } from "react";
import { Save, Video } from "lucide-react";
import { request } from "../../api";
import { useAction, usePage } from "../../lib/hooks";
import { ValidatedForm } from "../common/ValidatedForm";
import { connectionSchema } from "../../lib/form-schemas";
import {
  Panel,
  QueryState,
  SelectField,
  TextField,
  Toggle,
} from "../common/workspace";
import { Button } from "../ui/button";
type Connection = {
  kind: string;
  name:string;
  fields:{key:string;label:string;required?:boolean;secret?:boolean;type?:string}[];
  configured: boolean;
  values: Record<string, string>;
};
function ConnectionCard({
  row,
  onSaved,
}: {
  row: Connection;
  onSaved: () => void;
}) {
  const { saving, act } = useAction();
  const [draft, setDraft] = useState(row.values);
  useEffect(() => setDraft(row.values), [row.values]);

  const changed = Object.keys(draft).some((k) => draft[k] !== row.values[k]);
  return (
    <Panel>
      <div className="p-5 border-b flex items-center gap-3">
        <span className="rounded-xl bg-primary-weak p-2.5">
          <Video className="h-5 w-5 text-[#7284a0]" />
        </span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold">{row.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            根据组件声明配置连接；能力会自动显示在对应管理页面。
          </p>
        </div>
        <span
          className={`rounded-md px-2 py-1 text-xs border ${row.configured ? "bg-emerald-50 border-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}
        >
          {row.configured ? "已配置" : "待配置"}
        </span>
      </div>
      <ValidatedForm
        values={draft}
        schema={connectionSchema.superRefine((values,ctx)=>{
          for(const field of row.fields){
            const value=values[field.key] || "";
            if(field.required && !value.trim())ctx.addIssue({code:"custom",path:[field.key],message:`请填写${field.label}`});
            if(field.type==="number" && value.trim() && !/^\d+$/.test(value))ctx.addIssue({code:"custom",path:[field.key],message:`${field.label}必须是整数`});
          }
        })}
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await request(`/platform-connections/${row.kind}`, "PATCH", draft);
            onSaved();
          }, "平台连接已保存");
        }}
      >
        <div className="settings-form-scroll">
        <div className="form-grid">
          {row.fields.map((field) => { const k=field.key; return (
            <TextField
              key={k}
              name={k}
              label={field.label}
              value={draft[k]}
              onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
              type={field.secret ? "password" : field.type==="number" ? "number" : "text"}
              required={field.required}
              autoComplete="off"
            />
          );})}
          </div>
        </div>
        <div className="settings-form-footer">
          <p className="text-xs text-muted-foreground">
            密钥以掩码显示，保持掩码可保留原值。
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || changed || !row.configured}
              title={changed ? "请先保存连接" : "测试已保存的配置"}
              onClick={() =>
                void act(
                  () =>
                    request(`/platform-connections/${row.kind}/test`, "POST"),
                  "连接测试通过",
                )
              }
            >
              测试连接
            </Button>
            <Button size="sm" disabled={saving}>
              <Save />
              保存连接
            </Button>
          </div>
        </div>
      </ValidatedForm>
    </Panel>
  );
}


const FEISHU_KINDS = ["feishu-directory", "feishu-meeting", "feishu-calendar"];

/** 三个飞书能力共用一组应用凭据，界面上只保留一张飞书卡片。 */
function feishuFields(rows: Connection[]) {
  const merged = new Map<string, Connection["fields"][number]>();
  for (const row of rows)
    for (const field of row.fields) if (!merged.has(field.key)) merged.set(field.key, field);
  return [...merged.values()];
}

function feishuValues(rows: Connection[], fields: Connection["fields"]) {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const current = rows.map((row) => row.values[field.key]).find((value) => value?.trim());
    values[field.key] = current || "";
  }
  return values;
}

function FeishuConnectionCard({
  rows,
  onSaved,
}: {
  rows: Connection[];
  onSaved: () => void;
}) {
  const fields = feishuFields(rows);
  const initial = feishuValues(rows, fields);
  const { saving, act } = useAction();
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft(feishuValues(rows, feishuFields(rows)));
  }, [rows]);
  const changed = Object.keys(draft).some((key) => draft[key] !== initial[key]);
  const configured = rows.every((row) => row.configured);
  return (
    <Panel>
      <div className="p-5 border-b flex items-center gap-3">
        <span className="rounded-xl bg-primary-weak p-2.5">
          <Video className="h-5 w-5 text-[#7284a0]" />
        </span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold">飞书</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            通讯录、会议和日程共用这一组飞书应用凭据。
          </p>
        </div>
        <span
          className={`rounded-md px-2 py-1 text-xs border ${configured ? "bg-emerald-50 border-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}
        >
          {configured ? "已配置" : "待配置"}
        </span>
      </div>
      <ValidatedForm
        values={draft}
        schema={connectionSchema.superRefine((values, ctx) => {
          for (const field of fields) {
            const value = values[field.key] || "";
            if (field.required && !value.trim())
              ctx.addIssue({
                code: "custom",
                path: [field.key],
                message: `请填写${field.label}`,
              });
            if (field.type === "number" && value.trim() && !/^\d+$/.test(value))
              ctx.addIssue({
                code: "custom",
                path: [field.key],
                message: `${field.label}必须是整数`,
              });
          }
        })}
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            for (const row of rows) {
              const payload = Object.fromEntries(
                row.fields.map((field) => [field.key, draft[field.key] ?? ""]),
              );
              await request(`/platform-connections/${row.kind}`, "PATCH", payload);
            }
            onSaved();
          }, "飞书连接已保存");
        }}
      >
        <div className="settings-form-scroll">
          <div className="form-grid">
          {fields.map((field) => {
            const key = field.key;
            return (
              <TextField
                key={key}
                name={key}
                label={field.label}
                value={draft[key]}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, [key]: value }))
                }
                type={
                  field.secret
                    ? "password"
                    : field.type === "number"
                      ? "number"
                      : "text"
                }
                required={field.required}
                autoComplete="off"
              />
            );
          })}
          </div>
        </div>
        <div className="settings-form-footer">
          <p className="text-xs text-muted-foreground">
            保存后飞书通讯录、会议和日程会使用同一组应用凭据。
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || changed || !configured}
              title={changed ? "请先保存连接" : "测试已保存的配置"}
              onClick={() =>
                void act(async () => {
                  for (const row of rows)
                    await request(
                      `/platform-connections/${row.kind}/test`,
                      "POST",
                    );
                }, "飞书连接测试通过")
              }
            >
              测试连接
            </Button>
            <Button size="sm" disabled={saving}>
              <Save />
              保存连接
            </Button>
          </div>
        </div>
      </ValidatedForm>
    </Panel>
  );
}

export function BusinessSettings() {
  const [section, setSection] = useState("");
  const q = usePage("business-settings", async () => ({
    connections: await request("/platform-connections"),
    recording: await request("/system/business-settings"),
  }));
  const connections: Connection[] = q.data?.connections || [];
  const feishuRows = FEISHU_KINDS.map((kind) =>
    connections.find((row) => row.kind === kind),
  ).filter((row): row is Connection => Boolean(row));
  const otherConnections = connections.filter(
    (row) => !FEISHU_KINDS.includes(row.kind),
  );
  useEffect(() => {
    if (section || !q.data) return;
    setSection(
      feishuRows.length ? "feishu" : otherConnections[0]?.kind || "recording",
    );
  }, [section, q.data, feishuRows.length, otherConnections]);
  const sections = [
    ...(feishuRows.length ? [{ value: "feishu", label: "飞书" }] : []),
    ...otherConnections.map((row) => ({ value: row.kind, label: row.name })),
    { value: "booking", label: "预约默认值" },
    { value: "recording", label: "云录制策略" },
  ];
  return (
    <div className="settings-panel">
      <div
        className="section-tabs settings-subtabs"
        role="tablist"
        aria-label="业务设置分组"
      >
        {sections.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={section === item.value}
            tabIndex={section === item.value ? 0 : -1}
            className="section-tab"
            onClick={() => setSection(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="settings-card">
        <QueryState
          loading={q.isLoading}
          error={q.isError}
          retry={() => void q.refetch()}
        >
          {section === "recording"
            ? q.data && (
                <RecordingSettings
                  key={JSON.stringify(q.data.recording)}
                  values={q.data.recording}
                />
              )
            : section === "feishu"
              ? feishuRows.length > 0 && (
                  <FeishuConnectionCard
                    rows={feishuRows}
                    onSaved={() => void q.refetch()}
                  />
                )
              : section === "booking"
                ? <BookingDefaultsSettings />
                : connections
                    .filter((row) => row.kind === section)
                    .map((row) => (
                      <ConnectionCard
                        key={row.kind}
                        row={row}
                        onSaved={() => void q.refetch()}
                      />
                    ))}
        </QueryState>
      </div>
    </div>
  );
}
function BookingDefaultsSettings() {
  const q = usePage("booking-defaults", async () => ({
    defaults: await request("/system/booking-defaults"),
    platforms: await request("/platforms"),
  }));
  const platforms = Array.isArray(q.data?.platforms) ? q.data.platforms : [];
  const meetingPlatforms = platforms.filter(
    (p: any) => p.capability === "meeting" && p.configured,
  );
  const calendarPlatforms = platforms.filter(
    (p: any) => p.capability === "calendar" && p.configured,
  );
  const [meetingConnectionId, setMeetingConnectionId] = useState("");
  const [calendarConnectionIds, setCalendarConnectionIds] = useState<string[]>([]);
  const mandatoryCalendar =
    calendarPlatforms.length === 1 ? calendarPlatforms[0].connectionId : "";
  const [initialized, setInitialized] = useState(false);
  const { saving, act } = useAction();
  useEffect(() => {
    if (!q.data || initialized) return;
    setMeetingConnectionId(q.data.defaults.meetingConnectionId || "");
    setCalendarConnectionIds(
      mandatoryCalendar
        ? [mandatoryCalendar]
        : q.data.defaults.calendarConnectionIds || [],
    );
    setInitialized(true);
  }, [q.data, initialized]);
  return (
    <QueryState
      loading={q.isLoading}
      error={q.isError}
      retry={() => void q.refetch()}
    >
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(
            () =>
              request("/system/booking-defaults", "PATCH", {
                meetingConnectionId,
                calendarConnectionIds: mandatoryCalendar
                  ? [mandatoryCalendar]
                  : calendarConnectionIds,
              }),
            "预约默认值已保存",
          );
        }}
      >
        <div className="settings-form-scroll space-y-6">
        <div>
          <h2 className="text-sm font-semibold">预约默认值</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            新建会议时预选会议平台和关联日程，用户仍可自行调整。
          </p>
        </div>
        <SelectField
          name="meetingConnectionId"
          label="默认会议平台"
          value={meetingConnectionId}
          onChange={setMeetingConnectionId}
          options={[
            { value: "", label: "不预选，按可用平台自动选择" },
            ...meetingPlatforms.map((p: any) => ({
              value: p.connectionId,
              label: p.connectionId === "feishu-meeting" ? "飞书会议" : p.name,
            })),
          ]}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">默认关联日程</legend>
          {calendarPlatforms.length ? (
            calendarPlatforms.map((p: any) => (
              <label
                key={p.connectionId}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={
                    mandatoryCalendar === p.connectionId ||
                    calendarConnectionIds.includes(p.connectionId)
                  }
                  disabled={!!mandatoryCalendar}
                  title={
                    mandatoryCalendar
                      ? "当前只有一个日程平台，默认关联"
                      : undefined
                  }
                  onChange={(event) =>
                    setCalendarConnectionIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, p.connectionId])]
                        : current.filter((id) => id !== p.connectionId),
                    )
                  }
                />
                {p.name}日程
              </label>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">暂无已配置的日程平台</p>
          )}
        </fieldset>
        {!meetingPlatforms.length && !calendarPlatforms.length && (
          <p className="text-xs text-muted-foreground">
            先在业务设置中配置会议平台或日程平台，之后才能设置默认值。
          </p>
        )}
        </div>
        <div className="settings-form-footer">
          <Button disabled={saving}>
            <Save />
            保存预约默认值
          </Button>
        </div>
      </form>
    </QueryState>
  );
}

function RecordingSettings({
  values,
}: {
  values: { ttlDays: number; deleteRemote: boolean };
}) {
  const [days, setDays] = useState(String(values.ttlDays)),
    [remove, setRemove] = useState(values.deleteRemote);
  const { saving, act } = useAction();
  return (
    <ValidatedForm
      schema={recordingSchema}
      values={{ ttlDays: days }}
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          () =>
            request("/system/business-settings", "PATCH", {
              ttlDays: Number(days),
              deleteRemote: remove,
            }),
          "录制策略已保存",
        );
      }}
    >
      <div className="settings-form-scroll space-y-6">
      <TextField
        name="ttlDays"
        label="默认保留天数"
        type="number"
        min={1}
        max={365}
        value={days}
        onChange={setDays}
      />
      <Toggle
        label="到期删除支持此能力的平台云录制"
        checked={remove}
        onChange={setRemove}
      />
      </div>
      <div className="settings-form-footer">
        <Button disabled={saving}>
          <Save />
          保存录制策略
        </Button>
      </div>
    </ValidatedForm>
  );
}
