import { forwardRef } from "react";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../ui/select";
export type SelectOption = {
  value: string | number;
  label: string;
  disabled?: boolean;
};
export const OptionSelect = forwardRef<
  HTMLButtonElement,
  {
    value: string | number;
    onChange: (value: string) => void;
    options: SelectOption[];
    label: string;
    id?: string;
    className?: string;
    disabled?: boolean;
    onBlur?: () => void;
    "aria-invalid"?: boolean;
    "aria-describedby"?: string;
  }
>(
  (
    {
      value,
      onChange,
      options,
      label,
      className,
      id,
      disabled,
      onBlur,
      ...aria
    },
    ref,
  ) => (
    <Select
      value={`v:${value}`}
      onValueChange={(v) => onChange(v.slice(2))}
      disabled={disabled}
    >
      <SelectTrigger
        ref={ref}
        id={id}
        aria-label={label}
        className={className}
        onBlur={onBlur}
        {...aria}
      >
        <SelectValue placeholder="请选择" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={`v:${option.value}`}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ),
);
OptionSelect.displayName = "OptionSelect";
