export type EventPayload = {
  subject: string; description?: string; startAt: string; endAt: string;
  location?: string; meetingUrl?: string; meetingProviderName?: string;
  reminders?: number[]; extensions?: Record<string, string>;
  attendees?: { openId?: string; userId?: string; email?: string }[];
};
export function eventDescription(p: Pick<EventPayload, "description" | "extensions">) {
  return [p.description, Object.entries(p.extensions || {}).map(([k,v]) => `${k}: ${v}`).join("\n")].filter(Boolean).join("\n\n");
}
export interface CalendarProvider {
  attendeesForUsers(ids:number[]): NonNullable<EventPayload["attendees"]>;
  readonly calendarId: string;
  test(): Promise<unknown>;
  createEvent(p: EventPayload, key: string, calendarId?: string): Promise<{id: string; calendarId: string}>;
  updateEvent(id: string, calendarId: string, p: EventPayload): Promise<unknown>;
  readEventDescription(id: string, calendarId: string): Promise<string | undefined>;
  invite(id: string, calendarId: string, attendees?: EventPayload["attendees"]): Promise<unknown>;
  replaceAttendees(id: string, calendarId: string, attendees?: EventPayload["attendees"]): Promise<unknown>;
  deleteEvent(id: string, calendarId: string): Promise<unknown>;
}
