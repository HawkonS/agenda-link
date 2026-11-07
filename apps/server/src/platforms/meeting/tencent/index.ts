import {templateVariables} from "./template-variables.js";
import { BadRequestException } from "@nestjs/common";
import type { PlatformComponent } from "../../contracts.js";
import type { MeetingProvider } from "../contract.js";
import { bookingPeople, selectMeetingHost,listPeople } from "./allocation.js";
import {TencentAccountsService} from "./accounts.js";
import {syncTencentCohosts} from "./cohosts.js";
import { meetingCode, tencentMeetingResponse } from "../../shared/tencent/client.js";
import { meetingJoinUrl } from "../../meeting-url.js";
import { tencentFields } from "../../directory/tencent/index.js";
export const tencentMeeting: PlatformComponent = {
  apiHosts:["api.meeting.qq.com"],
  id:"meeting.tencent", providerId:"tencent", name:"腾讯会议", capability:"meeting",
  connectionId:"tencent-meeting", connectionName:"腾讯会议开放平台", fields:tencentFields,
  meetingDomains:[".tencent.com",".qq.com",".tencentmeeting.com"],
  recordingDomains:[".tencent.com",".qq.com",".myqcloud.com",".tencentmeeting.com",".tencentcs.com"],
  capabilities:{create:true, query:true, cancel:true, accountPool:true, cohost:true,preassignHost:true, recording:true, deleteRecording:true, downloadRecording:true, remoteEnd:false},
  templateVariables,
  create:({tencent,database}) => Object.assign(tencent, {
    validate(){},listPeople,accounts:new TencentAccountsService(database,tencent),syncCohosts:(row,account)=>syncTencentCohosts(database,tencent,row,account), selectHost:selectMeetingHost, people:bookingPeople,
    async lookup(id,account,expected) {
      const data = await tencent.request(`/v1/meetings/${encodeURIComponent(id)}?userid=${encodeURIComponent(account.accountId)}&instanceid=1`,"GET",undefined,account);
      const remote = data.meeting_info_list?.[0];
      if (!remote || remote.subject!==expected.subject || Number(remote.start_time)!==Math.floor(Date.parse(expected.startAt)/1000)) throw new BadRequestException("会议主题或开始时间不匹配");
      return {id,code:meetingCode(remote),url:meetingJoinUrl(remote.join_url),response:tencentMeetingResponse(data,remote)};
    },
  } satisfies Pick<MeetingProvider,"validate"|"selectHost"|"people"|"lookup"|"listPeople"|"accounts"|"syncCohosts">),
};
