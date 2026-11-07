import {feishuIdentity} from "../../shared/feishu/identity.js";
import type { PlatformComponent } from "../../contracts.js";
export const feishuCalendar: PlatformComponent = {
  apiHosts:["open.feishu.cn","accounts.feishu.cn"],
  id:"calendar.feishu", providerId:"feishu", name:"飞书", capability:"calendar",
  connectionId:"feishu-calendar", connectionName:"飞书日程",
  fields:[{key:"appId",label:"App ID",required:true},{key:"appSecret",label:"App Secret",required:true,secret:true},{key:"tenantKey",label:"租户 Tenant Key（跨应用关联人员时填写）"},{key:"calendarId",label:"共享日历 ID",required:true}],
  capabilities:{create:true, update:true, cancel:true, attendees:true},
  create:({feishu,database,connections}) => ({
    attendeesForUsers:ids=>ids.map(id=>feishuIdentity(database.db,connections,"feishu-calendar",id)),
    get calendarId(){return feishu.calendarId;}, test:()=>feishu.test("booking"),
    createEvent:(...args)=>feishu.createEvent(...args), updateEvent:(...args)=>feishu.updateEvent(...args),
    readEventDescription:(...args)=>feishu.readEventDescription(...args), invite:(...args)=>feishu.invite(...args),
    replaceAttendees:(...args)=>feishu.replaceAttendees(...args), deleteEvent:(...args)=>feishu.deleteEvent(...args),
  }),
};
