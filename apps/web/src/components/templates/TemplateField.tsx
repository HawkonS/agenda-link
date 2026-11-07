import {usePage} from "../../lib/hooks";
import {request} from "../../api";
import { useRef, useState } from "react";
import { useController, useFormContext } from "react-hook-form";
import { Braces, Plus, Search } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { FieldError } from "../ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import {
  calendarFields,
  isProviderPath,
  providerToken,
} from "../../lib/calendar-template";

function VariablePicker({
  label,
  insert,
}: {
  label: string;
  insert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState("common"),
    [search, setSearch] = useState(""),
    [path, setPath] = useState("");
  const inserted = useRef(false);
  const platforms=usePage("platforms",()=>request("/platforms"));
  const providers=(Array.isArray(platforms.data)?platforms.data:[]).filter((p:any)=>p.capability==="meeting");
  const [provider,setProvider]=useState("");
  const selected=providers.find((p:any)=>p.connectionId===provider) || providers[0];
  const providerFields:{key:string;label:string;sample:string}[]=selected?.templateVariables || [];

  const fields = (
    tab === "provider"
      ? providerFields
      : calendarFields.filter((f) => f.key !== "meetingNumber")
  ).filter((f) =>
    `${f.label} ${f.key}`.toLowerCase().includes(search.toLowerCase().trim()),
  );
  function choose(text: string) {
    inserted.current = true;
    setOpen(false);
    insert(text);
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          inserted.current = false;
          setSearch("");
          setTab("common");
          setPath("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="template-variable-trigger"
          aria-label={`插入${label}变量`}
        >
          <Braces />
          插入变量
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="template-variable-picker"
        align="end"
        aria-label={`插入到${label}`}
        onCloseAutoFocus={(e) => {
          if (inserted.current) e.preventDefault();
        }}
      >
        <div className="template-variable-heading">
          <strong>插入到{label}</strong>
          <span>预约时自动替换为实际信息</span>
        </div>
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="template-variable-tabs"
        >
          <TabsList aria-label="变量来源" className="w-full">
            <TabsTrigger value="common">常用信息</TabsTrigger>
            <TabsTrigger value="provider">平台专有</TabsTrigger>
            <TabsTrigger value="custom">自定义字段</TabsTrigger>
          </TabsList>
          <TabsContent value="custom" className="template-variable-custom">
            <label htmlFor={`custom-path-${label}`}>平台返回字段路径</label>
            <Input
              id={`custom-path-${label}`}
              aria-label={`平台返回字段路径（${label}）`}
              value={path}
              maxLength={200}
              placeholder="如 settings.auto_record_type"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (isProviderPath(path)) choose(providerToken(path, selected?.providerId));
                }
              }}
            />
            <p>
              用于添加列表中没有的平台字段。嵌套字段使用点号，例如{" "}
              <code>meeting_info_list.0.meeting_id</code>。
            </p>
            <Button
              type="button"
              className="w-full"
              disabled={!isProviderPath(path)}
              onClick={() => choose(providerToken(path, selected?.providerId))}
            >
              插入字段
            </Button>
          </TabsContent>
          {["common", "provider"].map((source) => (
            <TabsContent
              key={source}
              value={source}
              className="template-variable-panel"
            >
              {source === "provider" && (
                <div className="template-provider-scope">
                  <label>
                    会议平台
                    <select
                      aria-label="变量平台"
                      value={selected?.connectionId || ""}
                      onChange={(event) => setProvider(event.target.value)}
                    >
                      {providers.map((p: any) => (
                        <option key={p.connectionId} value={p.connectionId}>
                          {p.connectionId === "feishu-meeting"
                            ? "飞书会议"
                            : p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span>只影响平台专有字段，通用变量仍在常用信息。</span>
                </div>
              )}
              <div className="template-variable-search">
                <Search aria-hidden="true" />
                <Input
                  aria-label="搜索变量"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索名称或字段，例如会议号"
                />
              </div>
              <div
                className="template-variable-options"
                role="group"
                aria-label="可插入变量"
              >
                {fields.map((f) => (
                  <button
                    type="button"
                    key={f.key}
                    onClick={() =>
                      choose(
                        tab === "provider"
                          ? providerToken(f.key, selected?.providerId)
                          : `【${f.label}】`,
                      )
                    }
                  >
                    <span>
                      <strong>{f.label}</strong>
                      <small>{tab === "provider" ? f.key : f.sample}</small>
                    </span>
                    <Plus aria-hidden="true" />
                  </button>
                ))}
                {!fields.length && (
                  <p className="template-variable-empty">
                    没有匹配的变量，可在“自定义字段”中添加。
                  </p>
                )}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

export function TemplateField({
  name,
  label,
  value,
  onChange,
  multiline = false,
  required = false,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  required?: boolean;
}) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const { control } = useFormContext(),
    { field, fieldState } = useController({ name, control });
  function change(next: string) {
    field.onChange(next);
    onChange(next);
  }
  function insert(text: string) {
    const start = ref.current?.selectionStart ?? value.length,
      end = ref.current?.selectionEnd ?? value.length;
    change(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(start + text.length, start + text.length);
    });
  }
  const props = {
    id: `template-${name}`,
    "aria-label": label,
    value,
    onBlur: field.onBlur,
    "aria-invalid": !!fieldState.error,
    "aria-describedby": fieldState.error ? `template-${name}-error` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      change(e.target.value),
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      ref.current = el;
      field.ref(el);
    },
  };
  return (
    <div className="template-field">
      <div className="template-field-heading">
        <label htmlFor={props.id}>
          {label}
          {required && <span className="ml-1 text-destructive">*</span>}
        </label>
        <VariablePicker label={label} insert={insert} />
      </div>
      {multiline ? (
        <Textarea
          {...props}
          rows={9}
          placeholder="输入日程说明，在需要的位置插入会议号、会议链接等信息。"
        />
      ) : (
        <Input {...props} required={required} />
      )}
      <FieldError id={`template-${name}-error`}>
        {fieldState.error?.message}
      </FieldError>
    </div>
  );
}
