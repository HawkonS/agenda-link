import { sql } from "drizzle-orm";
import { meetings } from "./db/schema.js";
export type HostSelectionInput = { startAt:string; endAt:string; attendeeIds:number[]; accountPoolId?:number; hostMode?:"auto"|"person"|"pool"; hostUserId?:number };
// Failed cancellations keep reserving the host until remote cancellation is confirmed.
export const occupiedMeeting = () => sql`(${meetings.status} IN ('scheduled','provisioning','unknown','cancelling','cancel_failed') OR (${meetings.status} = 'failed' AND ${meetings.externalMeetingId} IS NOT NULL))`;
