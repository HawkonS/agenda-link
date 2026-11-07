import {feishuIdentity} from "../../shared/feishu/identity.js";
import { BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "../../../db/schema.js";
import type { PlatformComponent, ProviderContext } from "../../contracts.js";
import type { MeetingProvider, BookingPerson, MeetingHost } from "../contract.js";
import { PlatformError } from "../../shared/http.js";
import { meetingJoinUrl } from "../../meeting-url.js";
import { recordingUrl } from "../../recording-files.js";

function create(context: ProviderContext): MeetingProvider {
  const {feishu,connections} = context;
  const request = (path: string, method="GET", body?: unknown) => feishu.request(path,method,body,"meeting");
  const listPeople:MeetingProvider["listPeople"] = reader => reader.select().from(users).where(eq(users.status,"active")).all().map(p=>{
    const identity=feishuIdentity(reader,connections,"feishu-meeting",p.id);
    return {id:p.id,displayName:p.displayName,email:p.email,status:p.status,externalId:identity.userId || null,canHost:!!identity.userId};
  });
  const people:MeetingProvider["people"] = (reader,ids) => {
    const all=listPeople(reader),unique=[...new Set(ids)],rows=unique.map(id=>all.find(p=>p.id===id));
    if(rows.some(p=>!p))throw new BadRequestException("参会人员不存在或已停用");
    return rows as BookingPerson[];
  };
  return {
    validate(p) {
      if(Date.parse(p.endAt)>Date.now()+30*86400000) throw new BadRequestException("飞书预约到期时间不能超过当前时间 30 天");
      if(p.hostMode==="pool") throw new BadRequestException("飞书会议不使用高级账号池");
    },
    people,listPeople,
    selectHost(reader,input,userId): MeetingHost | undefined {
      const invited = people(reader,input.attendeeIds,userId);
      if(input.hostMode==="person" && input.hostUserId!==userId && !invited.some(p=>p.id===input.hostUserId)) throw new BadRequestException("只能选择本人或受邀人员作为主持人");
      const chosenId = input.hostMode==="person" ? input.hostUserId! : userId;
      const person = reader.select().from(users).where(eq(users.id,chosenId)).get();
      const own = person?.status==="active" ? feishuIdentity(reader,connections,"feishu-meeting",chosenId).userId : undefined;
      const fallback = input.hostMode==="person" ? undefined : String(connections.require("feishu-meeting").defaultOwnerUserId || "");
      const id = own || fallback;
      if(!id) throw new BadRequestException("请关联有效的飞书 User ID，或在该会议连接中配置默认归属人");
      return {meetingAccountId:null,hostAccountId:id,hostAccountName:own ? person!.displayName : "默认会议归属人",allocationSource:own ? chosenId===userId ? "personal" : "invitee" : "configured",accountPoolId:null,accountPoolName:null};
    },
    async verifyAccount(){return {ok:true};},
    async test(){await feishu.token("meeting"); return {ok:true, note:"应用凭据有效；会议接口权限将在预约时校验"};},
    async createMeeting(p,account) {
      this.validate({...p,attendeeIds:[]});
      if((p.hostIds?.length || 0)>10) throw new BadRequestException("飞书最多指定 10 名主持人");
      const d = await request("/vc/v1/reserves/apply?user_id_type=user_id","POST",{
        end_time:String(Math.floor(Date.parse(p.endAt)/1000)),owner_id:account.accountId,
        meeting_settings:{topic:p.subject,auto_record:p.recordingEnabled,assign_host_list:[...new Set([account.accountId,...(p.hostIds || [])])].map(id=>({user_type:1,id}))},
      });
      if(!d.reserve?.id) throw new PlatformError("飞书会议","NO_RESERVATION_ID",true);
      // A correction is a partial result: retain the remote ID so it can be inspected/cancelled.
      return {id:String(d.reserve.id),code:d.reserve.meeting_no,url:meetingJoinUrl(d.reserve.url,[".feishu.cn",".larksuite.com"]),response:d,rejectedHostIds:(d.reserve_correction?.invalid_host_id_list || d.invalid_host_id_list || []).map((host:any)=>String(typeof host==="string"?host:host.id))};
    },
    async cancel(id) {
      try {await request(`/vc/v1/reserves/${encodeURIComponent(id)}`,"DELETE");}
      catch(error) {if(!(error instanceof PlatformError) || !["121004"].includes(error.code)) throw error;}
    },
    async lookup(id,_account,expected) {
      const d = await request(`/vc/v1/reserves/${encodeURIComponent(id)}?user_id_type=user_id`);
      if(d.reserve?.meeting_settings?.topic!==expected.subject || Number(d.reserve.end_time)!==Math.floor(Date.parse(expected.endAt)/1000)) throw new BadRequestException("预约主题或到期时间不匹配");
      return {id,code:d.reserve.meeting_no,url:meetingJoinUrl(d.reserve.url,[".feishu.cn",".larksuite.com"]),response:d};
    },
    async recordingFiles(meeting) {
      const query = new URLSearchParams({meeting_no:"",start_time:String(Math.floor(Date.parse(meeting.startAt)/1000)),end_time:String(Math.min(Math.floor(Date.now()/1000),Math.floor(Date.parse(meeting.endAt)/1000)+86400))});
      let active: any;
      try {active = await request(`/vc/v1/reserves/${encodeURIComponent(meeting.externalMeetingId!)}/get_active_meeting`);} catch(error) {if(!(error instanceof PlatformError) || error.code!=="121004") throw error;}
      const ids = new Set<string>();
      if(active?.meeting?.id) ids.add(String(active.meeting.id));
      const no = meeting.meetingCode;
      if(no) {
        query.set("meeting_no",no);
        let page=""; const seen = new Set<string>();
        do {
          if(page)query.set("page_token",page);
          const data=await request("/vc/v1/meetings/list_by_no?"+query);
          for(const m of data.meeting_briefs || []) if(m.id)ids.add(String(m.id));
          if(!data.has_more)break;
          page=data.page_token;
          if(!page || seen.has(page) || seen.size>1000)throw new PlatformError("飞书会议","INVALID_PAGINATION");
          seen.add(page);
        } while(true);
      }
      const files=[];
      for(const id of ids) {
        try {
          const result=await request(`/vc/v1/meetings/${encodeURIComponent(id)}/recording`);
          if(result.recording?.url) files.push({id,viewUrl:recordingUrl(result.recording.url,[".feishu.cn",".larksuite.com"]),extension:"link"});
        } catch(error) {if(!(error instanceof PlatformError) || !["124002","121004","122002"].includes(error.code))throw error;}
      }
      return files;
    },
  };
}
export const feishuMeeting: PlatformComponent = {
  apiHosts:["open.feishu.cn","accounts.feishu.cn"],
  id:"meeting.feishu",providerId:"feishu",name:"飞书",capability:"meeting",
  connectionId:"feishu-meeting",connectionName:"飞书会议",
  meetingDomains:[".feishu.cn",".larksuite.com"],recordingDomains:[".feishu.cn",".larksuite.com"],
  fields:[{key:"appId",label:"App ID",required:true},{key:"appSecret",label:"App Secret",required:true,secret:true},{key:"tenantKey",label:"租户 Tenant Key（跨应用关联人员时填写）"},{key:"defaultOwnerUserId",label:"默认会议归属人 User ID（可选）"}],
  capabilities:{create:true,query:true,cancel:true,accountPool:false,cohost:false,preassignHost:true,recording:true,deleteRecording:false,downloadRecording:false,remoteEnd:false},
  templateVariables:[{key:"reserve.id",label:"飞书预约 ID",sample:"6911188411934973028"},{key:"reserve.meeting_no",label:"飞书预约会议号",sample:"123456789"}],
  create,
};
