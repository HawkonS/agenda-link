import {Inject,Injectable} from "@nestjs/common";
import {DatabaseService} from "./database.service.js";
import {PlatformRegistry} from "./platforms/registry.js";
import {syncPolicySchema,type SyncPolicy} from "./sync-policy.js";
import type {SyncOptions,SyncScope} from "./platforms/directory/sync-contract.js";
export type {SyncOptions,SyncScope} from "./platforms/directory/sync-contract.js";
@Injectable()
export class SyncService {
 constructor(@Inject(DatabaseService) private database:DatabaseService,@Inject(PlatformRegistry) private registry:PlatformRegistry){}
 policy(){return syncPolicySchema.parse(JSON.parse(this.database.getState("sync.policy") || "{}"));}
 private implementation(policy=this.policy()){return this.registry.sync(policy.sourceConnectionId,policy.targetConnectionId);}
 policyView(){return this.implementation().policyView();}
 updatePolicy(patch:Partial<SyncPolicy>){return this.implementation({...this.policy(),...patch}).updatePolicy(patch);}
 view(scope:SyncScope){return this.implementation().view(scope);}
 pull(scope:SyncScope,actorId?:number){return this.implementation().pull(scope,actorId);}
 execute(scope:SyncScope|"all",options:SyncOptions={},actorId?:number){return this.implementation({...this.policy(),...options}).execute(scope,options,actorId);}
 updatePerson(id:number,input:unknown,actorId:number){return this.implementation().updatePerson(id,input,actorId);}
 run(actorId?:number){return this.implementation().run(actorId);}
}
