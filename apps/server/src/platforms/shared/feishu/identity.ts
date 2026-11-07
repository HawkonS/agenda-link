import {and,eq} from "drizzle-orm";
import {platformConnections,platformIdentities,users} from "../../../db/schema.js";
import type {DatabaseService} from "../../../database.service.js";
import type {PlatformConnectionService} from "../../../platform-connection.service.js";
export function feishuIdentity(reader:Pick<DatabaseService["db"],"select">,connections:PlatformConnectionService,targetId:string,userId:number) {
  const target=connections.get(targetId);
  const identities=reader.select().from(platformIdentities).where(and(eq(platformIdentities.userId,userId),eq(platformIdentities.providerId,"feishu"),eq(platformIdentities.kind,"person"))).all();
  for(const identity of identities) {
    const source=connections.get(identity.connectionId);
    const sameApp=!!target.appId && source.appId===target.appId;
    const sameTenant=!!target.tenantKey && source.tenantKey===target.tenantKey;
    if((sameApp || sameTenant) && identity.stableId)return {userId:identity.stableId};
    if(sameApp)return {openId:identity.externalId};
  }
  const user=reader.select().from(users).where(eq(users.id,userId)).get();
  return user?.email ? {email:user.email} : {};
}

/** Login is a separate app. Cross-app stable IDs are usable only in a declared tenant. */
export function loginSharesFeishuTenant(config:import("../../../config/configuration.service.js").ConfigurationService,database:DatabaseService,connectionId:string) {
  const row=database.db.select().from(platformConnections).where(eq(platformConnections.kind,connectionId)).get();
  if(!row?.enabled)return false;
  let source:Record<string,string>;
  try{source=JSON.parse(config.decrypt(row.configJson));}catch{return false;}
  return !!source.appId && source.appId===config.get("feishu.login.app-id") || !!source.tenantKey && source.tenantKey===config.get("feishu.login.tenant-key");
}
