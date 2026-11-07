import type { PlatformComponent } from "../../contracts.js";
import { feishuAvatarUrl } from "../../shared/feishu/avatar.js";
export const feishuDirectory: PlatformComponent = {
  apiHosts:["open.feishu.cn","accounts.feishu.cn"],
  id: "directory.feishu", providerId: "feishu", name: "飞书", capability: "directory",
  connectionId: "feishu-directory", connectionName: "飞书通讯录",
  fields: [
    {key:"appId", label:"App ID", required:true},
    {key:"appSecret", label:"App Secret", required:true, secret:true},
    {key:"tenantKey",label:"租户 Tenant Key（跨应用关联人员时填写）"},
    {key:"rootDepartmentId", label:"同步根部门 ID", default:"0"},
  ], capabilities: {read:true, import:true, write:false},
  create: ({feishu}) => ({
    test: () => feishu.test("sync"),
    async read(includePeople = true) {
      const result = await feishu.directory("sync", includePeople);
      return {
        departments: result.departments.map(d => ({externalId:d.open_department_id, name:d.name, parentExternalId:d.parent_department_id})),
        people: result.people.map(p => ({externalId:p.open_id, stableId:p.user_id, name:p.name, email:p.email, phone:p.mobile, avatarUrl:feishuAvatarUrl(p) || undefined, departmentIds:p.department_ids, disabled:!!(p.status?.is_resigned || p.status?.is_frozen), providerData:{userId:p.user_id}})),
      };
    },
  }),
};
