import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  ForbiddenException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "./auth.service.js";
import { ConfigurationService } from "./config/configuration.service.js";
import { DatabaseService } from "./database.service.js";
import { nextDate, resolveTimeZone, zonedDayStart } from "./timezone.js";
import { idSchema, parse } from "./validation.js";

const kinds = z.enum(["audit", "sync", "jobs"]);
const scopes = z.enum(["organization", "users"]);
const tables = {
  audit: "audit_logs",
  sync: "sync_runs",
  jobs: "jobs",
} as const;
const managers = ["system_admin", "operation_admin"] as const;
type Kind = z.infer<typeof kinds>;
export function recordDateRange(
  query: Record<string, string>,
  timeZone = resolveTimeZone(),
) {
  const zone = resolveTimeZone(timeZone);
  const result: { from?: string; to?: string } = {};
  for (const key of ["from", "to"] as const)
    if (query[key]) {
      const value = query[key]!;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        (Number.isFinite(Date.parse(value + "T00:00:00Z"))
          ? new Date(value + "T00:00:00Z").toISOString().slice(0, 10)
          : "") !== value
      )
        throw new BadRequestException("日期格式无效");
      const time =
        key === "to"
          ? zonedDayStart(nextDate(value), zone)
          : zonedDayStart(value, zone);
      result[key] = new Date(time).toISOString();
    }
  if (result.from && result.to && result.from >= result.to)
    throw new BadRequestException("开始日期不能晚于结束日期");
  return result;
}
function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /secret|password|token|authorization|cookie|credential/i.test(k)
          ? "[已隐藏]"
          : redact(v),
      ]),
    );
  if (typeof value === "string") {
    try {
      return JSON.stringify(redact(JSON.parse(value)));
    } catch {
      return value.replace(
        /((?:secret[_-]?key|app[_-]?secret|password|access[_-]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[已隐藏]",
      );
    }
  }
  return value;
}
@Controller("api/records")
export class RecordsController {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(ConfigurationService) private config: ConfigurationService,
  ) {}
  private get timeZone() {
    return resolveTimeZone(this.config.get("app.timezone"));
  }
  private filter(kind: Kind, query: Record<string, string> = {}) {
    const conditions = ["1=1"];
    const values: (string | number)[] = [];
    if (query.scope) {
      if (kind !== "sync")
        throw new BadRequestException("此记录不支持同步范围");
      conditions.push("r.source IN (?, 'feishu','feishu.all')");
      values.push("feishu." + parse(scopes, query.scope));
    }
    const date = recordDateRange(query, this.timeZone),
      column = kind === "sync" ? "r.started_at" : "r.created_at";
    if (date.from) {
      conditions.push(`julianday(${column})>=julianday(?)`);
      values.push(date.from);
    }
    if (date.to) {
      conditions.push(`julianday(${column})<julianday(?)`);
      values.push(date.to);
    }
    if (query.type) {
      conditions.push(
        `r.${kind === "audit" ? "action" : kind === "sync" ? "source" : "type"}=?`,
      );
      values.push(parse(z.string().max(100), query.type));
    }
    if (query.actor && kind === "audit") {
      if (query.actor === "system") conditions.push("r.actor_id IS NULL");
      else {
        conditions.push("CAST(r.actor_id AS TEXT)=?");
        values.push(parse(z.string().max(100), query.actor));
      }
    }
    if (query.status && kind !== "audit") {
      if (query.status === "processing")
        conditions.push("r.status IN ('queued','running')");
      else {
        conditions.push("r.status=?");
        values.push(
          parse(
            z.enum(["queued", "running", "success", "failed"]),
            query.status,
          ),
        );
      }
    }
    if (query.handled) {
      conditions.push("coalesce(n.handled,0)=?");
      values.push(
        parse(z.enum(["true", "false"]), query.handled) === "true" ? 1 : 0,
      );
    }
    if (query.q) {
      const q =
        "%" +
        parse(z.string().max(200), query.q).replace(/[\\%_]/g, "\\$&") +
        "%";
      const fields =
        kind === "audit"
          ? ["r.action", "r.detail", "r.actor_id"]
          : kind === "sync"
            ? ["r.source", "r.error"]
            : [
                "r.type",
                "r.error",
                "(SELECT subject FROM meetings WHERE id=CASE WHEN json_valid(r.payload_json) THEN json_extract(r.payload_json,'$.id') END)",
              ];
      conditions.push(
        "(" +
          [...fields, "n.note"]
            .map((f) => `${f} LIKE ? ESCAPE '\\'`)
            .join(" OR ") +
          ")",
      );
      values.push(...[...fields, "n.note"].map(() => q));
    }
    return { where: conditions.join(" AND "), values };
  }
  @Get("statistics") async statistics(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, string>,
  ) {
    await this.auth.require(req, [...managers]);
    const range = recordDateRange(query, this.timeZone);
    const parts = ["1=1"];
    const values: string[] = [];
    if (range.from) {
      parts.push("julianday(occurred_at)>=julianday(?)");
      values.push(range.from);
    }
    if (range.to) {
      parts.push("julianday(occurred_at)<julianday(?)");
      values.push(range.to);
    }
    const events = this.database.connection
      .prepare(
        `SELECT event,count(*) AS count FROM meeting_success_events WHERE ${parts.join(" AND ")} GROUP BY event`,
      )
      .all(...values) as { event: string; count: number }[];
    const filter = this.filter("jobs", {
      from: query.from || "",
      to: query.to || "",
    });
    const rows = this.database.connection
      .prepare(
        `SELECT status,count(*) AS count FROM jobs r LEFT JOIN record_annotations n ON n.kind='jobs' AND n.record_id=r.id WHERE ${filter.where} GROUP BY status`,
      )
      .all(...filter.values) as { status: string; count: number }[];
    // 当前时间范围内真实出现过的审计事件，用作筛选下拉，避免列出大量空选项。
    const actionParts = ["1=1"];
    const actionValues: string[] = [];
    if (range.from) {
      actionParts.push("julianday(created_at)>=julianday(?)");
      actionValues.push(range.from);
    }
    if (range.to) {
      actionParts.push("julianday(created_at)<julianday(?)");
      actionValues.push(range.to);
    }
    const actions = this.database.connection
      .prepare(
        `SELECT action,count(*) AS count FROM audit_logs WHERE ${actionParts.join(" AND ")} GROUP BY action ORDER BY count DESC, action`,
      )
      .all(...actionValues) as { action: string; count: number }[];
    return {
      created: events.find((r) => r.event === "created")?.count || 0,
      cancelled: events.find((r) => r.event === "cancelled")?.count || 0,
      failed: rows.find((r) => r.status === "failed")?.count || 0,
      processing: rows
        .filter((r) => ["queued", "running"].includes(r.status))
        .reduce((sum, r) => sum + r.count, 0),
      actions,
    };
  }
  @Get("audit/actors") async auditActors(@Req() req: FastifyRequest) {
    await this.auth.require(req, [...managers]);
    return this.database.connection
      .prepare(
        `SELECT a.actor_id AS id,
                coalesce(u.display_name, a.actor_id, '系统') AS name,
                u.username AS username,
                count(*) AS count
         FROM audit_logs a
         LEFT JOIN users u ON CAST(u.id AS TEXT) = a.actor_id
         GROUP BY a.actor_id
         ORDER BY count DESC, name`,
      )
      .all()
      .map((row: any) => ({
        id: row.id == null ? "system" : String(row.id),
        name: row.name,
        username: row.username,
        count: row.count,
      }));
  }
  @Get(":kind") async list(
    @Req() req: FastifyRequest,
    @Param("kind") raw: string,
    @Query() query: Record<string, string>,
  ) {
    await this.auth.require(req, [...managers]);
    const kind = parse(kinds, raw),
      table = tables[kind];
    const page = parse(
      z.coerce.number().int().min(1).max(100000).default(1),
      query.page,
    );
    const { where, values } = this.filter(kind, query);
    const join = `${table} r LEFT JOIN record_annotations n ON n.kind='${kind}' AND n.record_id=r.id`;
    const count = this.database.connection
      .prepare(
        `SELECT count(*) AS total,coalesce(max(r.id),0) AS throughId FROM ${join} WHERE ${where}`,
      )
      .get(...values) as { total: number; throughId: number };
    const current = Math.min(page, Math.max(1, Math.ceil(count.total / 20)));
    const cols =
      kind === "jobs"
        ? "r.id,r.type,r.status,r.error,r.attempts,r.run_at,r.created_at,r.updated_at,CASE WHEN json_valid(r.payload_json) THEN json_extract(r.payload_json,'$.id') END AS meeting_id,CASE WHEN r.type='sync' AND json_valid(r.payload_json) THEN json_extract(r.payload_json,'$.actorId') END AS actor_id"
        : "r.*";
    const rows = this.database.connection
      .prepare(
        `SELECT ${cols},coalesce(n.note,'') AS note,coalesce(n.handled,0) AS handled,n.updated_at AS annotation_updated_at FROM ${join} WHERE ${where} ORDER BY r.id DESC LIMIT 20 OFFSET ?`,
      )
      .all(...values, (current - 1) * 20) as Record<string, any>[];
    const items = rows.map((row) => {
      if (kind === "audit") {
        const actor = this.database.connection
          .prepare(
            "SELECT display_name,username FROM users WHERE CAST(id AS TEXT)=?",
          )
          .get(row.actor_id) as
          | { display_name: string; username: string }
          | undefined;
        row.actor_name = actor?.display_name || row.actor_id || "系统";
        row.actor_username = actor?.username || null;
      }
      if (kind === "jobs" && row.type.startsWith("calendar.") && row.meeting_id)
        Object.assign(
          row,
          this.database.connection
            .prepare(
              "SELECT c.subject, u.display_name AS actor_name, u.username AS actor_username FROM calendar_events c LEFT JOIN users u ON u.id=c.created_by WHERE c.id=?",
            )
            .get(row.meeting_id) || {},
        );
      if (kind === "jobs" && row.type === "sync" && row.actor_id) {
        const actor = this.database.connection
          .prepare("SELECT display_name,username FROM users WHERE id=?")
          .get(Number(row.actor_id)) as
          | { display_name: string; username: string }
          | undefined;
        row.actor_name = actor?.display_name || String(row.actor_id);
        row.actor_username = actor?.username || null;
      }
      if (kind === "jobs" && row.type.startsWith("recording.") && row.meeting_id) {
        Object.assign(
          row,
          this.database.connection
            .prepare(
              "SELECT m.subject, u.display_name AS actor_name, u.username AS actor_username FROM meetings m LEFT JOIN users u ON u.id=m.created_by WHERE m.id=?",
            )
            .get(row.meeting_id) || {},
        );
      }
      if (kind === "jobs" && row.type.startsWith("meeting.") && row.meeting_id)
        Object.assign(
          row,
          this.database.connection
            .prepare(
              "SELECT m.subject, a.name AS account_name, u.display_name AS actor_name, u.username AS actor_username FROM meetings m LEFT JOIN meeting_accounts a ON a.id=m.meeting_account_id LEFT JOIN users u ON u.id=m.created_by WHERE m.id=?",
            )
            .get(row.meeting_id) || {},
        );
      return Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
          ["detail", "error", "result_json"].includes(k) ? redact(v) : v,
        ]),
      );
    });
    return { items, ...count, page: current, pageSize: 20 };
  }
  @Patch(":kind/:id") async annotate(
    @Req() req: FastifyRequest,
    @Param("kind") raw: string,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
    const kind = parse(kinds, raw),
      id = parse(idSchema, rawId);
    const input = parse(
      z.object({ note: z.string().max(2000), handled: z.boolean() }).strict(),
      body,
    );
    return this.database.connection.transaction(() => {
      if (
        !this.database.connection
          .prepare(`SELECT 1 FROM ${tables[kind]} WHERE id=?`)
          .get(id)
      )
        throw new NotFoundException("记录不存在");
      this.database.connection
        .prepare(
          "INSERT INTO record_annotations(kind,record_id,note,handled,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(kind,record_id) DO UPDATE SET note=excluded.note,handled=excluded.handled,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP",
        )
        .run(kind, id, input.note, input.handled ? 1 : 0, user.id);
      this.database.addAuditLog(
        "records.annotate",
        JSON.stringify({ kind, id, handled: input.handled }),
        String(user.id),
      );
      return { ok: true };
    })();
  }
  @Delete(":kind/:id") async remove(
    @Req() req: FastifyRequest,
    @Param("kind") raw: string,
    @Param("id") rawId: string,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
    const kind = parse(kinds, raw),
      id = parse(idSchema, rawId);
    // 审计记录是操作追踪的底账，不允许删除。
    if (kind === "audit") throw new ForbiddenException("审计记录不可删除");
    return this.database.connection.transaction(() => {
      const row = this.database.connection
        .prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`)
        .get(id) as { status?: string } | undefined;
      if (!row) throw new NotFoundException("记录不存在");
      if (row.status && ["queued", "running"].includes(row.status))
        throw new ConflictException("正在排队或执行的记录不能删除");
      this.database.connection
        .prepare(`DELETE FROM ${tables[kind]} WHERE id=?`)
        .run(id);
      this.database.connection
        .prepare("DELETE FROM record_annotations WHERE kind=? AND record_id=?")
        .run(kind, id);
      this.database.addAuditLog(
        "records.delete",
        JSON.stringify({ kind, id }),
        String(user.id),
      );
      return { ok: true };
    })();
  }
  @Post(":kind/clear") async clear(
    @Req() req: FastifyRequest,
    @Param("kind") raw: string,
    @Body() body: unknown,
  ) {
    const user = await this.auth.require(req, ["system_admin"]);
    const kind = parse(kinds, raw);
    if (kind === "audit") throw new ForbiddenException("审计记录不可清理");
    const input = parse(
      z.object({
        throughId: z.number().int().min(0),
        scope: scopes.optional(),
        filters: z.record(z.string(), z.string().max(200)).optional(),
      }),
      body,
    );
    const { where, values } = this.filter(kind, {
      ...input.filters,
      ...(input.scope ? { scope: input.scope } : {}),
    });
    return this.database.connection.transaction(() => {
      const terminal = "r.status IN ('success','failed')";
      const result = this.database.connection
        .prepare(
          `DELETE FROM ${tables[kind]} WHERE id IN (SELECT r.id FROM ${tables[kind]} r LEFT JOIN record_annotations n ON n.kind='${kind}' AND n.record_id=r.id WHERE ${where} AND ${terminal} AND r.id<=?)`,
        )
        .run(...values, input.throughId);
      this.database.connection
        .prepare(
          `DELETE FROM record_annotations WHERE kind=? AND record_id NOT IN (SELECT id FROM ${tables[kind]})`,
        )
        .run(kind);
      this.database.addAuditLog(
        "records.clear",
        JSON.stringify({
          kind,
          throughId: input.throughId,
          deleted: result.changes,
        }),
        String(user.id),
      );
      return { ok: true, deleted: result.changes };
    })();
  }
}
