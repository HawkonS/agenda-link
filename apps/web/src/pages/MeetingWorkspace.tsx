import { useWorkspaceTabs } from "../lib/workspace-tabs";
import Meetings from "./Meetings";
import Calendar from "./Calendar";
export default function MeetingWorkspace(){
  const {activeTab}=useWorkspaceTabs();
  return activeTab==="records" ? <Calendar capability="meeting"/> : <Meetings/>;
}
