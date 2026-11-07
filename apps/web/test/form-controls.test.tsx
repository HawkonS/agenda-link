import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { z } from "zod";
import { ValidatedForm } from "../src/components/common/ValidatedForm";
import {
  SelectField,
  TextField,
  Modal,
  MultiPicker,
} from "../src/components/common/workspace";
import { DateTimePicker } from "../src/components/common/DateTimePicker";
import { parseLocalDateTime, localDateTimeValue } from "../src/lib/date-time";
import {
  meetingSchema,
  settingsSchema,
  settingsFormValues,
} from "../src/lib/form-schemas";
import { extraObject } from "../src/components/common/ScheduleFields";

describe("shared accessible form controls", () => {
  it("filters people by initials without losing selections and resets search on completion", async () => {
    function Editor() {
      const [selected, setSelected] = useState<number[]>([]);
      return (
        <MultiPicker
          label="内部参会人"
          selected={selected}
          onChange={setSelected}
          options={[
            { id: 1, label: "李小明" },
            { id: 2, label: "张三" },
            { id: 3, label: "李晓梅（尚未同步腾讯身份）", disabled: true },
          ]}
        />
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    const search = screen.getByRole("textbox", {
      name: "搜索姓名、拼音或首字母",
    });
    await user.type(search, "LXM");
    expect(screen.queryByRole("checkbox", { name: "张三" })).toBeNull();
    expect(
      (screen.getByRole("checkbox", { name: /李晓梅/ }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "李小明" }));
    await user.clear(search);
    await user.type(search, "zhangsan");
    expect(screen.getByRole("checkbox", { name: "张三" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "移除李小明" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "完成" }));
    await user.click(screen.getByRole("button", { name: "选择内部参会人" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "搜索姓名、拼音或首字母",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      (screen.getByRole("checkbox", { name: "李小明" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByRole("checkbox", { name: "张三" })).not.toBeNull();
  });
  it("keeps empty options selectable and disabled options unavailable", async () => {
    function Editor() {
      const [value, setValue] = useState("");
      return (
        <SelectField
          label="账号池"
          value={value}
          onChange={setValue}
          options={[
            { value: "", label: "自动分配" },
            { value: "1", label: "团队池" },
            { value: "2", label: "已停用", disabled: true },
          ]}
        />
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "账号池" }));
    expect(
      screen
        .getByRole("option", { name: "已停用" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await user.click(screen.getByRole("option", { name: "团队池" }));
    expect(screen.getByRole("combobox").textContent).toBe("团队池");
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "自动分配" }));
    expect(screen.getByRole("combobox").textContent).toBe("自动分配");
  });
  it("opens collapsed invalid sections and focuses the control before allowing submission", async () => {
    const saved = vi.fn();
    function Editor() {
      const [values, setValues] = useState({ name: "" });
      return (
        <ValidatedForm
          values={values}
          schema={z.object({ name: z.string().min(1, "请填写名称") })}
          onSubmit={saved}
        >
          <details>
            <summary>更多信息</summary>
            <TextField
              name="name"
              label="名称"
              value={values.name}
              onChange={(name) => setValues({ name })}
            />
          </details>
          <button>保存</button>
        </ValidatedForm>
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toBe("请填写名称");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("名称")),
    );
    expect(document.querySelector("details")?.open).toBe(true);
    expect(saved).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("名称"), "项目周会");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });
  it("does not shift the date button with blur errors before the first submit", async () => {
    function Editor() {
      const [values, setValues] = useState({ subject: "", startAt: "" });
      return (
        <Modal open onClose={() => {}} title="日程">
          <ValidatedForm
            values={values}
            schema={z.object({
              subject: z.string().min(1, "请填写主题"),
              startAt: z.string(),
            })}
            onSubmit={() => {}}
          >
            <TextField
              name="subject"
              label="主题"
              value={values.subject}
              onChange={(subject) => setValues((v) => ({ ...v, subject }))}
            />
            <TextField
              name="startAt"
              type="datetime-local"
              label="开始时间"
              value={values.startAt}
              onChange={(startAt) => setValues((v) => ({ ...v, startAt }))}
            />
          </ValidatedForm>
        </Modal>
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "选择开始时间" }));
    expect(await screen.findByRole("button", { name: "完成" })).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("supports the date popover and a nested time select inside a dialog", async () => {
    function Editor() {
      const [value, setValue] = useState("2030-10-15T09:30");
      return (
        <Modal open onClose={() => {}} title="预约">
          <DateTimePicker label="开始时间" value={value} onChange={setValue} />
        </Modal>
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "选择开始时间" }));
    await user.click(screen.getByRole("button", { name: /2030年10月16日/ }));
    await user.click(screen.getByRole("combobox", { name: "开始时间小时" }));
    await user.click(screen.getByRole("option", { name: "14" }));
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(
      (
        within(screen.getByRole("dialog", { name: "预约" })).getByLabelText(
          "开始时间",
        ) as HTMLInputElement
      ).value,
    ).toBe("2030-10-16 14:30");
  });
  it("opens the date popover from the input area, not only the calendar icon", async () => {
    render(
      <DateTimePicker
        label="结束时间"
        value="2030-10-15T09:30"
        onChange={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("结束时间"));
    expect(await screen.findByRole("button", { name: "完成" })).not.toBeNull();
  });
  it.each(["input", "icon"])(
    "confirms the current local time from an empty %s picker",
    async (entry) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(2030, 9, 15, 14, 37, 20));
        function Editor() {
          const [value, setValue] = useState("");
          return (
            <DateTimePicker
              label="开始时间"
              value={value}
              onChange={setValue}
            />
          );
        }
        render(<Editor />);
        const user = userEvent.setup();
        await user.click(
          entry === "input"
            ? screen.getByLabelText("开始时间")
            : screen.getByRole("button", { name: "选择开始时间" }),
        );
        expect(
          screen.getByRole("combobox", { name: "开始时间小时" }).textContent,
        ).toBe("14");
        expect(
          screen.getByRole("combobox", { name: "开始时间分钟" }).textContent,
        ).toBe("37");
        expect(
          (screen.getByLabelText("开始时间") as HTMLInputElement).value,
        ).toBe("");
        await user.click(screen.getByRole("button", { name: "完成" }));
        expect(
          (screen.getByLabelText("开始时间") as HTMLInputElement).value,
        ).toBe("2030-10-15 14:37");
        expect(screen.queryByRole("button", { name: "完成" })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("refreshes the current-time default on reopening without filling a dismissed empty picker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2030, 9, 15, 14, 37));
      function Editor() {
        const [value, setValue] = useState("");
        return (
          <>
            <DateTimePicker
              label="结束时间"
              value={value}
              onChange={setValue}
            />
            <button>其他操作</button>
          </>
        );
      }
      render(<Editor />);
      const user = userEvent.setup();
      await user.click(screen.getByLabelText("结束时间"));
      await user.click(screen.getByRole("button", { name: "其他操作" }));
      expect(
        (screen.getByLabelText("结束时间") as HTMLInputElement).value,
      ).toBe("");
      vi.setSystemTime(new Date(2030, 9, 16, 0, 2));
      await user.click(screen.getByLabelText("结束时间"));
      await user.click(screen.getByRole("button", { name: "完成" }));
      expect(
        (screen.getByLabelText("结束时间") as HTMLInputElement).value,
      ).toBe("2030-10-16 00:02");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("date and payload validation", () => {
  const meeting = {
    subject: "产品周会",
    startAt: "2030-10-15T10:00",
    endAt: "2030-10-15T11:00",
    reminders: [10],
    extensions: [],
    attendeeEmails: "",
    recordingEnabled: true,
    recordingTtlDays: 30,
  };
  it("rejects nonexistent calendar dates and invalid hours", () => {
    expect(parseLocalDateTime("2024-02-29T12:34")).toBeInstanceOf(Date);
    for (const value of [
      "2025-02-29T12:34",
      "2030-04-31T12:34",
      "2030-10-15T24:00",
      "2030-10-15T12:60",
      "2030-10-15T12:30:99",
    ])
      expect(parseLocalDateTime(value)).toBeUndefined();
  });
  it("preserves local wall time and converts to the matching UTC instant", () => {
    const date = parseLocalDateTime("2030-10-15T10:30")!;
    expect(date.getHours()).toBe(10);
    expect(date.getMinutes()).toBe(30);
    expect(localDateTimeValue(date)).toBe("2030-10-15T10:30");
    expect(date.toISOString()).toBe(
      new Date(2030, 9, 15, 10, 30).toISOString(),
    );
  });
  it("blocks bad ranges, emails, recording limits and duplicate extension names", () => {
    expect(meetingSchema.safeParse(meeting).success).toBe(true);
    for (const patch of [
      { endAt: meeting.startAt },
      { attendeeEmails: "invalid" },
      { recordingTtlDays: 366 },
      {
        extensions: [
          { key: "项目", value: "A" },
          { key: "项目", value: "B" },
        ],
      },
    ])
      expect(meetingSchema.safeParse({ ...meeting, ...patch }).success).toBe(
        false,
      );
    expect(
      meetingSchema.safeParse({
        ...meeting,
        recordingEnabled: false,
        recordingTtlDays: 0,
      }).success,
    ).toBe(true);
    expect(extraObject([{ key: "项目", value: "客户协作" }])).toEqual({
      项目: "客户协作",
    });
  });
  it("validates flat properties without treating their dots as object paths", () => {
    const properties = {
      "platform.name": "会议工具",
      "platform.primary-color": "#1677ff",
      "app.port": "18480",
      "web.port": "15173",
      "recording.ttl-days": "30",
      "sync.interval-minutes": "0",
    };
    expect(
      settingsSchema.safeParse(settingsFormValues(properties)).success,
    ).toBe(true);
    const invalid = settingsSchema.safeParse(
      settingsFormValues({ ...properties, "app.port": "65536" }),
    );
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues[0]?.path).toEqual(["app__port"]);
  });
});
