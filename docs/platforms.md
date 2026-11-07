# 平台组件接入

组件由能力合同、实现和声明组成。修改后重新构建，无需动态加载远程代码。

## 新增会议平台示例

1. 在 `apps/server/src/platforms/meeting/example/index.ts` 实现 `MeetingProvider`。
2. 导出 `PlatformComponent`，声明配置、能力及模板变量。
3. 在 `apps/server/src/platforms/index.ts` 导入并加入 `platformComponents`。
4. 运行 `npm run check`，重新构建并在系统管理配置连接。

```ts
import type { PlatformComponent } from "../../contracts.js";
import type { MeetingProvider } from "../contract.js";

export const exampleMeeting: PlatformComponent = {
  id: "meeting.example",
  providerId: "example",
  name: "示例平台",
  capability: "meeting",
  connectionId: "example-meeting",
  connectionName: "示例平台会议",
  fields: [{ key: "token", label: "API Token", required: true, secret: true }],
  apiHosts: ["api.example.com"],
  meetingDomains: [".example.com"],
  recordingDomains: [".example.com"],
  capabilities: {
    create: true, query: true, cancel: true, recording: false,
    accountPool: false, cohost: false, preassignHost: false,
    deleteRecording: false, downloadRecording: false, remoteEnd: false,
  },
  templateVariables: [{ key: "ticket", label: "预约票据", sample: "ticket-1" }],
  create: context => createExampleProvider(context),
};
```

`createExampleProvider` 应返回合同要求的方法：校验预约、读取本地可选人员、选择归属人、验证账号、创建、核对、取消、测试连接和查询录制。没有录制能力时返回空列表并声明 `recording: false`。可选的 `accounts` 和 `syncCohosts` 扩展分别承载账号池导入和平台主持人规则。不要把平台许可规则写进通用业务服务。

完整的可运行实现参考 `apps/server/test/fake-meeting-component.ts`。测试仅增加该实现并注册，就能通过 `/api/platforms` 发现组件、从声明生成配置表单数据、屏蔽密钥并完成通用预约任务。

## 其他能力

通讯录实现 `DirectoryProvider`，返回统一的部门、人员快照；搜索和选择导入由通用页面处理。可选同步写入通过目标组件的 `syncFrom` 和 `createSync` 声明，本版本只注册飞书到腾讯会议方向，不开放远端完整通讯录增删改。

日程实现 `CalendarProvider`，同时提供当前连接可用的人员身份解析。传入已经创建好的会议 URL，不能在日程创建接口里另外创建视频会议。新增平台满足现有接口时，页面和业务服务不需要修改；引入新的能力本身则需要扩展合同。

## 数据与错误

- `providerId` 标识平台，`connectionId` 标识连接，`externalId` 标识连接内的外部资源。人员、部门、账号、账号池按连接隔离；平台扩展信息保存在 `profileJson` / 结果扩展数据中。
- 同一个人可以关联多个连接身份。`open_id` 只能用于同一个飞书应用，跨应用只使用显式同租户的 `user_id`，不根据相同字符串或邮箱静默合并身份。
- 连接 ID 是稳定标识。任务使用记录中的连接，修改默认选择不会重新分配原会议；替换应用或租户凭据前，应先处理该连接的历史任务和资源。
- 创建结果不确定时抛出 `PlatformError` 并设 `ambiguous: true`，由管理员到原平台核对。不要自动重发无法幂等的会议创建请求。
- 保存远端 ID 后再处理日程。查询、取消和录制接口必须区分预约 ID 与会中 ID。
- `apiHosts` 是共享 HTTP 客户端允许访问的 HTTPS 主机；连接配置不能提供任意请求地址。加入会议和录制链接按组件的域名声明校验。
- 模板通用变量与 `{provider.path}` 分开，后者来自当前会议组件的返回结果，禁止原型链路径。平台原始结果可能含密码，保留在服务端，不通过会议详情返回。

## 配置访问

`GET /api/platforms` 要求登录，返回名称、能力、模板变量和配置状态。只有系统管理员能取得 `fields`；`/api/platform-connections` 及连接保存、测试同样限管理员。字段声明同时驱动后端配置校验和前端必填、密钥、数值表单。

新增组件必须声明真实能力；不得把本地失效显示成远端文件删除，也不得用本地完成状态声称已结束远端会议。
