import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and,eq } from "drizzle-orm";
import { DatabaseService } from "../../../database.service.js";
import { TencentAdapter } from "../../shared/tencent/client.js";
import {
  accountPoolMembers,
  accountPools,
  meetingAccounts,
} from "../../../db/schema.js";

@Injectable()
export class TencentAccountsService {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(TencentAdapter) private tencent: TencentAdapter,
  ) {}

  private hasAdvancedLicense(data: any) {
    // account_type describes the enterprise product, not the user's paid license.
    return data.user_account_type != null && this.tencent.isAdvanced(data);
  }

  async preview() {
    const remote = await this.tencent.userList();
    const candidates = remote.filter(
      (r) => r.user_account_type == null || this.hasAdvancedLicense(r),
    );
    const details: any[] = [];
    for (let i = 0; i < candidates.length; i += 4)
      details.push(
        ...(await Promise.all(
          candidates.slice(i, i + 4).map(async (r) =>
            r.user_account_type == null
              ? {
                  ...r,
                  ...(await this.tencent.user(r.userid)),
                  userid: r.userid,
                }
              : r,
          ),
        )),
      );
    const local = new Map(
      this.database.db
        .select()
        .from(meetingAccounts)
        .where(eq(meetingAccounts.connectionId,"tencent-meeting"))
        .all()
        .map((r) => [r.accountId, r]),
    );
    return {
      fetchedAt: new Date().toISOString(),
      accounts: details
        .filter((r) => this.hasAdvancedLicense(r))
        .map((r) => ({
          accountId: r.userid as string,
          name: String(r.username || r.userid),
          accountType: Number(r.user_account_type),
          departmentNames: (r.department_list || [])
            .map((d: any) => d.department_full_name || d.department_name)
            .filter(Boolean) as string[],
          platformStatus: String(r.status || ""),
          canImport: Number(r.status) === 1,
          localId: local.get(r.userid)?.id || null,
          localStatus: local.get(r.userid)?.status || null,
        })),
    };
  }

  async import(accountIds: string[], poolId?: number, actorId?: number) {
    const ids = [...new Set(accountIds)];
    const verified: { accountId: string; name: string }[] = [];
    // Recheck the live license before storing anything; the preview may be stale.
    for (let i = 0; i < ids.length; i += 4)
      verified.push(
        ...(await Promise.all(
          ids.slice(i, i + 4).map(async (accountId) => {
            const detail = await this.tencent.user(accountId);
            if (!this.hasAdvancedLicense(detail))
              throw new BadRequestException(
                `${detail.username || accountId} 当前没有高级用户许可，请重新获取`,
              );
            if (Number(detail.status) !== 1)
              throw new BadRequestException(
                `${detail.username || accountId} 不是正常启用的腾讯账号，请先在腾讯会议激活或启用`,
              );
            const existing = this.database.db
              .select()
              .from(meetingAccounts)
              .where(and(eq(meetingAccounts.accountId,accountId),eq(meetingAccounts.connectionId,"tencent-meeting")))
              .get();
            if (existing?.secretId && existing.secretKey)
              await this.tencent.verifyAccount(existing);
            return { accountId, name: String(detail.username || accountId) };
          }),
        )),
      );
    return this.database.db.transaction((tx) => {
      if (poolId !== undefined) {
        const pool = tx
          .select()
          .from(accountPools)
          .where(eq(accountPools.id, poolId))
          .get();
        if (!pool || pool.connectionId!=="tencent-meeting") throw new NotFoundException("账号池不存在");
        if (!pool.enabled) throw new BadRequestException("请先启用目标账号池");
      }
      const now = new Date().toISOString();
      const result = { created: 0, existing: 0, poolAdded: 0 };
      const memberIds = new Set(
        poolId === undefined
          ? []
          : tx
              .select()
              .from(accountPoolMembers)
              .where(eq(accountPoolMembers.poolId, poolId))
              .all()
              .map((m) => m.accountId),
      );
      for (const p of verified) {
        let row = tx
          .select()
          .from(meetingAccounts)
          .where(and(eq(meetingAccounts.accountId,p.accountId),eq(meetingAccounts.connectionId,"tencent-meeting")))
          .get();
        if (row) {
          // Preserve operator names, independent credentials and deliberate disablement.
          tx.update(meetingAccounts)
            .set({ verifiedAt: now, lastError: null, updatedAt: now })
            .where(eq(meetingAccounts.id, row.id))
            .run();
          result.existing++;
        } else {
          row = tx
            .insert(meetingAccounts)
            .values({ ...p, status: "available", verifiedAt: now })
            .returning()
            .get();
          result.created++;
        }
        if (poolId !== undefined && !memberIds.has(row.id)) {
          if (memberIds.size >= 100)
            throw new BadRequestException("一个账号池最多包含 100 个账号");
          tx.insert(accountPoolMembers)
            .values({ poolId, accountId: row.id })
            .run();
          memberIds.add(row.id);
          result.poolAdded++;
        }
      }
      this.database.addAuditLog(
        "account.tencent.import",
        JSON.stringify({ accountIds: ids, poolId, ...result }),
        actorId ? String(actorId) : undefined,
      );
      return result;
    });
  }
}
