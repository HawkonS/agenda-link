import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ConfigurationService } from "./config/configuration.service.js";
import { DatabaseService } from "./database.service.js";
import { platformConnections } from "./db/schema.js";
import { platformComponents } from "./platforms/index.js";
import { COMPONENTS, type PlatformComponent } from "./platforms/contracts.js";
export type ConnectionKind = string;
export type PlatformConnection = Record<string,string|number|boolean|undefined>;
@Injectable()
export class PlatformConnectionService {
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
    @Inject(DatabaseService) private database: DatabaseService,
    @Optional() @Inject(COMPONENTS) private components: PlatformComponent[] = platformComponents,
  ) {}
  definition(kind:string) {
    const d=this.components.find(c=>c.connectionId===kind);
    if(!d)throw new BadRequestException("未知平台连接");
    return {...d,fields:[...new Map(this.components.filter(c=>c.connectionId===kind).flatMap(c=>c.fields).map(f=>[f.key,f])).values()]};
  }
  get(kind:string):PlatformConnection {
    this.definition(kind);
    const row=this.database.db.select().from(platformConnections).where(eq(platformConnections.kind,kind)).get();
    if(!row?.enabled)return {};
    try {return JSON.parse(this.config.decrypt(row.configJson));}catch {return {};}
  }
  isConfigured(kind:string) {
    const d=this.definition(kind), value=this.get(kind);
    return d.fields.filter(f=>f.required).every(f=>String(value[f.key]??"").trim());
  }
  require(kind:string,extra:string[]=[]) {
    const d=this.definition(kind),value=this.get(kind);
    const missing=[...d.fields.filter(f=>f.required).map(f=>f.key),...extra].filter(k=>!String(value[k]??"").trim());
    if(missing.length)throw new BadRequestException(`请先在系统设置中配置${d.connectionName}，缺少：${missing.join("、")}`);
    return value;
  }
  masked(kind:string) {
    const d=this.definition(kind),v=this.get(kind);
    return Object.fromEntries(d.fields.map(f=>[f.key,f.secret ? v[f.key] ? "********" : "" : String(v[f.key]??f.default??"")]));
  }
  update(kind:string,input:PlatformConnection) {
    const d=this.definition(kind);
    if(d.configurable===false)throw new BadRequestException("该连接由系统内置，不可修改");
    const next={...this.get(kind)};
    for(const f of d.fields) {
      const v=input[f.key];
      if(v===undefined || v==="********")continue;
      if(!["string","number","boolean"].includes(typeof v) || /[\r\n\0]/.test(String(v)))throw new BadRequestException("连接配置格式无效");
      if(f.type==="number" && String(v).trim() && !/^\d+$/.test(String(v)))throw new BadRequestException(f.label+"必须是整数");
      next[f.key]=typeof v==="string" ? v.trim() : v;
    }
    for(const f of d.fields){
      if(next[f.key]===undefined && f.default!==undefined)next[f.key]=f.default;
      if(f.required && !String(next[f.key] ?? "").trim())throw new BadRequestException(`请填写${f.label}`);
    }
    const configJson=this.config.encrypt(JSON.stringify(next));
    this.database.db.insert(platformConnections).values({kind,configJson,enabled:true}).onConflictDoUpdate({target:platformConnections.kind,set:{configJson,enabled:true,lastError:null,updatedAt:new Date().toISOString()}}).run();
    return this.masked(kind);
  }
  all() {
    return [...new Map(this.components.filter(c=>c.configurable!==false).map(c=>[c.connectionId,c])).values()].map(c=>({kind:c.connectionId,name:c.connectionName,fields:this.definition(c.connectionId).fields,configured:this.isConfigured(c.connectionId),values:this.masked(c.connectionId)}));
  }
}
