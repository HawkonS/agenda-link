import {and,eq} from "drizzle-orm";
import {meetings,meetingAttendees} from "../../../db/schema.js";
import type {DatabaseService} from "../../../database.service.js";
import type {TencentAdapter} from "../../shared/tencent/client.js";
import type {MeetingRow,MeetingAccount} from "../contract.js";
export async function syncTencentCohosts(database:DatabaseService,tencent:TencentAdapter,row:MeetingRow,hostAccount:MeetingAccount) {
    const attendees = database.db
      .select()
      .from(meetingAttendees)
      .where(
        and(
          eq(meetingAttendees.meetingId, row.id),
          eq(meetingAttendees.isCohost, true),
        ),
      )
      .all();
    if (!attendees.length) return;
    const save = (
      a: (typeof attendees)[number],
      status: string,
      error: string | null = null,
    ) => {
      if (a.cohostStatus === status && a.cohostError === error) return;
      database.db
        .update(meetingAttendees)
        .set({ cohostStatus: status, cohostError: error })
        .where(eq(meetingAttendees.id, a.id))
        .run();
    };
    let account: MeetingAccount;
    let data: {participants:any[];status?:string};
    try {
      account = hostAccount;
      data = await tencent.realtimeParticipants(
        row.externalMeetingId!,
        account,
      );
    } catch (error) {
      for (const a of attendees) {
        if (["applied", "host", "preassigned_host"].includes(a.cohostStatus))
          continue;
        save(
          a,
          "failed",
          error instanceof Error ? error.message : "查询会中成员失败",
        );
      }
      throw error;
    }
    // The creator is allowed to operate using its enterprise UserID. Requiring
    // the pool account to be online prevents meetings hosted on its behalf from
    // ever assigning cohosts. Only the target needs a live meeting identity.
    const creatorDevice = data.participants.find(
      (p: any) => p.userid === account.accountId,
    );
    const creator = {
      userid: account.accountId,
      instanceid:
        Number.isInteger(creatorDevice?.instanceid) &&
        creatorDevice.instanceid >= 1 &&
        creatorDevice.instanceid <= 9
          ? creatorDevice.instanceid
          : 1,
    };
    for (const a of attendees) {
      // A user may release the host while the participant lookup is in flight.
      if (
        database.db
          .select({ status: meetings.status })
          .from(meetings)
          .where(eq(meetings.id, row.id))
          .get()?.status !== "scheduled"
      )
        return;
      const matches = data.participants.filter(
        (p: any) => a.externalId && p.userid === a.externalId,
      );
      const host = matches.find((p: any) =>
        [2, 3, 5].includes(Number(p.user_role)),
      );
      if (host || a.externalId === account.accountId) {
        save(a, "host");
        continue;
      }
      if (matches.some((p: any) => [6, 7].includes(Number(p.user_role)))) {
        save(a, "applied");
        continue;
      }
      if (!matches.length) {
        // Keep the last confirmed success when a user leaves. Re-check their
        // actual role on rejoin instead of reusing a historical device record.
        if (["applied", "host", "preassigned_host"].includes(a.cohostStatus))
          continue;
        const waitingMeeting = ["2", "MEETING_STATE_INIT"].includes(
          data.status || "",
        );
        save(
          a,
          waitingMeeting ? "waiting_meeting" : "waiting_join",
          waitingMeeting
            ? "会议尚未开始，入会后自动设置"
            : "未检测到绑定的腾讯企业账号入会，请使用绑定账号加入会议",
        );
        continue;
      }
      const participant = matches.find(
        (p: any) =>
          p.ms_open_id &&
          Number.isInteger(p.instanceid) &&
          p.instanceid >= 1 &&
          p.instanceid <= 9,
      );
      if (!participant) {
        save(
          a,
          "failed",
          matches.some((p: any) => p.ms_open_id)
            ? "腾讯会控暂不支持该入会设备，请使用电脑或手机客户端入会"
            : "腾讯会议未返回会中身份，暂时无法设置联席主持人",
        );
        continue;
      }
      try {
        await tencent.cohost(
          row.externalMeetingId!,
          creator,
          participant,
          account,
        );
        save(a, "applied");
      } catch (error) {
        save(
          a,
          "failed",
          error instanceof Error ? error.message : "联席设置失败",
        );
      }
    }
}
