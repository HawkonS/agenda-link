import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { PlatformComponent } from "../../contracts.js";
import type { MeetingProvider } from "../contract.js";
import { users } from "../../../db/schema.js";

/** 本系统内置的"无在线会议"：只记录日程，不创建任何外部会议。 */
const peopleOf = (reader: Parameters<MeetingProvider["listPeople"]>[0]) =>
  reader.select().from(users).where(eq(users.status, "active")).all();

export const localMeeting: PlatformComponent = {
  id: "meeting.local",
  providerId: "local",
  name: "无在线会议",
  capability: "meeting",
  connectionId: "local-meeting",
  connectionName: "系统日程",
  fields: [],
  configurable: false,
  autoSelect: false,
  meetingDomains: [],
  templateVariables: [],
  capabilities: {
    create: true,
    query: true,
    cancel: true,
    accountPool: false,
    cohost: false,
    preassignHost: false,
    recording: false,
    deleteRecording: false,
    downloadRecording: false,
    remoteEnd: false,
    online: false,
  },
  create: () =>
    ({
      validate(input) {
        if (input.hostMode === "person")
          throw new BadRequestException("无在线会议无需指定发起账号");
      },
      listPeople: (reader) =>
        peopleOf(reader).map((p) => ({
          id: p.id,
          displayName: p.displayName,
          email: p.email,
          status: p.status,
          externalId: null,
          canHost: false,
        })),
      people: (reader, ids) => {
        const rows = peopleOf(reader);
        return [...new Set(ids)].map((id) => {
          const person = rows.find((p) => p.id === id);
          if (!person)
            throw new BadRequestException("参会人员不存在或已停用");
          return {
            id: person.id,
            displayName: person.displayName,
            email: person.email,
            status: person.status,
            externalId: null,
            canHost: false,
          };
        });
      },
      // 没有外部会议账号，占位归属人只用于满足记录结构。
      selectHost: () => ({
        meetingAccountId: null,
        hostAccountId: "local",
        hostAccountName: "无在线会议",
        allocationSource: "configured",
        accountPoolId: null,
        accountPoolName: null,
      }),
      verifyAccount: async () => ({ ok: true }),
      test: async () => ({ ok: true }),
      createMeeting: async () => ({
        id: `local-${randomUUID()}`,
        url: null,
        response: { local: true },
      }),
      lookup: async (id) => ({ id, url: null }),
      cancel: async () => {},
      recordingFiles: async () => [],
    }) satisfies MeetingProvider,
};
