import type {SyncPolicy} from "../../sync-policy.js";
export type SyncScope="organization"|"users";
export type SyncOptions={sourceConnectionId?:string;targetConnectionId?:string;selectedIds?:string[];fetchedAt?:string;overwriteDepartments?:boolean;overwriteUsers?:boolean;preserveExistingPermissions?:boolean;disableMissingUsers?:boolean;skipUnchanged?:boolean};
export interface DirectorySync {
 policy():SyncPolicy; policyView():unknown; updatePolicy(patch:Partial<SyncPolicy>):unknown;
 view(scope:SyncScope):{fetchedAt:string|null;departments:{open_department_id:string}[];people:{open_id:string}[]}; pull(scope:SyncScope,actorId?:number):Promise<unknown>;
 execute(scope:SyncScope|"all",options?:SyncOptions,actorId?:number):Promise<unknown>;
 updatePerson(id:number,input:unknown,actorId:number):Promise<unknown>;
 run(actorId?:number):Promise<unknown>;
}
