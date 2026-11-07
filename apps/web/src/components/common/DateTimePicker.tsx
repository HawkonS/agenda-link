import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { OptionSelect } from "./OptionSelect";
import { localDateTimeValue, parseLocalDateTime } from "../../lib/date-time";
type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
> & { value: string; onChange: (value: string) => void; label: string };
const pad = (value: number) => String(value).padStart(2, "0");
export const DateTimePicker = forwardRef<HTMLInputElement, Props>(
  ({ value, onChange, label, disabled, className, ...props }, ref) => {
    const [open, setOpen] = useState(false);
    const [defaultDate, setDefaultDate] = useState(() => new Date());
    const date = parseLocalDateTime(value) || defaultDate;
    const hour = date.getHours();
    const minute = date.getMinutes();
    function changeOpen(next: boolean) {
      if (next && !open) setDefaultDate(new Date());
      setOpen(next);
    }
    function selectDay(day: Date | undefined) {
      if (!day) return;
      onChange(
        localDateTimeValue(
          new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            hour,
            minute,
          ),
        ),
      );
    }
    function selectTime(hours: number, minutes: number) {
      const day = date;
      onChange(
        localDateTimeValue(
          new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            hours,
            minutes,
          ),
        ),
      );
    }
    return (
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverAnchor asChild>
          <div className="date-time-input">
            <Input
              {...props}
              ref={ref}
              type="text"
              className={className}
              aria-label={label}
              disabled={disabled}
              value={value.replace("T", " ")}
              onChange={(e) => onChange(e.target.value.replace(" ", "T"))}
              onClick={() => {
                if (!disabled) changeOpen(true);
              }}
              onKeyDown={(event) => {
                if (
                  !disabled &&
                  (event.key === "Enter" || event.key === "ArrowDown")
                ) {
                  event.preventDefault();
                  changeOpen(true);
                }
              }}
              placeholder="年-月-日 时:分"
              inputMode="text"
            />
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={`选择${label}`}
              >
                <CalendarDays />
              </Button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent
          className="date-time-popover"
          align="start"
          aria-label={`选择${label}`}
        >
          <DayPicker
            mode="single"
            locale={zhCN}
            weekStartsOn={1}
            selected={date}
            defaultMonth={date}
            onSelect={selectDay}
            showOutsideDays
            className="date-calendar"
            components={{
              Chevron: ({ orientation }) =>
                orientation === "left" ? (
                  <ChevronLeft className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                ),
            }}
          />
          <div className="date-time-clock">
            <span>时间</span>
            <OptionSelect
              label={`${label}小时`}
              value={pad(hour)}
              onChange={(v) => selectTime(Number(v), minute)}
              options={Array.from({ length: 24 }, (_, i) => ({
                value: pad(i),
                label: pad(i),
              }))}
            />
            <span>:</span>
            <OptionSelect
              label={`${label}分钟`}
              value={pad(minute)}
              onChange={(v) => selectTime(hour, Number(v))}
              options={Array.from({ length: 60 }, (_, i) => ({
                value: pad(i),
                label: pad(i),
              }))}
            />
          </div>
          <div className="date-time-footer">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(localDateTimeValue(new Date()))}
            >
              现在
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onChange(localDateTimeValue(date));
                setOpen(false);
              }}
            >
              完成
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
DateTimePicker.displayName = "DateTimePicker";
