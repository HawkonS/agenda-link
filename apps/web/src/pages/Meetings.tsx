import { type ExtraRow } from "../components/common/ScheduleFields";
import { ValidatedForm } from "../components/common/ValidatedForm";
import { meetingSchema } from "../lib/form-schemas";
import {
  hostPreference,
  hostSourceLabel,
  type HostPreview,
} from "../lib/meeting-host";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Clock3,
  SlidersHorizontal,
  Video,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createMeeting, request, requestKey } from "../api";
import { usePage, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { localDateTimeValue, parseLocalDateTime } from "../lib/date-time";
import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  ErrorBanner,
  FormActions,
  MultiPicker,
  PageHeader,
  Panel,
  QueryState,
  SelectField,
  TextField,
} from "../components/common/workspace";

const empty = (
  ttl = 30,
  accountPoolId = "",
  calendarTemplateId = "",
  attendeeId?: number,
) => ({
  connectionId:"",calendarConnectionIds:[] as string[],
  subject: "",
  description: "",
  startAt: "",
  endAt: "",
  accountPoolId,
  hostSelection: "auto",
  calendarTemplateId,
  attendeeIds: attendeeId === undefined ? [] : [attendeeId],
  attendeeEmails: "",
  // 预约页不展示模板扩展字段的编辑控件。
  extensions: [] as ExtraRow[],
  recordingEnabled: true,
  recordingTtlDays: ttl,
});

function HostAccountSummary({
  host,
}: {
  host: Extract<HostPreview, { available: true }>;
}) {
  const source = hostSourceLabel(host.allocationSource);
  const tag = { personal: "本人", invitee: "受邀人", pool: "账号池", configured:"默认归属人" }[
    host.allocationSource
  ];
  const details = `${host.hostAccountName} · ${source}\n账号：${host.hostAccountId}${host.accountPoolName ? `\n账号池：${host.accountPoolName}` : ""}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="booking-host-preview"
          aria-label={`查看发起账号：${host.hostAccountName}`}
          title={details}
        >
          <span className="booking-host-name">{host.hostAccountName}</span>
          <span className="booking-host-source">{tag}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="booking-host-details"
        align="end"
        role="dialog"
        aria-label="发起账号详情"
      >
        <strong>{host.hostAccountName}</strong>
        <dl>
          <dt>会议平台账号</dt>
          <dd>{host.hostAccountId}</dd>
          <dt>账号来源</dt>
          <dd>{source}</dd>
          {host.accountPoolName && (
            <>
              <dt>所属账号池</dt>
              <dd>{host.accountPoolName}</dd>
            </>
          )}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

export default function Meetings() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editId = Number(searchParams.get("edit")) || 0;
  const editing = editId > 0;
  const { user } = useSession();
  const [narrowScreen, setNarrowScreen] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 767,
  );
  useEffect(() => {
    const onResize = () => setNarrowScreen(window.innerWidth <= 767);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const queryClient = useQueryClient();
  const [form, setForm] = useState(empty());
  const [key, setKey] = useState(requestKey());
  const [error, setError] = useState("");
  const initialized = useRef(false);
  const endTimeEdited = useRef(false);
  const { saving, act } = useAction();
  const q = usePage("booking-form", async () => {
    const [people, pools, templates, options] = await Promise.all([
      request("/directory/people"),
      request("/account-pools"),
      request("/calendar-templates"),
      request("/booking/options"),
    ]);
    return { people, pools, templates, options };
  });
  const editQuery = useQuery({
    queryKey: ["meeting-edit", editId],
    queryFn: () => request(`/meetings/${editId}`),
    enabled: editing,
  });
  const {
    people: fallbackPeople = [],
    pools = [],
    templates = [],
    options = {},
  } = q.data || {};

  const meetingPlatforms=(options.platforms || []).filter((p:any)=>p.capability==="meeting");
  const calendarPlatforms=(options.platforms || []).filter((p:any)=>p.capability==="calendar");
  const currentPlatform=meetingPlatforms.find((p:any)=>p.connectionId===form.connectionId);
  const isLocalMeeting = currentPlatform?.capabilities?.online === false;
  const onlineMeetingPlatforms = meetingPlatforms.filter(
    (p: any) => p.configured && p.capabilities?.online !== false,
  );
  const configuredCalendarPlatforms = calendarPlatforms.filter(
    (p: any) => p.configured,
  );
  const peopleQuery=usePage("booking-people-"+form.connectionId,()=>form.connectionId?request("/directory/people?connectionId="+encodeURIComponent(form.connectionId)):Promise.resolve(fallbackPeople));
  const people=peopleQuery.data || fallbackPeople;
  const hasPools=currentPlatform?.capabilities?.accountPool ?? true;
  const bookingDefaults=options.bookingDefaults || {};
  const configuredMeetingPlatforms=meetingPlatforms.filter((p:any)=>p.configured);
  const meetingPlatformLabel=(p:any)=>p.connectionId==="feishu-meeting" ? "飞书会议" : p.name;
  const singleCalendarConnection=configuredCalendarPlatforms.length===1 ? configuredCalendarPlatforms[0].connectionId : "";
  const defaultMeetingConnection=
    configuredMeetingPlatforms.find((p:any)=>p.connectionId===bookingDefaults.meetingConnectionId)?.connectionId ||
    (configuredMeetingPlatforms.length===1 ? configuredMeetingPlatforms[0].connectionId : "");
  const defaultCalendarConnections=singleCalendarConnection
    ? [singleCalendarConnection]
    : (Array.isArray(bookingDefaults.calendarConnectionIds)
        ? bookingDefaults.calendarConnectionIds
        : []).filter((id:string)=>configuredCalendarPlatforms.some((p:any)=>p.connectionId===id));
  useEffect(() => {
    if (isLocalMeeting && form.recordingEnabled)
      setForm((current) => ({ ...current, recordingEnabled: false }));
  }, [isLocalMeeting, form.recordingEnabled]);
  const preference = hostPreference(form.hostSelection);
  const hostSelectionError =
    preference.hostMode === "person" &&
    q.isSuccess &&
    !people.some(
      (person: any) =>
        person.id === preference.hostUserId &&
        person.canHost &&
        (person.id === user?.id || form.attendeeIds.includes(person.id)),
    )
      ? "所选发起账号已不可用或对应人员不在参会人中，请重新选择发起账号"
      : "";
  const start = parseLocalDateTime(form.startAt),
    end = parseLocalDateTime(form.endAt);
  const timeError =
    form.startAt && !start
      ? "开始时间格式不正确"
      : form.endAt && !end
        ? "结束时间格式不正确"
        : start && end && end <= start
          ? "结束时间应晚于开始时间"
          : "";
  const previewTiming =
    q.isSuccess && (!options.platforms || !!form.connectionId) && !hostSelectionError && start && end && end > start
      ? {
          startAt: start.toISOString(),
          endAt: end.toISOString(),
        }
      : undefined;
  const previewInput = !editing && previewTiming
    ? JSON.stringify({
        ...previewTiming,
        ...(form.connectionId ? {connectionId:form.connectionId,providerId:currentPlatform?.providerId} : {}),
        attendeeIds: form.attendeeIds,
        ...hostPreference(form.hostSelection),
        ...(form.accountPoolId
          ? { accountPoolId: Number(form.accountPoolId) }
          : {}),
      })
    : "";
  const [debouncedPreview, setDebouncedPreview] = useState("");
  const previewQueryKey = ["booking-host", user?.id, debouncedPreview];
  const previousPreview =
    queryClient.getQueryState<HostPreview>(previewQueryKey);
  const requestedTiming = debouncedPreview
    ? JSON.parse(debouncedPreview)
    : undefined;
  // Adding invitees does not change a confirmed personal or explicitly selected host.
  // Its availability still refreshes on the same query every 15 seconds.
  const stableSelection =
    form.hostSelection === "auto"
      ? !requestedTiming?.hostMode &&
        previousPreview?.data?.available === true &&
        previousPreview.data.allocationSource === "personal"
      : form.hostSelection === "pool"
        ? requestedTiming?.hostMode === "pool" &&
          requestedTiming?.accountPoolId ===
            (form.accountPoolId ? Number(form.accountPoolId) : undefined)
        : requestedTiming?.hostMode === "person" &&
          requestedTiming?.hostUserId === preference.hostUserId &&
          (preference.hostUserId === user?.id ||
            form.attendeeIds.includes(preference.hostUserId!));
  const reuseConfirmedHost =
    stableSelection &&
    requestedTiming?.connectionId === (form.connectionId || undefined) &&
    !!previewTiming &&
    requestedTiming?.startAt === previewTiming.startAt &&
    requestedTiming?.endAt === previewTiming.endAt &&
    previousPreview?.status === "success" &&
    previousPreview.data?.available === true;
  const previewMatches =
    debouncedPreview === previewInput || reuseConfirmedHost;
  useEffect(() => {
    if (reuseConfirmedHost) return;
    const timer = window.setTimeout(
      () => setDebouncedPreview(previewInput),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [previewInput, reuseConfirmedHost]);
  const hostPreview = useQuery<HostPreview>({
    queryKey: previewQueryKey,
    queryFn: () =>
      request("/booking/host-preview", "POST", JSON.parse(debouncedPreview)),
    enabled: !!debouncedPreview && previewMatches,
    retry: false,
    refetchInterval: 15000,
    staleTime: 15000,
  });

  const defaultPoolId = String(
    pools.filter((pool:any)=>!pool.connectionId || pool.connectionId===form.connectionId).find((pool: any) => pool.enabled !== false && pool.isDefault)?.id ||
      "",
  );
  const defaultTemplateId = String(
    templates.find(
      (template: any) => template.enabled !== false && template.isDefault,
    )?.id || "",
  );
  const defaultAttendeeId = fallbackPeople.some((person: any) => person.id === user?.id)
    ? user?.id
    : undefined;

  useEffect(() => {
    if (q.data && !initialized.current && !editing) {
      setForm(
        {...empty(options.recordingTtlDays || 30,defaultPoolId,defaultTemplateId,defaultAttendeeId),connectionId:defaultMeetingConnection,calendarConnectionIds:defaultCalendarConnections},
      );
      initialized.current = true;
    }
  }, [
    q.data,
    editing,
    options.recordingTtlDays,
    defaultPoolId,
    defaultTemplateId,
    defaultAttendeeId,
  ]);
  useEffect(() => {
    if (!editing || !q.data || !editQuery.data || initialized.current) return;
    const meeting = editQuery.data;
    const attendees = Array.isArray(meeting.attendees)
      ? meeting.attendees
      : [];
    setForm({
      ...empty(
        meeting.recordingTtlDays || options.recordingTtlDays || 30,
        String(meeting.accountPoolId || ""),
        String(meeting.calendarTemplateId || ""),
      ),
      connectionId: meeting.connectionId || "",
      calendarConnectionIds: meeting.calendarConnectionId
        ? [meeting.calendarConnectionId]
        : [],
      subject: meeting.subject || "",
      description: meeting.description || "",
      startAt: localDateTimeValue(new Date(meeting.startAt)),
      endAt: localDateTimeValue(new Date(meeting.endAt)),
      accountPoolId: String(meeting.accountPoolId || ""),
      calendarTemplateId: String(meeting.calendarTemplateId || ""),
      attendeeIds: [
        ...new Set<number>(
          attendees
            .map((person: any) => Number(person.userId))
            .filter((value: number) => Number.isInteger(value) && value > 0),
        ),
      ],
      attendeeEmails: (meeting.attendeeEmails || []).join(", "),
      recordingEnabled: Boolean(meeting.recordingEnabled),
      recordingTtlDays: meeting.recordingTtlDays || 30,
    });
    endTimeEdited.current = true;
    initialized.current = true;
  }, [editing, q.data, editQuery.data, options.recordingTtlDays]);

  function set<K extends keyof typeof form>(k: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [k]: value }));
  }

  function setMeetingPlatform(value: string) {
    const next = meetingPlatforms.find((p: any) => p.connectionId === value);
    const local = next?.capabilities?.online === false;
    setForm((current) => ({
      ...current,
      connectionId: value,
      hostSelection: "auto",
      accountPoolId: "",
      ...(local ? { recordingEnabled: false } : {}),
    }));
    setDebouncedPreview("");
  }

  function setStartAt(startAt: string) {
    const start = parseLocalDateTime(startAt);
    const suggestEnd = !endTimeEdited.current;
    setForm((current) => ({
      ...current,
      startAt,
      endAt:
        suggestEnd && start
          ? localDateTimeValue(new Date(start.getTime() + 60 * 60 * 1000))
          : current.endAt,
    }));
  }

  function setEndAt(endAt: string) {
    endTimeEdited.current = !!endAt;
    set("endAt", endAt);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    let payload: any;
    try {
      if (!start || !end) throw new Error(timeError || "请选择开始和结束时间");
      if (editing) {
        payload = {
          subject: form.subject,
          description: form.description,
          startAt: start.toISOString(),
          endAt: end.toISOString(),
          attendeeIds: form.attendeeIds,
          attendeeEmails: form.attendeeEmails.split(/[\s,;]+/).filter(Boolean),
          calendarTemplateId: form.calendarTemplateId
            ? Number(form.calendarTemplateId)
            : null,
          recordingEnabled: isLocalMeeting ? false : form.recordingEnabled,
          recordingTtlDays: form.recordingTtlDays,
        };
        await act(async () => {
          const updated = await request(
            `/meetings/${editId}`,
            "PATCH",
            payload,
          );
          queryClient.setQueryData(
            ["calendar-detail", "meetings", editId],
            updated,
          );
          navigate(`/calendar?tab=list&meeting=${editId}`);
        }, "会议已更新");
        return;
      }
      if (end <= start) throw new Error("结束时间应晚于开始时间");
      if(options.platforms && !form.connectionId)throw new Error("请选择会议平台");
      const { hostSelection, ...fields } = form;
      if (hostSelectionError) throw new Error(hostSelectionError);
      payload = {
        ...fields,
        ...(options.platforms ? {providerId:currentPlatform?.providerId,connectionId:form.connectionId,calendarConnectionIds:singleCalendarConnection ? [singleCalendarConnection] : form.calendarConnectionIds} : {connectionId:undefined,calendarConnectionIds:[]}),
        ...(isLocalMeeting
          ? { hostMode: "auto", hostUserId: undefined }
          : hostPreference(hostSelection)),
        recordingEnabled: isLocalMeeting ? false : form.recordingEnabled,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        accountPoolId: !isLocalMeeting && hasPools && form.accountPoolId
          ? Number(form.accountPoolId)
          : undefined,
        calendarTemplateId: form.calendarTemplateId
          ? Number(form.calendarTemplateId)
          : undefined,
        // 保留空对象以兼容旧版接口；预约页不再展示难以理解的扩展字段。
        extensions: {},
        attendeeEmails: form.attendeeEmails.split(/[\s,;]+/).filter(Boolean),
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请检查预约信息");
      return;
    }
    await act(async () => {
      const created = await createMeeting(payload, key);
      queryClient.setQueryData(
        ["calendar-detail", "meetings", created.id],
        created,
      );
      navigate(`/meetings?tab=records&meeting=${created.id}`, {
        state: { createdSchedule: true },
      });
    }, "预约已提交");
  }

  const hostOptions = [
    { value: "auto", label: "自动选择（本人优先）" },
    ...people
      .filter(
        (person: any) =>
          person.canHost &&
          (person.id === user?.id || form.attendeeIds.includes(person.id)),
      )
      .map((person: any) => ({
        value: `person:${person.id}`,
        label: `${person.displayName}${person.id === user?.id ? "（我）" : ""}`,
      })),
    ...(hasPools ? [{ value: "pool", label: "使用账号池" }] : []),
  ];
  if (!hostOptions.some((option) => option.value === form.hostSelection))
    hostOptions.push({
      value: form.hostSelection,
      label: "所选账号已不可用，请重新选择",
    });
  const poolOptions = [
    { value: "", label: "自动选择空闲账号池" },
    ...pools
      .filter((pool: any) => pool.enabled !== false && (!pool.connectionId || pool.connectionId===form.connectionId))
      .map((pool: any) => ({
        value: String(pool.id),
        label: `${pool.name}${pool.isDefault ? "（默认）" : ""}`,
      })),
  ];
  const currentHost =
    previewInput &&
    previewMatches &&
    hostPreview.isSuccess &&
    hostPreview.data.available
      ? hostPreview.data
      : undefined;
  const templateName =
    templates.find(
      (template: any) =>
        String(template.id) === String(form.calendarTemplateId),
    )?.name || "默认日程格式";
  const selectedTemplate = templates.find(
    (template: any) =>
      String(template.id) === String(form.calendarTemplateId),
  );
  const templateUsesDescription =
    typeof selectedTemplate?.descriptionTemplate === "string" &&
    selectedTemplate.descriptionTemplate.includes("{description}");
  const meetingDescriptionField = (
    <TextField
      name="description"
      label="会议说明"
      value={form.description}
      onChange={(value) => set("description", value)}
      textarea
      placeholder="补充会议议程、准备事项或相关链接（选填）"
    />
  );
  const hostAccountContent = editing ? (
    <span className="booking-host-locked" title="已创建会议的发起账号不可更换">
      {editQuery.data?.hostAccountName || "发起账号"} · 已锁定
    </span>
  ) : timeError || hostSelectionError ? (
      <span className="font-normal text-destructive">
        {timeError || hostSelectionError}
      </span>
    ) : !previewInput ? (
      <span className="font-normal text-muted-foreground">
        {start
          ? "请选择结束时间"
          : end
            ? "请选择开始时间"
            : "填写开始和结束时间后显示"}
      </span>
    ) : !previewMatches || hostPreview.isPending ? (
      <span className="font-normal text-muted-foreground">
        正在查找可用发起账号…
      </span>
    ) : hostPreview.isError ? (
      <span className="font-normal text-destructive">
        暂时无法获取发起账号
        <Button
          type="button"
          size="sm"
          variant="link"
          onClick={() => void hostPreview.refetch()}
        >
          重试
        </Button>
      </span>
    ) : hostPreview.data?.available ? (
      <HostAccountSummary host={hostPreview.data} />
    ) : (
      <span className="font-normal text-destructive">
        {hostPreview.data?.reason || "当前没有可用发起账号"}
      </span>
    );
  const formatDate = (value: string) => {
    if (!value) return "待填写时间";
    const date = parseLocalDateTime(value);
    if (!date) return "待填写时间";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };

  return (
    <div className="page-shell page-shell--booking">
      <PageHeader title={editing ? "编辑预约" : "会议管理"} />
      <QueryState
        loading={q.isLoading || (editing && editQuery.isLoading)}
        error={q.isError || (editing && editQuery.isError)}
        retry={() => void q.refetch()}
      >
        <ValidatedForm
          key={key}
          id="meeting-booking-form"
          values={form}
          schema={meetingSchema}
          onSubmit={save}
          className="booking-layout"
        >
          <Panel
            className="booking-form-panel"
            title={editing ? "编辑预约信息" : "填写预约信息"}
            actions={
              <div className="booking-panel-host" aria-live="polite">
                {hostAccountContent}
              </div>
            }
          >
            <div className="booking-form">
              <fieldset
                disabled={saving}
                className="booking-form-body space-y-0"
              >
                {error && <ErrorBanner message={error} />}
                <section className="booking-section">
                  <div className="booking-section-heading">
                    <div>
                      <h3>会议内容</h3>
                    </div>
                  </div>
                  <div className="booking-section-fields">
                    <TextField
                      name="subject"
                      label="会议主题"
                      value={form.subject}
                      onChange={(value) => set("subject", value)}
                      required
                      placeholder="例如：产品周会"
                    />
                  </div>
                </section>
                <section className="booking-section">
                  <div className="booking-section-heading">
                    <div>
                      <h3>时间与日程</h3>
                    </div>
                  </div>
                  <div className="booking-section-fields form-grid">
                    <TextField
                      name="startAt"
                      label="开始时间"
                      type="datetime-local"
                      value={form.startAt}
                      onChange={setStartAt}
                      required
                    />
                    <TextField
                      name="endAt"
                      label="结束时间"
                      type="datetime-local"
                      value={form.endAt}
                      onChange={setEndAt}
                      required
                    />
                  </div>
                </section>
                <section className="booking-section">
                  <div className="booking-section-heading">
                    <div>
                      <h3>邀请参会人</h3>
                    </div>
                  </div>
                  <div className="booking-section-fields">
                    <MultiPicker
                      unit="人"
                      label="内部参会人"
                      selected={form.attendeeIds}
                      onChange={(value) => set("attendeeIds", value)}
                      options={people.map((person: any) => ({
                        id: person.id,
                        label:
                          person.displayName +
                          (person.id === user?.id
                            ? "（我）"
                            : (!hasPools || person.externalId) ? "" : "（尚未关联平台身份）"),
                        disabled:
                          hasPools && !person.externalId && person.id !== user?.id,
                      }))}
                    />
                  </div>
                </section>
                <details className="booking-disclosure">
                  <summary>
                    <span className="booking-disclosure-title">
                      <SlidersHorizontal aria-hidden="true" />
                      更多
                    </span>
                  </summary>
                  <div className="booking-disclosure-content">
                    <div className="booking-section-fields">
                      {!templateUsesDescription && meetingDescriptionField}
                      <TextField
                        name="attendeeEmails"
                        label="外部邀请邮箱"
                        value={form.attendeeEmails}
                        onChange={(value) => set("attendeeEmails", value)}
                        placeholder="name@company.com"
                      />
                    </div>
                    {!isLocalMeeting && <div className="form-grid">
                      <SelectField
                        name="recordingEnabled"
                        label="预约云录制"
                        value={form.recordingEnabled ? "enabled" : "disabled"}
                        onChange={(value) =>
                          set("recordingEnabled", value === "enabled")
                        }
                        options={[
                          { value: "enabled", label: "开启" },
                          { value: "disabled", label: "关闭" },
                        ]}
                      />
                      {form.recordingEnabled && (
                        <SelectField
                          name="recordingTtlDays"
                          label="保留天数"
                          value={form.recordingTtlDays}
                          onChange={(value) =>
                            set("recordingTtlDays", Number(value))
                          }
                          options={[
                            ...new Set([
                              7,
                              14,
                              30,
                              45,
                              60,
                              90,
                              180,
                              365,
                              form.recordingTtlDays,
                            ]),
                          ]
                            .filter((days) => days > 0)
                            .sort((a, b) => a - b)
                            .map((days) => ({
                              value: days,
                              label: `${days} 天`,
                            }))}
                        />
                      )}
                    </div>}
                  </div>
                </details>
              </fieldset>
            </div>
            <FormActions saving={saving} label={editing ? "保存修改" : "提交预约"} />
          </Panel>
          <div className="booking-sidebar">

            <aside className="booking-summary" aria-label="预约摘要">
              <div className="booking-summary-title">
                {form.subject || "未填写会议主题"}
              </div>
              <div className="booking-summary-time">
                <Clock3 aria-hidden="true" />
                <div>
                  <strong>{formatDate(form.startAt)}</strong>
                  <span>
                    {form.endAt
                      ? `结束于 ${formatDate(form.endAt)}`
                      : "请选择结束时间"}
                  </span>
                </div>
              </div>
              <div className="booking-summary-divider" />
              <fieldset
                disabled={saving}
                className="booking-summary-controls"
                aria-label="发起账号选择"
              >
                {editing ? (
                  <div className="booking-locked-field">
                    <span>发起账号</span>
                    <strong>
                      {editQuery.data?.hostAccountName || "已锁定"}
                    </strong>
                    <small>已创建会议不可更换</small>
                  </div>
                ) : (
                  !isLocalMeeting && (
                    <>
                      <SelectField
                        name="hostSelection"
                        label="发起账号"
                        value={form.hostSelection}
                        onChange={(value) => set("hostSelection", value)}
                        options={hostOptions}
                      />
                      {form.hostSelection === "pool" && (
                        <SelectField
                          name="accountPoolId"
                          label="账号池"
                          value={form.accountPoolId}
                          onChange={(value) => set("accountPoolId", value)}
                          options={poolOptions}
                        />
                      )}
                      <div className="booking-summary-divider" />
                    </>
                  )
                )}
                <div className="booking-summary-options">
<fieldset className="booking-mode-group">
                <legend>会议平台</legend>
                <div className="booking-choice-row">
                  {editing ? (
                    <span className="booking-mode-static">
                      {currentPlatform ? meetingPlatformLabel(currentPlatform) : "已锁定"}
                    </span>
                  ) : onlineMeetingPlatforms.length ? (
                    onlineMeetingPlatforms.map((p: any) => (
                      <button
                        key={p.connectionId}
                        type="button"
                        className={"booking-choice " + (form.connectionId === p.connectionId ? "is-active" : "")}
                        aria-pressed={form.connectionId === p.connectionId}
                        onClick={() => setMeetingPlatform(p.connectionId)}
                      >
                        {meetingPlatformLabel(p)}
                      </button>
                    ))
                  ) : (
                    <span className="booking-mode-static">无在线会议</span>
                  )}
                </div>
              </fieldset>
              <fieldset className="booking-mode-group">
                <legend>
                  关联日程
                  <span className="booking-mode-hint">
                    {configuredCalendarPlatforms.length > 1 ? "可多选" : "必选"}
                  </span>
                </legend>
                <div className="booking-choice-row">
                  {editing ? (
                    <span className="booking-mode-static">
                      {configuredCalendarPlatforms
                        .filter((p: any) =>
                          form.calendarConnectionIds.includes(p.connectionId),
                        )
                        .map((p: any) => p.name)
                        .join("、") || "系统日历"}
                    </span>
                  ) : configuredCalendarPlatforms.length ? (
                    configuredCalendarPlatforms.map((p: any) => {
                      const mandatory = configuredCalendarPlatforms.length === 1;
                      const checked = mandatory || form.calendarConnectionIds.includes(p.connectionId);
                      return (
                        <button
                          key={p.connectionId}
                          type="button"
                          className={"booking-choice " + (checked ? "is-active" : "")}
                          aria-pressed={checked}
                          aria-disabled={mandatory}
                          title={mandatory ? "当前只有一个日程平台，默认关联" : undefined}
                          onClick={() => {
                            if (mandatory) return;
                            set(
                              "calendarConnectionIds",
                              checked
                                ? form.calendarConnectionIds.filter((id: string) => id !== p.connectionId)
                                : [...form.calendarConnectionIds, p.connectionId],
                            );
                          }}
                        >
                          {p.name}日程
                        </button>
                      );
                    })
                  ) : (
                    <span className="booking-mode-static">系统日历</span>
                  )}
                </div>
              </fieldset>
              </div>
              <div className="booking-summary-divider" />
              <SelectField
                name="calendarTemplateId"
                label="日程模板"
                value={form.calendarTemplateId}
                onChange={(value) => set("calendarTemplateId", value)}
                options={[
                  { value: "", label: "不使用模板" },
                  ...templates
                    .filter((template: any) => template.enabled)
                    .map((template: any) => ({
                      value: template.id,
                      label: `${template.name}${template.isDefault ? "（默认）" : ""}`,
                    })),
                ]}
              />
              {templateUsesDescription && meetingDescriptionField}
              </fieldset>
            </aside>

          </div>
          {narrowScreen && (
            <Button
              type="submit"
              className="booking-mobile-submit"
              disabled={saving}
            >
              {editing ? "保存修改" : "提交预约"}
            </Button>
          )}
        </ValidatedForm>
      </QueryState>
    </div>
  );
}
