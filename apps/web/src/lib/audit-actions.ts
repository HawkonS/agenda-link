/** 审计事件的中文名称。渲染和筛选共用这一份，避免两处维护后漂移。 */
export const auditActions: Record<string, string> = {
  "auth.login": "登录",
  "auth.feishu": "飞书登录",
  "auth.lock": "登录锁定",
  "meeting.reserve": "提交预约",
  "meeting.provisioned": "会议已创建",
  "meeting.finished": "结束会议",
  "meeting.cancel": "取消会议",
  "meeting.cancelled": "会议已取消",
  "meeting.delete": "删除预约",
  "meeting.retry": "重试预约",
  "meeting.reconcile": "核对会议",
  "calendar.create": "创建日程",
  "calendar.update": "修改日程",
  "calendar.cancel": "取消日程",
  "calendar.retry": "重试日程",
  "calendar.delete": "删除日程",
  "recording.sync": "获取录制",
  "recording.ready": "录制就绪",
  "recording.delete": "删除录制",
  "recording.download": "下载录制",
  "recording.retry": "重试录制",
  "recording.settings": "修改录制设置",
  "recording.storage": "录制存储",
  "sync.queued": "触发同步",
  "sync.feishu.read": "读取飞书通讯录",
  "sync.feishu.read.failed": "读取飞书通讯录失败",
  "sync.tencent.write": "同步到腾讯会议",
  "sync.policy": "修改同步策略",
  "sync.policy.update": "修改同步策略",
  "sync.rule.create": "新增同步规则",
  "sync.rule.update": "修改同步规则",
  "sync.rule.delete": "删除同步规则",
  "sync.person.update": "修改人员",
  "directory.import": "导入通讯录",
  "directory.read": "读取通讯录",
  "user.create": "新增用户",
  "user.update": "修改用户",
  "pool.create": "新增账号池",
  "pool.update": "修改账号池",
  "pool.delete": "删除账号池",
  "account.create": "新增会议账号",
  "account.update": "修改会议账号",
  "account.delete": "删除会议账号",
  "account.verified": "验证会议账号",
  "account.tencent.import": "导入腾讯账号",
  "template.create": "新增日程模板",
  "template.update": "修改日程模板",
  "template.delete": "删除日程模板",
  "platform.connection.update": "修改平台连接",
  "platform.connection.test": "测试平台连接",
  "system.configuration": "修改系统配置",
  "system.backup": "备份数据",
  "system.maintenance": "系统维护",
  "system.initialized": "系统初始化",
  "system.log.delete": "删除日志",
  "system.log.clear": "清空日志",
  "records.annotate": "维护记录",
  "records.delete": "删除记录",
  "records.clear": "清理记录",
  "job.retry": "重试任务",
  "profile.update": "修改个人信息",
};

export function auditLabel(action: string) {
  if (!action) return "—";
  if (auditActions[action]) return auditActions[action];
  if (action.startsWith("recording.")) return "录制 · " + action.slice(10);
  if (action.startsWith("directory.snapshot")) return "通讯录快照";
  if (action.startsWith("sync.snapshot")) return "同步快照";
  return action;
}

/** 筛选下拉按中文名排序，登录失败、配置变更这类事件也能直接筛出来。 */
export const auditFilterOptions = Object.entries(auditActions)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
