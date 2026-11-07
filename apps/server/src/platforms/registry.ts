import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { ConfigurationService } from "../config/configuration.service.js";
import { DatabaseService } from "../database.service.js";
import { PlatformConnectionService } from "../platform-connection.service.js";
import { PlatformHttp } from "./shared/http.js";
import { FeishuAdapter } from "./shared/feishu/client.js";
import { TencentAdapter } from "./shared/tencent/client.js";
import { COMPONENTS, type Capability, type PlatformComponent, type ProviderContext } from "./contracts.js";
import type { DirectoryProvider } from "./directory/contract.js";
import type { MeetingProvider } from "./meeting/contract.js";
import type { CalendarProvider } from "./calendar/contract.js";
import { meetingJoinUrl } from "./meeting-url.js";
import { recordingUrl } from "./recording-files.js";
@Injectable()
export class PlatformRegistry {
  private context: ProviderContext;
  private instances = new Map<string, unknown>();
  constructor(
    @Inject(COMPONENTS) readonly components: PlatformComponent[],
    @Inject(ConfigurationService) readonly config: ConfigurationService,
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(PlatformConnectionService) readonly connections: PlatformConnectionService,
    @Inject(PlatformHttp) http: PlatformHttp,
    @Inject(FeishuAdapter) feishu: FeishuAdapter,
    @Inject(TencentAdapter) tencent: TencentAdapter,
  ) {this.context={config,database,connections,http,feishu,tencent};}
  descriptor(capability: Capability, connectionId: string) {
    const d=this.components.find(c=>c.capability===capability && c.connectionId===connectionId);
    if(!d)throw new BadRequestException("未知或未注册的平台组件");
    return d;
  }
  list(admin=false) {
    return this.components.map(({create,createSync,fields,...c})=>({...c,configured:this.connections.isConfigured(c.connectionId),...(admin?{fields}: {})}));
  }
  select(capability: Capability, connectionId?: string, providerId?: string) {
    if(!connectionId) {
      // Built-ins such as "no online meeting" are only usable when chosen explicitly.
      const available=this.components.filter(c=>c.capability===capability && c.autoSelect!==false && this.connections.isConfigured(c.connectionId));
      if(available.length!==1)throw new BadRequestException(available.length?"请选择平台连接":"请先在系统设置中配置平台连接");
      connectionId=available[0]!.connectionId;
    }
    const d=this.descriptor(capability,connectionId);
    if(providerId && providerId!==d.providerId)throw new BadRequestException("平台与连接不匹配");
    this.connections.require(connectionId);
    return d;
  }
  private get<T>(capability: Capability, connectionId: string): T {
    const d=this.descriptor(capability,connectionId);
    this.connections.require(connectionId);
    if(!this.instances.has(d.id))this.instances.set(d.id,d.create(this.context));
    return this.instances.get(d.id) as T;
  }
  directory(id: string){return this.get<DirectoryProvider>("directory",id);}
  meeting(id: string){return this.get<MeetingProvider>("meeting",id);}
  calendar(id: string){return this.get<CalendarProvider>("calendar",id);}
  joinUrl(value:unknown,id:string){return meetingJoinUrl(value,this.descriptor("meeting",id).meetingDomains || []);}
  recordingUrl(value:string,id:string){return recordingUrl(value,this.descriptor("meeting",id).recordingDomains || []);}
  sync(source:string,target:string) {
    const d=this.descriptor("directory",target);
    this.descriptor("directory",source);
    if(!d.createSync || !d.syncFrom?.includes(source))throw new BadRequestException("该通讯录同步方向尚未接入");
    const key="sync:"+source+":"+target;
    if(!this.instances.has(key))this.instances.set(key,d.createSync(this.context));
    return this.instances.get(key) as import("./directory/sync-contract.js").DirectorySync;
  }
  async test(connectionId: string) {
    const components=this.components.filter(c=>c.connectionId===connectionId);
    if(!components.length)throw new BadRequestException("未知平台连接");
    const results=[];
    for(const c of components)results.push(await this.get<{test():Promise<unknown>}>(c.capability,connectionId).test());
    return {ok:true,results};
  }
}
