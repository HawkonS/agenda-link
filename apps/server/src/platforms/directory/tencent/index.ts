import {FeishuTencentSync} from "./synchronizer.js";
import type { PlatformComponent } from "../../contracts.js";
export const tencentFields = [
  {key:"appId", label:"App ID / 企业 ID", required:true},
  {key:"sdkId", label:"Sdk ID", required:true},
  {key:"secretId", label:"Secret ID", required:true},
  {key:"secretKey", label:"Secret Key", required:true, secret:true},
  {key:"operatorId", label:"管理员 UserID", required:true},
  {key:"advancedType", label:"高级许可类型代码", default:"9", type:"number" as const},
];
export const tencentDirectory: PlatformComponent = {
  syncFrom:["feishu-directory"],
  createSync:({database,config,feishu,tencent,connections})=>new FeishuTencentSync(database,config,feishu,tencent,connections),
  apiHosts:["api.meeting.qq.com"],
  id:"directory.tencent", providerId:"tencent", name:"腾讯会议", capability:"directory",
  connectionId:"tencent-meeting", connectionName:"腾讯会议开放平台", fields:tencentFields,
  capabilities:{read:true, import:true, write:true},
  create: ({tencent}) => ({
    test: () => tencent.test(),
    async read(includePeople = true) {
      const departments = await tencent.departments();
      const people: any[] = [];
      if (includePeople) for (const row of await tencent.userList()) people.push({...row,...await tencent.user(row.userid)});
      return {
        departments: departments.map(d => ({externalId:String(d.department_id), name:d.department_name, parentExternalId:String(d.parent_department_id || "0")})),
        people:people.map(p => ({externalId:p.userid, name:p.username || p.userid, email:p.email, phone:p.phone || p.mobile, departmentIds:(p.department_list || []).map((d:any) => typeof d === "string" ? d : d.department_id), disabled:Number(p.status)!==1, providerData:{advanced:tencent.isAdvanced(p), accountType:p.user_account_type}})),
      };
    },
  }),
};
