import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
export function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues
        .map((x) => x.path.join(".") + ": " + x.message)
        .join("; "),
    );
  return result.data;
}
export const idSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const roles = z.enum(["system_admin", "operation_admin", "user"]);
export const text = z.string().trim().min(1).max(500);
export const email = z.string().email().max(254).or(z.literal(""));
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
export const dates = z
  .object({ startAt: timestamp, endAt: timestamp })
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), {
    message: "结束时间必须晚于开始时间",
  });
export const eventSchema = z
  .object({
    subject: text,
    description: z.string().max(10000).optional(),
    startAt: timestamp,
    endAt: timestamp,
    location: z.string().max(500).optional(),
    reminders: z.array(z.number().int().min(0).max(10080)).max(5).optional(),
    extensions: z
      .record(z.string().max(100), z.string().max(2000))
      .refine((v) => Object.keys(v).length <= 50, "扩展字段最多 50 项")
      .optional(),
  })
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), {
    message: "结束时间必须晚于开始时间",
  });
