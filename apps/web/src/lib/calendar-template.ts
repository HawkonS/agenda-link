export const calendarFields = [
  { key: "subject", label: "会议主题", sample: "产品周会" },
  {
    key: "description",
    label: "会议说明",
    sample: "回顾本周进展，讨论下周计划。",
  },
  {
    key: "meetingUrl",
    label: "会议链接",
    sample: "https://meeting.example.com/join",
  },
  { key: "meetingCode", label: "会议号", sample: "123 456 789" },
  { key: "meetingNumber", label: "会议号码", sample: "123 456 789" },
  { key: "meetingId", label: "外部会议 ID", sample: "meeting-示例" },
  { key: "hostAccountId", label: "主持账号", sample: "host-user-id" },
  { key: "startAt", label: "开始时间", sample: "10月16日 14:00" },
  { key: "endAt", label: "结束时间", sample: "10月16日 15:00" },
  { key: "platformName", label: "会议平台", sample: "会议平台" },
];

const providerPathPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

export function isProviderPath(value: string) {
  return providerPathPattern.test(value.trim());
}

export function providerToken(path: string, providerId?: string) {
  return `【平台字段：${providerId ? providerId + "/" : ""}${path.trim()}】`;
}

export function readableTemplate(value: string) {
  const readable = calendarFields.reduce(
    (text, field) => text.replaceAll(`{${field.key}}`, `【${field.label}】`),
    value,
  );
  return readable.replace(
    /\{provider\.((?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,199})\}/g,
    (_, path) => providerToken(path),
  );
}
export function storedTemplate(value: string) {
  const stored = calendarFields.reduce(
    (text, field) => text.replaceAll(`【${field.label}】`, `{${field.key}}`),
    value,
  );
  return stored.replace(
    /【平台字段：((?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,199})】/g,
    (_, path) => `{provider.${path}}`,
  );
}
export function previewTemplate(value: string, platformName?: string,providerFields:{key:string;sample:string}[]=[]) {
  const preview = calendarFields.reduce(
    (text, field) =>
      text.replaceAll(
        `【${field.label}】`,
        field.key === "platformName" && platformName
          ? platformName
          : field.sample,
      ),
    readableTemplate(value),
  );
  return preview.replace(
    /【平台字段：((?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,199})】/g,
    (_, token) => {
      const path = token.includes("/") ? token.split("/").slice(1).join("/") : token;
      return (
        providerFields.find((field) => field.key === path)?.sample ||
        `平台字段：${path}`
      );
    },
  );
}
export const calendarPresets = [
  {
    name: "标准会议",
    hint: "主题、说明和会议入口",
    title: "【会议主题】",
    description:
      "【会议说明】\n\n会议号：【会议号】\n加入会议：\n【会议链接】",
    location: "线上会议",
    reminders: [10],
  },
  {
    name: "团队周会",
    hint: "突出团队节奏与准备事项",
    title: "[周会] 【会议主题】",
    description:
      "请提前准备本周进展及待讨论事项。\n\n【会议说明】\n\n会议号：【会议号】\n加入会议：\n【会议链接】",
    location: "线上会议",
    reminders: [10, 30],
  },
  {
    name: "客户沟通",
    hint: "正式邀请与清晰的入会提示",
    title: "[会议邀请] 【会议主题】",
    description:
      "您好，邀请您参加以下会议。\n\n【会议说明】\n\n会议时间：【开始时间】 至 【结束时间】\n会议号：【会议号】\n会议入口：【会议链接】",
    location: "线上会议",
    reminders: [30],
  },
];
