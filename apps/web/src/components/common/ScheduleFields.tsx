import { useId, useState } from "react";
import { useController, useFormContext } from "react-hook-form";
import { Bell, Plus, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, FieldLabel, FieldDescription, FieldError } from "../ui/field";
import { TextField } from "./workspace";
export type ExtraRow = { key: string; value: string };
export const extraRows = (object: Record<string, string>) =>
  Object.entries(object).map(([key, value]) => ({ key, value }));
export const extraObject = (rows: ExtraRow[]) =>
  Object.fromEntries(rows.map((row) => [row.key.trim(), row.value]));
const reminderLabel = (n: number) =>
  n === 0
    ? "开始时"
    : n === 1440
      ? "提前 1 天"
      : n >= 60 && n % 60 === 0
        ? `提前 ${n / 60} 小时`
        : `提前 ${n} 分钟`;
export function RemindersField({
  value,
  onChange,
  name = "reminders",
}: {
  value: number[];
  onChange: (value: number[]) => void;
  name?: string;
}) {
  const { control } = useFormContext(),
    { field, fieldState } = useController({ name, control });
  const [custom, setCustom] = useState(""),
    [error, setError] = useState("");
  const id = useId();
  const change = (next: number[]) => {
    field.onChange(next);
    onChange(next);
  };
  function add() {
    const n = Number(custom);
    if (!/^\d+$/.test(custom) || !Number.isInteger(n) || n < 0 || n > 10080) {
      setError("请输入 0–10080 的整数分钟");
      return;
    }
    if (value.length >= 5 && !value.includes(n)) {
      setError("最多设置 5 个提醒");
      return;
    }
    change([...new Set([...value, n])].sort((a, b) => a - b));
    setCustom("");
    setError("");
  }
  return (
    <Field>
      <FieldLabel>
        <Bell className="inline size-3.5 mr-1.5" />
        提醒时间
      </FieldLabel>
      <div
        className="reminder-options"
        ref={field.ref}
        tabIndex={-1}
        aria-invalid={!!fieldState.error}
        aria-describedby={fieldState.error ? `${id}-error` : undefined}
      >
        {[...new Set([0, 10, 30, 60, 1440, ...value])]
          .sort((a, b) => a - b)
          .map((n) => (
            <label key={n}>
              <input
                type="checkbox"
                className="workspace-checkbox"
                checked={value.includes(n)}
                disabled={value.length >= 5 && !value.includes(n)}
                onChange={(e) =>
                  change(
                    e.target.checked
                      ? [...value, n].sort((a, b) => a - b)
                      : value.filter((v) => v !== n),
                  )
                }
                onBlur={field.onBlur}
              />
              {reminderLabel(n)}
            </label>
          ))}
      </div>
      <div className="reminder-custom">
        <Input
          aria-label="自定义提醒分钟"
          type="number"
          min={0}
          max={10080}
          value={custom}
          placeholder="自定义分钟"
          onChange={(e) => {
            setCustom(e.target.value);
            setError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>
          添加提醒
        </Button>
      </div>
      <FieldDescription>最多 5 个；不选择则不提醒。</FieldDescription>
      <FieldError id={`${id}-error`}>
        {error || fieldState.error?.message}
      </FieldError>
    </Field>
  );
}
export function ExtensionFields({
  value,
  onChange,
  name = "extensions",
}: {
  value: ExtraRow[];
  onChange: (value: ExtraRow[]) => void;
  name?: string;
}) {
  return (
    <Field>
      <FieldLabel>补充信息</FieldLabel>
      <FieldDescription>
        按名称和内容填写，会展示在飞书日程说明中。
      </FieldDescription>
      <div className="extension-rows">
        {value.map((row, index) => (
          <div className="extension-row" key={index}>
            <TextField
              name={`${name}.${index}.key`}
              label={`补充信息名称 ${index + 1}`}
              value={row.key}
              onChange={(key) =>
                onChange(value.map((r, i) => (i === index ? { ...r, key } : r)))
              }
              placeholder="例如：项目"
              required
            />
            <TextField
              name={`${name}.${index}.value`}
              label={`补充信息内容 ${index + 1}`}
              value={row.value}
              onChange={(content) =>
                onChange(
                  value.map((r, i) =>
                    i === index ? { ...r, value: content } : r,
                  ),
                )
              }
              placeholder="例如：客户协作"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`删除补充信息 ${index + 1}`}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...value, { key: "", value: "" }])}
      >
        <Plus />
        添加补充信息
      </Button>
    </Field>
  );
}
