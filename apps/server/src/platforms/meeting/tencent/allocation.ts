import { BadRequestException } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DatabaseService } from "../../../database.service.js";
import {
  accountPoolMembers,
  accountPools,
  meetingAccounts,
  meetings,
  users,
  platformIdentities,
} from "../../../db/schema.js";

type Reader = Pick<DatabaseService["db"], "select">;
export type HostSelectionInput = {
  startAt: string;
  endAt: string;
  attendeeIds: number[];
  accountPoolId?: number;
  hostMode?: "auto" | "person" | "pool";
  hostUserId?: number;
};
export type HostSelection = {
  meetingAccountId: number;
  hostAccountId: string;
  hostAccountName: string;
  allocationSource: "personal" | "invitee" | "pool";
  accountPoolId: number | null;
  accountPoolName: string | null;
};

// Cancel failures still reserve the host until remote cancellation is confirmed.
export const occupiedMeeting = () =>
  sql`(${meetings.status} IN ('scheduled','provisioning','unknown','cancelling','cancel_failed') OR (${meetings.status} = 'failed' AND ${meetings.externalMeetingId} IS NOT NULL))`;

export function listPeople(reader: Reader, connectionId = "tencent-meeting") {
  const identities=reader.select().from(platformIdentities).where(and(eq(platformIdentities.connectionId,connectionId),eq(platformIdentities.kind,"person"))).all();
  const accounts=reader.select().from(meetingAccounts).where(and(eq(meetingAccounts.connectionId,connectionId),eq(meetingAccounts.status,"available"))).all();
  return reader.select().from(users).where(eq(users.status,"active")).all().map(p=>{
    const identity=identities.find(i=>i.userId===p.id),profile=JSON.parse(identity?.profileJson || "{}");
    const externalId=identity?.externalId || null;
    return {id:p.id,displayName:p.displayName,email:p.email,status:p.status,externalId,canHost:!!profile.providerData?.advanced && accounts.some(a=>a.accountId===externalId && !!a.verifiedAt)};
  });
}
export function bookingPeople(reader: Reader, attendeeIds:number[], requesterId:number,connectionId="tencent-meeting") {
  const ids=[...new Set(attendeeIds)],all=listPeople(reader,connectionId);
  const people=ids.map(id=>all.find(p=>p.id===id));
  if(people.some(p=>!p || (!p.externalId && p.id!==requesterId)))throw new BadRequestException("参会人员必须已同步到腾讯会议并处于启用状态");
  return people as NonNullable<typeof people[number]>[];
}

/** Preview and reservation use this same deterministic selection. Reservation
 * runs it inside an IMMEDIATE transaction, then reserves the chosen host. */
export function selectMeetingHost(
  reader: Reader,
  input: HostSelectionInput,
  userId: number,
  connectionId = "tencent-meeting",
): HostSelection | undefined {
  const invitees = bookingPeople(reader, input.attendeeIds, userId,connectionId);
  const owner = listPeople(reader,connectionId).find(p=>p.id===userId);
  if (
    input.hostMode === "person" &&
    input.hostUserId !== userId &&
    !invitees.some((p) => p.id === input.hostUserId)
  )
    throw new BadRequestException("只能选择本人或已邀请参会人的高级账号");
  const accounts = reader
    .select({
      id: meetingAccounts.id,
      name: meetingAccounts.name,
      accountId: meetingAccounts.accountId,
    })
    .from(meetingAccounts)
    .where(
      and(
        eq(meetingAccounts.status, "available"),
        eq(meetingAccounts.connectionId,connectionId),
        sql`${meetingAccounts.verifiedAt} IS NOT NULL AND ${meetingAccounts.verifiedAt} <> ''`,
      ),
    )
    .orderBy(asc(meetingAccounts.id))
    .all();
  const busy = new Set(
    reader
      .select({ id: meetings.meetingAccountId })
      .from(meetings)
      .where(
        and(
          occupiedMeeting(),
          sql`${meetings.startAt} < ${input.endAt} AND ${meetings.endAt} > ${input.startAt}`,
        ),
      )
      .all()
      .map((m) => m.id),
  );
  const available = accounts.filter((a) => !busy.has(a.id));
  const byUserId = new Map(available.map((a) => [a.accountId, a]));
  const candidates =
    input.hostMode === "pool"
      ? []
      : [owner, ...invitees.filter((p) => p.id !== userId)];
  for (const person of candidates) {
    if (input.hostMode === "person" && person?.id !== input.hostUserId)
      continue;
    if (
      person?.status !== "active" ||
      !person.canHost ||
      !person.externalId
    )
      continue;
    const account = byUserId.get(person.externalId);
    if (account)
      return {
        meetingAccountId: account.id,
        hostAccountId: account.accountId,
        hostAccountName: person.displayName,
        allocationSource: person.id === userId ? "personal" : "invitee",
        accountPoolId: null,
        accountPoolName: null,
      };
  }
  // An explicit person is never silently replaced with another host or pool.
  if (input.hostMode === "person") return undefined;
  const members = reader
    .select({
      poolId: accountPools.id,
      poolName: accountPools.name,
      accountId: accountPoolMembers.accountId,
    })
    .from(accountPools)
    .innerJoin(
      accountPoolMembers,
      eq(accountPoolMembers.poolId, accountPools.id),
    )
    .where(
      and(
        eq(accountPools.enabled, true),
        eq(accountPools.connectionId,connectionId),
        input.accountPoolId
          ? eq(accountPools.id, input.accountPoolId)
          : undefined,
      ),
    )
    .orderBy(
      desc(accountPools.isDefault),
      asc(accountPools.id),
      asc(accountPoolMembers.accountId),
    )
    .all();
  const byId = new Map(available.map((a) => [a.id, a]));
  for (const member of members) {
    const account = byId.get(member.accountId);
    if (account)
      return {
        meetingAccountId: account.id,
        hostAccountId: account.accountId,
        hostAccountName: account.name,
        allocationSource: "pool",
        accountPoolId: member.poolId,
        accountPoolName: member.poolName,
      };
  }
}
