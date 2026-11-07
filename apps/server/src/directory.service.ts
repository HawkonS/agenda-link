import { loginSharesFeishuTenant } from "./platforms/shared/feishu/identity.js";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "./database.service.js";
import { meetingAccounts, platformIdentities, users } from "./db/schema.js";
import { PlatformRegistry } from "./platforms/registry.js";
import type { DirectorySnapshot } from "./platforms/directory/contract.js";
import { createHash } from "node:crypto";
type Snapshot = DirectorySnapshot & { fetchedAt: string; revision: string };
@Injectable()
export class DirectoryService {
  constructor(
    @Inject(DatabaseService) private database: DatabaseService,
    @Inject(PlatformRegistry) private registry: PlatformRegistry,
  ) {}
  private revision(connectionId: string) {
    return createHash("sha256")
      .update(JSON.stringify(this.registry.connections.get(connectionId)))
      .digest("hex");
  }
  view(connectionId: string) {
    this.registry.descriptor("directory", connectionId);
    const raw = this.database.getState("directory.snapshot." + connectionId);
    const snapshot: Snapshot | undefined = raw ? JSON.parse(raw) : undefined;
    if (!snapshot || snapshot.revision !== this.revision(connectionId))
      return { departments: [], people: [], fetchedAt: null };
    const identities = this.database.db
      .select()
      .from(platformIdentities)
      .where(eq(platformIdentities.connectionId, connectionId))
      .all();
    return {
      ...snapshot,
      revision: undefined,
      people: snapshot.people.map((p) => ({
        ...p,
        localUserId:
          identities.find(
            (i) => i.kind === "person" && i.externalId === p.externalId,
          )?.userId || null,
      })),
    };
  }
  async read(connectionId: string, actorId: number) {
    const revision = this.revision(connectionId);
    const snapshot = {
      ...(await this.registry.directory(connectionId).read()),
      fetchedAt: new Date().toISOString(),
      revision,
    };
    if (revision !== this.revision(connectionId))
      throw new BadRequestException("连接已变更，请重新读取通讯录");
    this.database.setState(
      "directory.snapshot." + connectionId,
      JSON.stringify(snapshot),
    );
    this.database.addAuditLog(
      "directory.read",
      JSON.stringify({ connectionId, people: snapshot.people.length }),
      String(actorId),
    );
    return this.view(connectionId);
  }
  import(
    connectionId: string,
    selectedIds: string[],
    fetchedAt: string,
    actorId: number,
  ) {
    const component = this.registry.descriptor("directory", connectionId);
    const snapshot = this.view(connectionId);
    if (!snapshot.fetchedAt || fetchedAt !== snapshot.fetchedAt)
      throw new BadRequestException("通讯录预览已失效，请重新读取");
    const ids = [...new Set(selectedIds)];
    if (ids.some((id) => !snapshot.people.some((p) => p.externalId === id)))
      throw new BadRequestException("所选人员不在预览中");
    const result = this.database.db.transaction((tx) => {
      let created = 0,
        updated = 0;
      for (const department of snapshot.departments)
        tx.insert(platformIdentities)
          .values({
            providerId: component.providerId,
            connectionId,
            kind: "department",
            externalId: department.externalId,
            name: department.name,
            profileJson: JSON.stringify(department),
          })
          .onConflictDoUpdate({
            target: [
              platformIdentities.connectionId,
              platformIdentities.kind,
              platformIdentities.externalId,
            ],
            set: {
              name: department.name,
              profileJson: JSON.stringify(department),
              updatedAt: new Date().toISOString(),
            },
          })
          .run();
      for (const id of ids) {
        const p = snapshot.people.find((p) => p.externalId === id)!;
        const existing = tx
          .select()
          .from(platformIdentities)
          .where(
            and(
              eq(platformIdentities.connectionId, connectionId),
              eq(platformIdentities.kind, "person"),
              eq(platformIdentities.externalId, id),
            ),
          )
          .get();
        let userId = existing?.userId;
        if (
          !userId &&
          component.providerId === "feishu" &&
          p.stableId &&
          loginSharesFeishuTenant(
            this.registry.config,
            this.database,
            connectionId,
          )
        )
          userId = tx
            .select()
            .from(users)
            .where(eq(users.feishuUserId, p.stableId))
            .get()?.id;
        if (!userId) {
          const row = tx
            .insert(users)
            .values({
              username: `directory:${connectionId}:${id}`,
              displayName: p.name,
              email: p.email || null,
              phone: p.phone || null,
              avatarUrl: p.avatarUrl || null,
              systemAccess: "not_added",
              source: component.providerId,
              status: p.disabled ? "disabled" : "active",
            })
            .returning()
            .get();
          userId = row.id;
          created++;
        } else {
          tx.update(users)
            .set({
              displayName: p.name,
              email: p.email || null,
              phone: p.phone || null,
              avatarUrl: p.avatarUrl || null,
              status: p.disabled ? "disabled" : "active",
            })
            .where(eq(users.id, userId))
            .run();
          updated++;
        }
        if (
          this.registry.components.some(
            (c) =>
              c.connectionId === connectionId &&
              c.capability === "meeting" &&
              c.capabilities.accountPool,
          )
        ) {
          const advanced = !!p.providerData?.advanced && !p.disabled;
          const account = tx
            .select()
            .from(meetingAccounts)
            .where(
              and(
                eq(meetingAccounts.connectionId, connectionId),
                eq(meetingAccounts.accountId, id),
              ),
            )
            .get();
          if (advanced && !account)
            tx.insert(meetingAccounts)
              .values({
                providerId: component.providerId,
                connectionId,
                accountId: id,
                name: p.name,
                verifiedAt: new Date().toISOString(),
              })
              .run();
          else if (account)
            tx.update(meetingAccounts)
              .set({
                name: p.name,
                verifiedAt: advanced ? new Date().toISOString() : null,
                ...(!advanced
                  ? {
                      status: "disabled" as const,
                      lastError: "平台账号已停用或不具备账号池所需许可",
                    }
                  : {}),
              })
              .where(eq(meetingAccounts.id, account.id))
              .run();
        }
        tx.insert(platformIdentities)
          .values({
            providerId: component.providerId,
            connectionId,
            kind: "person",
            externalId: id,
            stableId: p.stableId || null,
            name: p.name,
            userId,
            profileJson: JSON.stringify(p),
          })
          .onConflictDoUpdate({
            target: [
              platformIdentities.connectionId,
              platformIdentities.kind,
              platformIdentities.externalId,
            ],
            set: {
              stableId: p.stableId || null,
              name: p.name,
              userId,
              profileJson: JSON.stringify(p),
              updatedAt: new Date().toISOString(),
            },
          })
          .run();
      }
      return { created, updated };
    });
    this.database.addAuditLog(
      "directory.import",
      JSON.stringify({ connectionId, ...result }),
      String(actorId),
    );
    return result;
  }
}
