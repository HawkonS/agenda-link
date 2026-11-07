export function cohostDetail(
  attendee: { cohostStatus: string; cohostError?: string | null },
  meeting: { status: string; startAt: string; endAt: string },
) {
  const status = attendee.cohostStatus;
  if (["host", "applied", "not_applicable"].includes(status))
    return { status, reason: attendee.cohostError || "—" };
  if (status === "preassigned_host")
    return {
      status,
      reason: "预约时已指定为会议主持人；会议开始后核对实际身份",
    };
  if (meeting.status === "cancelled")
    return { status: "cohost_cancelled", reason: "不再设置联席主持人" };
  if (meeting.status === "finished" || Date.parse(meeting.endAt) <= Date.now())
    return { status: "cohost_ended", reason: "会议结束前未完成设置" };
  if (status === "pending")
    return Date.parse(meeting.startAt) > Date.now()
      ? { status: "waiting_meeting", reason: "会议开始、参会人入会后自动设置" }
      : { status: "cohost_pending", reason: "正在检查会中成员" };
  return { status, reason: attendee.cohostError || "—" };
}
