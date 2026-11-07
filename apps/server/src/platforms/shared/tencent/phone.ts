import { BadRequestException } from "@nestjs/common";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export function tencentPhone(value?: string | null) {
  if (!value?.trim()) return undefined;
  const compact = value.replace(/[\s().-]/g, "");
  if (!/^(?:\+|00)?\d+$/.test(compact))
    throw new BadRequestException(
      "手机号码格式无效，请填写有效手机号，可包含 +86 等国际区号",
    );
  const parsed = parsePhoneNumberFromString(
    compact.startsWith("00") ? "+" + compact.slice(2) : compact,
    "CN",
  );
  if (
    !parsed?.isPossible() ||
    (parsed.countryCallingCode === "86" &&
      !/^1\d{10}$/.test(parsed.nationalNumber))
  )
    throw new BadRequestException(
      "手机号码格式无效，请填写有效手机号，可包含 +86 等国际区号",
    );
  return {
    area: parsed.countryCallingCode,
    phone: String(parsed.nationalNumber),
  };
}

export function tencentPhoneKey(value: unknown, area?: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const normalized = tencentPhone(
      area && !/^(?:\+|00)/.test(raw)
        ? "+" + String(area).replace(/^\+/, "") + raw
        : raw,
    );
    return normalized ? normalized.area + ":" + normalized.phone : "";
  } catch {
    return "";
  }
}
