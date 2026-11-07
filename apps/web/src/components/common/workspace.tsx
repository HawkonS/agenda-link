import {
  useEffect,
  useId,
  useState,
  type ReactNode,
  type InputHTMLAttributes,
  type Ref,
  type CSSProperties,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Loader2,
  Search,
  X,
  Users,
} from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import { OptionSelect, type SelectOption } from "./OptionSelect";
import { DateTimePicker } from "./DateTimePicker";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import {
  Field as FormField,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "../ui/field";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { cn, statusText } from "../../lib/utils";
import { matchesPeopleSearch } from "../../lib/people-search";
export function SelectionControl({
  count,
  total,
  unit,
  checked,
  indeterminate = false,
  disabled = false,
  ariaLabel,
  onChange,
}: {
  count: number;
  total: number;
  unit: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div
      className="selection-control"
      style={
        {
          "--selection-number-width": `${Math.max(3, String(total).length)}ch`,
        } as CSSProperties
      }
    >
      <label className="selection-control-label">
        <input
          type="checkbox"
          className="workspace-checkbox"
          aria-label={ariaLabel}
          checked={checked}
          disabled={disabled}
          ref={(element) => {
            if (element) element.indeterminate = indeterminate;
          }}
          onChange={(event) => onChange(event.target.checked)}
        />
        全选
      </label>
      <span
        className="selection-control-count"
        aria-live="polite"
        aria-atomic="true"
      >
        <span>已选</span>
        <strong>{count}</strong>
        <span>{unit}</span>
      </span>
    </div>
  );
}
export function PageHeader({
  title,
  actions,
  count,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  count?: number;
}) {
  const heading = (
    <h1 className="sr-only">
      {title}
      {count !== undefined ? `（${count}）` : ""}
    </h1>
  );
  if (!actions) return heading;
  return (
    <header className="page-header page-header--compact">
      {heading}
      <div className="page-header-actions">{actions}</div>
    </header>
  );
}
export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface overflow-hidden", className)}>
      {title && (
        <div className="panel-heading">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {description && (
              <p className="text-[13px] leading-5 text-muted-foreground mt-1">
                {description}
              </p>
            )}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({
  title = "暂无数据",
  hint = "创建第一条记录后，会在这里显示。",
  action,
  className,
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-56 flex-col items-center justify-center px-5 py-10 text-center",
        className,
      )}
    >
      <div className="empty-orbit mb-4">
        <Inbox className="h-6 w-6" />
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      {hint && (
        <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
export function Loading() {
  return (
    <div
      role="status"
      className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      加载中…
    </div>
  );
}
export function ErrorBanner({
  message = "数据加载失败，请检查网络后重试。",
  retry,
}: {
  message?: string;
  retry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <span className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {message}
      </span>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          重试
        </Button>
      )}
    </div>
  );
}
export function QueryState({
  loading,
  error,
  retry,
  children,
}: {
  loading: boolean;
  error: boolean;
  retry: () => void;
  children: ReactNode;
}) {
  return loading ? (
    <Loading />
  ) : error ? (
    <ErrorBanner retry={retry} />
  ) : (
    <>{children}</>
  );
}
export function Status({ value, label }: { value: string; label?: string }) {
  const inProgress = [
    "provisioning",
    "pending",
    "processing",
    "running",
    "queued",
    "cancelling",
    "deleting",
  ].includes(value);
  const tone = [
    "ready",
    "scheduled",
    "synced",
    "success",
    "applied",
    "available",
    "active",
  ].includes(value)
    ? "bg-emerald-50 text-emerald-700 border-emerald-100"
    : ["failed", "cancel_failed", "delete_failed", "error"].includes(value)
      ? "bg-red-50 text-red-700 border-red-100"
      : inProgress
        ? "bg-blue-50 text-blue-700 border-blue-100"
        : [
              "unknown",
              "cohost_pending",
              "waiting_meeting",
              "waiting_join",
            ].includes(value)
          ? "bg-amber-50 text-amber-800 border-amber-200"
          : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap",
        tone,
      )}
    >
      {inProgress ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      ) : (
        <i className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {label || statusText[value] || value}
    </span>
  );
}
export type Column<T> = {
  key: string;
  title: string;
  render: (row: T) => ReactNode;
  /** Custom header, optionally using the current page and filtered rows. */
  header?:
    | ReactNode
    | ((pageRows: T[], filteredRows: T[]) => ReactNode);
  className?: string;
  /** Preferred width keeps the table geometry stable while paging or switching tabs. */
  width?: number;
};
const columnWidths: Record<string, number> = {
  select: 72,
  id: 100,
  name: 240,
  subject: 280,
  title: 280,
  contact: 240,
  department: 240,
  role: 136,
  feishu: 128,
  status: 144,
  state: 136,
  type: 160,
  enabled: 112,
  time: 192,
  start: 192,
  end: 192,
  expiry: 192,
  error: 300,
  detail: 320,
  result: 260,
  actions: 224,
  files: 200,
  link: 160,
  download: 144,
};
export function TableSelectionHeader({
  pageIds,
  allIds,
  selectedIds,
  onChange,
}: {
  pageIds: (string | number)[];
  allIds: (string | number)[];
  selectedIds: Set<string | number>;
  onChange: (next: Set<string | number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const pageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const pagePartial =
    pageIds.some((id) => selectedIds.has(id)) && !pageSelected;
  const add = (ids: (string | number)[]) => {
    onChange(new Set([...selectedIds, ...ids]));
    setOpen(false);
  };
  return (
    <div className="table-select-header">
      <span className="sr-only">选择</span>
      <input
        type="checkbox"
        className="workspace-checkbox"
        aria-label="选择当前页"
        checked={pageSelected}
        disabled={!pageIds.length}
        ref={(element) => {
          if (element) element.indeterminate = pagePartial;
        }}
        onChange={(event) =>
          event.target.checked
            ? add(pageIds)
            : onChange(
                new Set([...selectedIds].filter((id) => !pageIds.includes(id))),
              )
        }
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="table-select-trigger"
            aria-label="选择操作"
          >
            <ChevronDown />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="table-select-menu">
          <button type="button" onClick={() => add(pageIds)}>
            <Check />
            全选本页
          </button>
          <button type="button" onClick={() => add(allIds)}>
            <Check />
            选择筛选结果（{allIds.length}）
          </button>
          <button
            type="button"
            onClick={() => {
              onChange(new Set());
              setOpen(false);
            }}
          >
            <X />
            取消选择
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
export function DataTable<T extends { id?: number | string }>({
  rows,
  columns,
  pageSize: initialPageSize = 10,
  pagination = true,
  emptyTitle,
  emptyHint,
  emptyAction,
  emptyClassName,
  getRowKey,
}: {
  rows: T[];
  columns: Column<T>[];
  pageSize?: number;
  pagination?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  emptyAction?: ReactNode;
  emptyClassName?: string;
  getRowKey?: (row: T) => string | number;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  useEffect(() => setPage(1), [rows.length]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = pagination
    ? rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : rows;
  // Geometry depends on the column schema, never on the current page's content.
  const widths = columns.map(
    (column) => column.width ?? columnWidths[column.key] ?? 160,
  );
  return rows.length === 0 ? (
    <Empty
      title={emptyTitle}
      hint={emptyHint}
      action={emptyAction}
      className={emptyClassName}
    />
  ) : (
    <div className="table-wrap">
      <div className="table-touch-hint" aria-hidden="true">
        左右滑动查看完整表格 ↔
      </div>
      <div className="table-scroll">
        <table
          className="data-table data-table--fixed"
          style={
            {
              "--table-min-width": `${widths.reduce((total, width) => total + width, 0)}px`,
            } as CSSProperties
          }
        >
          <colgroup>
            {columns.map((column, index) => (
              <col
                key={column.key}
                data-column={column.key}
                style={
                  { "--column-width": `${widths[index]}px` } as CSSProperties
                }
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} data-column={c.key} className={c.className}>
                  {typeof c.header === "function"
                    ? c.header(pageRows, rows)
                    : (c.header ?? c.title)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr key={getRowKey ? getRowKey(r) : r.id || i}>
                {columns.map((c) => (
                  <td key={c.key} data-column={c.key} className={c.className}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pagination && rows.length > 0 && (
        <div className="table-pagination">
          <span>共 {rows.length} 条</span>
          <div className="pagination-size">
            <span>每页</span>
            <OptionSelect
              label="每页条数"
              value={pageSize}
              onChange={(value) => {
                setPageSize(Number(value));
                setPage(1);
              }}
              options={[...new Set([10, 20, 50, initialPageSize])]
                .sort((a, b) => a - b)
                .map((size) => ({ value: size, label: `${size} 条` }))}
            />
          </div>
          <span>
            第 {currentPage} / {pageCount} 页
          </span>
          <Button
            variant="outline"
            size="icon"
            aria-label="上一页"
            disabled={currentPage <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="下一页"
            disabled={currentPage >= pageCount}
            onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
  className,
  bodyClassName,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "workspace-modal max-h-[90dvh] flex flex-col gap-0 overflow-hidden rounded-2xl p-0",
          wide && "max-w-2xl",
          className,
        )}
      >
        <DialogHeader className="modal-heading">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : "sr-only"}>
            {description || title}
          </DialogDescription>
        </DialogHeader>
        <div className={cn("modal-body", bodyClassName)}>{children}</div>
        {footer}
      </DialogContent>
    </Dialog>
  );
}
export function FormActions({
  saving,
  onCancel,
  label = "保存",
  cancelLabel = "取消",
}: {
  saving: boolean;
  onCancel?: () => void;
  label?: string;
  cancelLabel?: string;
}) {
  return (
    <div className="form-actions flex justify-end gap-2 border-t pt-4 mt-5">
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
      )}
      <Button type="submit" disabled={saving}>
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}
      </Button>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div id={id} className="text-sm font-medium text-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </div>
      {children}
      {hint && (
        <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
type TextFieldProps = {
  label: string;
  value?: string;
  onChange?: (v: string) => void;
  textarea?: boolean;
  hint?: string;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "onBlur"
> & { onBlur?: () => void };
function TextControl({
  label,
  value,
  onChange,
  textarea,
  hint,
  error,
  inputRef,
  ...props
}: TextFieldProps & { error?: string; inputRef?: Ref<any> }) {
  const generatedId = useId(),
    id = props.id || generatedId;
  const describedBy =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
    undefined;
  const common = {
    id,
    name: props.name,
    "aria-label": label,
    "aria-invalid": !!error,
    "aria-describedby": describedBy,
    value: value || "",
    disabled: props.disabled,
    required: props.required,
    onBlur: props.onBlur,
  };
  return (
    <FormField data-invalid={!!error}>
      <FieldLabel htmlFor={id}>
        {label}
        {props.required && <span className="field-required">*</span>}
      </FieldLabel>
      {textarea ? (
        <Textarea
          {...common}
          ref={inputRef}
          onChange={(e) => onChange?.(e.target.value)}
          rows={3}
          placeholder={props.placeholder}
          maxLength={props.maxLength}
        />
      ) : props.type === "datetime-local" ? (
        <DateTimePicker
          {...props}
          {...common}
          ref={inputRef}
          label={label}
          onChange={(v) => onChange?.(v)}
        />
      ) : (
        <Input
          {...props}
          {...common}
          ref={inputRef}
          onChange={(e) => onChange?.(e.target.value)}
        />
      )}
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </FormField>
  );
}
export function TextField(props: TextFieldProps) {
  const form = useFormContext();
  if (!form || !props.name) return <TextControl {...props} />;
  return (
    <Controller
      name={props.name}
      control={form.control}
      render={({ field, fieldState }) => (
        <TextControl
          {...props}
          inputRef={field.ref}
          error={fieldState.error?.message}
          onBlur={field.onBlur}
          onChange={(value) => {
            field.onChange(value);
            props.onChange?.(value);
          }}
        />
      )}
    />
  );
}
type SelectFieldProps = {
  label: string;
  name?: string;
  value: string | number;
  onChange: (v: string) => void;
  options: SelectOption[];
  hint?: string;
  disabled?: boolean;
};
function SelectControl({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
  error,
  inputRef,
  onBlur,
}: SelectFieldProps & {
  error?: string;
  inputRef?: Ref<HTMLButtonElement>;
  onBlur?: () => void;
}) {
  const id = useId();
  return (
    <FormField data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <OptionSelect
        ref={inputRef}
        id={id}
        label={label}
        value={value}
        onChange={onChange}
        options={options}
        disabled={disabled}
        onBlur={onBlur}
        aria-invalid={!!error}
        aria-describedby={
          [hint && `${id}-hint`, error && `${id}-error`]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </FormField>
  );
}
export function SelectField(props: SelectFieldProps) {
  const form = useFormContext();
  if (!form || !props.name) return <SelectControl {...props} />;
  return (
    <Controller
      name={props.name}
      control={form.control}
      render={({ field, fieldState }) => (
        <SelectControl
          {...props}
          inputRef={field.ref}
          onBlur={field.onBlur}
          error={fieldState.error?.message}
          onChange={(value) => {
            field.onChange(value);
            props.onChange(value);
          }}
        />
      )}
    />
  );
}
export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
        )}
      </div>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "搜索…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative min-w-0">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        aria-label={placeholder}
        placeholder={placeholder}
        className="pl-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
export function MultiPicker({
  label,
  selected,
  onChange,
  options,
  unit = "项",
}: {
  label: string;
  selected: number[];
  onChange: (v: number[]) => void;
  options: { id: number; label: string; disabled?: boolean }[];
  unit?: string;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const id = useId();
  const visible = options.filter((o) => matchesPeopleSearch(o.label, search));
  function changeOpen(value: boolean) {
    setOpen(value);
    if (!value) setSearch("");
  }
  return (
    <FormField>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <div
            id={id}
            role="button"
            tabIndex={0}
            className="picker-trigger"
            aria-label={`选择${label}`}
            aria-expanded={open}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                changeOpen(!open);
              }
            }}
          >
            <Users className="size-4 shrink-0" />
            <span className="picker-trigger-content">
              {selected.length ? (
                selected.map((value) => {
                  const text =
                    options.find((option) => option.id === value)?.label ||
                    String(value);
                  return (
                    <span key={value} className="picker-inline-chip">
                      <span>{text}</span>
                      <button
                        type="button"
                        aria-label={`移除${text}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onChange(selected.filter((x) => x !== value));
                        }}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })
              ) : (
                <span className="picker-trigger-placeholder">
                  搜索并选择{label}
                </span>
              )}
            </span>
            <ChevronDown className="size-4 shrink-0" />
          </div>
        </PopoverTrigger>
        <PopoverContent className="people-picker" aria-label={label}>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="搜索姓名、拼音或首字母"
          />
          <div className="picker-options">
            {visible.map((o) => (
              <label
                key={o.id}
                className={cn(
                  "picker-option",
                  o.disabled && "picker-option--disabled",
                )}
              >
                <input
                  type="checkbox"
                  className="workspace-checkbox"
                  disabled={o.disabled}
                  checked={selected.includes(o.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...selected, o.id]
                        : selected.filter((x) => x !== o.id),
                    )
                  }
                />
                <span>{o.label}</span>
              </label>
            ))}
            {!visible.length && (
              <p className="picker-empty">
                {options.length
                  ? "未找到匹配的人员"
                  : "暂无可选人员，请先同步通讯录"}
              </p>
            )}
          </div>
          <div className="picker-footer">
            <span>
              已选 {selected.length} {unit}
            </span>
            <Button type="button" size="sm" onClick={() => changeOpen(false)}>
              完成
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </FormField>
  );
}
export function Confirm({
  title,
  description,
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  onConfirm: () => Promise<unknown>;
  children: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  return (
    <>
      {children(() => setOpen(true))}
      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={title}
        className="confirm-modal"
        bodyClassName="confirm-modal-body"
        footer={
          <div className="confirm-dialog-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const ok = await onConfirm();
                  if (ok !== false) setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}确认
            </Button>
          </div>
        }
      >
        <div className="confirm-dialog">
          <span className="confirm-dialog-icon" aria-hidden="true">
            <AlertTriangle />
          </span>
          <p>{description}</p>
        </div>
      </Modal>
    </>
  );
}
