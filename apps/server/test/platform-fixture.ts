import {PlatformRegistry} from "../src/platforms/registry.js";
import {platformComponents} from "../src/platforms/index.js";
import {PlatformHttp} from "../src/platforms/shared/http.js";
import {FeishuAdapter} from "../src/platforms/shared/feishu/client.js";
import {TencentAdapter} from "../src/platforms/shared/tencent/client.js";
import type {ConfigurationService} from "../src/config/configuration.service.js";
import type {DatabaseService} from "../src/database.service.js";
import type {PlatformConnectionService} from "../src/platform-connection.service.js";
export function registryFixture(config:ConfigurationService,database:DatabaseService,connections:PlatformConnectionService,tencent?:TencentAdapter,feishu?:FeishuAdapter) {
 const http=new PlatformHttp(platformComponents);
 return new PlatformRegistry(platformComponents,config,database,connections,http,feishu || new FeishuAdapter(config,http,connections),tencent || new TencentAdapter(config,http,connections));
}
import {and,eq} from "drizzle-orm";
import {platformIdentities,users} from "../src/db/schema.js";
export function scopedPerson(database:DatabaseService,connectionId:string,externalId:string) {
 const identity=database.db.select().from(platformIdentities).where(and(eq(platformIdentities.connectionId,connectionId),eq(platformIdentities.kind,"person"),eq(platformIdentities.externalId,externalId))).get();
 if(!identity?.userId)throw new Error("Missing fixture identity: "+connectionId+":"+externalId);
 const user=database.db.select().from(users).where(eq(users.id,identity.userId)).get()!;
 const target=database.db.select().from(platformIdentities).where(and(eq(platformIdentities.connectionId,"tencent-meeting"),eq(platformIdentities.kind,"person"),eq(platformIdentities.userId,user.id))).get();
 return {...user,tencentUserId:target?.externalId,meetingUserType:JSON.parse(target?.profileJson || "{}").providerData?.advanced?"advanced":"ordinary"};
}
