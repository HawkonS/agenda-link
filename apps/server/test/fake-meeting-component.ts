import type {PlatformComponent} from "../src/platforms/contracts.js";
/** A new platform needs only its implementation and an entry in platforms/index.ts. */
export const fakeMeeting:PlatformComponent={
 id:"meeting.example",providerId:"example",name:"测试平台",capability:"meeting",connectionId:"example-meeting",connectionName:"测试会议连接",
 fields:[{key:"token",label:"测试密钥",required:true,secret:true}],capabilities:{create:true,query:true,cancel:true,accountPool:false,recording:false},meetingDomains:[".example.com"],
 templateVariables:[{key:"ticket",label:"测试票据",sample:"ticket-1"}],
 create:()=>({
  validate(){},listPeople:()=>[],people:()=>[],selectHost:()=>({meetingAccountId:null,hostAccountId:"example-owner",hostAccountName:"测试归属人",allocationSource:"configured",accountPoolId:null,accountPoolName:null}),
  verifyAccount:async()=>({ok:true}),test:async()=>({ok:true}),createMeeting:async()=>({id:"example-1",url:"https://meeting.example.com/join",response:{ticket:"ticket-1"}}),
  lookup:async id=>({id,url:"https://meeting.example.com/join"}),cancel:async()=>{},recordingFiles:async()=>[],
 }),
};
