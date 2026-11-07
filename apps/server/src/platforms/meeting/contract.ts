import type { DatabaseService } from "../../database.service.js";
import type { meetings } from "../../db/schema.js";
import type { HostSelectionInput } from "../../meeting-allocation.js";
import type { StoredFile } from "../recording-files.js";
export type MeetingRow = typeof meetings.$inferSelect;
export type MeetingAccount = { accountId: string; secretId?: string | null; secretKey?: string | null };
export type RemoteMeeting = { id: string; code?: string; url: string | null; rejectedHostIds?:string[]; response?: unknown };
export type MeetingHost = { meetingAccountId: number | null; hostAccountId: string; hostAccountName: string; allocationSource: "personal" | "invitee" | "pool" | "configured"; accountPoolId: number | null; accountPoolName: string | null };
export type BookingPerson = { id:number; displayName:string; email:string|null; status:string; externalId:string|null; canHost:boolean };
export interface MeetingProvider {
  listPeople(reader: Pick<DatabaseService["db"], "select">): BookingPerson[];
  accounts?: {preview():Promise<unknown>; import(ids:string[],poolId?:number,actorId?:number):Promise<unknown>};
  syncCohosts?(meeting:MeetingRow,account:MeetingAccount):Promise<void>;
  validate(input: {startAt: string; endAt: string; attendeeIds: number[]; hostMode?: string}): void;
  selectHost(reader: Pick<DatabaseService["db"], "select">, input: HostSelectionInput, userId: number): MeetingHost | undefined;
  people(reader: Pick<DatabaseService["db"], "select">, ids: number[], userId: number): BookingPerson[];
  verifyAccount(account: MeetingAccount): Promise<unknown>;
  createMeeting(p: {subject: string; startAt: string; endAt: string; recordingEnabled: boolean; inviteeIds: string[]; hostIds?: string[]}, account: MeetingAccount): Promise<RemoteMeeting>;
  updateMeeting?(id: string, p: {subject: string; startAt: string; endAt: string; inviteeIds?: string[]; recordingEnabled?: boolean}, account: MeetingAccount): Promise<unknown>;
  cancel(id: string, account: MeetingAccount): Promise<unknown>;
  lookup(id: string, account: MeetingAccount, expected: MeetingRow): Promise<RemoteMeeting>;
  test(): Promise<unknown>;
  recordingFiles(meeting: Pick<MeetingRow, "externalMeetingId" | "startAt" | "endAt"> & {meetingCode?:string|null}, account: MeetingAccount, options?: {requireComplete?: boolean}): Promise<StoredFile[]>;
  deleteRecording?(id: string, meetingId: string, account: MeetingAccount): Promise<unknown>;
}
