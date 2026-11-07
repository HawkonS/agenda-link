import type { ConfigurationService } from "../config/configuration.service.js";
import type { DatabaseService } from "../database.service.js";
import type { PlatformConnectionService } from "../platform-connection.service.js";
import type { PlatformHttp } from "./shared/http.js";
import type { TencentAdapter } from "./shared/tencent/client.js";
import type { FeishuAdapter } from "./shared/feishu/client.js";
import type { DirectoryProvider } from "./directory/contract.js";
import type { MeetingProvider } from "./meeting/contract.js";
import type { CalendarProvider } from "./calendar/contract.js";
export type Capability = "directory" | "meeting" | "calendar";
export type ConfigField = { key: string; label: string; required?: boolean; secret?: boolean; default?: string; type?: "text" | "password" | "number" };
export type ProviderContext = {
  config: ConfigurationService; database: DatabaseService;
  connections: PlatformConnectionService; http: PlatformHttp;
  tencent: TencentAdapter; feishu: FeishuAdapter;
};
export type PlatformComponent = {
  syncFrom?: string[];
  createSync?: (context:ProviderContext)=>import("./directory/sync-contract.js").DirectorySync;
  id: string; providerId: string; name: string; capability: Capability;
  connectionId: string; connectionName: string; fields: ConfigField[];
  /** Built-in components skip the connection settings editor. */
  configurable?: boolean;
  /** Components that must be chosen explicitly never win an implicit selection. */
  autoSelect?: boolean;
  capabilities: Record<string, boolean>;
  apiHosts?: string[];
  meetingDomains?: string[];
  recordingDomains?: string[];
  /** 平台专有的原始返回字段；通用语义字段由模板层统一提供，不在插件里重复定义。 */
  templateVariables?: { key: string; label: string; sample: string }[];
  create: (context: ProviderContext) => DirectoryProvider | MeetingProvider | CalendarProvider;
};
export const COMPONENTS = "AGENDA_LINK_COMPONENTS";
